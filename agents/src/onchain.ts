// EVM on-chain reads for the worker + auditor (Monad, via viem). Every read here is
// DETERMINISTIC and re-runnable, so the auditor can independently re-derive the same
// ground truth the worker claims. Analog of the Sui `onchain.ts`.
import { createPublicClient, http, getAddress, formatUnits, encodeFunctionData } from "viem";
import { env, deployment } from "./config.js";

const client = createPublicClient({ transport: http(env.rpc) });

const ZERO = "0x0000000000000000000000000000000000000000";

const erc20MetaAbi = [
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

// 4-byte selectors we detect by scanning a contract's deployed bytecode. This is the
// same lightweight heuristic on both sides (worker + auditor), so verdicts are exact.
const SELECTORS = {
  mint: ["40c10f19", "a0712d68"], // mint(address,uint256) / mint(uint256)
  pause: ["8456cb59", "3f4ba83a", "5c975abb"], // pause/unpause/paused (Pausable)
  blacklist: ["f9f92be4", "0ecb93c0", "e47d6060"], // blacklist / addBlackList / isBlackListed
} as const;

/** Fetch deployed bytecode as a lowercase hex string (no 0x). */
export async function getCode(address: string): Promise<string> {
  const code = await client.getBytecode({ address: getAddress(address) });
  return (code ?? "0x").slice(2).toLowerCase();
}

const hasAny = (code: string, sels: readonly string[]) => sels.some((s) => code.includes(s));

/** ERC-20 safety flags, re-derivable from bytecode. */
export async function erc20Flags(address: string): Promise<{ freezable: boolean; publiclyMintable: boolean }> {
  const code = await getCode(address);
  const freezable = hasAny(code, SELECTORS.pause) || hasAny(code, SELECTORS.blacklist);
  const publiclyMintable = hasAny(code, SELECTORS.mint);
  return { freezable, publiclyMintable };
}

/** Verified on-chain token facts (used by token/erc20 tasks). */
export async function tokenFacts(address: string): Promise<{
  address: string;
  symbol: string;
  decimals: number;
  supply: string;
  freezable: boolean;
  publiclyMintable: boolean;
}> {
  const a = getAddress(address);
  const [symbol, decimals, supply] = await Promise.all([
    client.readContract({ address: a, abi: erc20MetaAbi, functionName: "symbol" }).catch(() => "?"),
    client.readContract({ address: a, abi: erc20MetaAbi, functionName: "decimals" }).catch(() => 18),
    client.readContract({ address: a, abi: erc20MetaAbi, functionName: "totalSupply" }).catch(() => 0n),
  ]);
  const flags = await erc20Flags(address);
  return { address: a, symbol: String(symbol), decimals: Number(decimals), supply: supply.toString(), ...flags };
}

/** Bytecode audit: flag dangerous low-level capabilities actually present as opcodes.
 *  Walks the runtime bytecode as a real opcode stream — skips PUSH immediates (so data
 *  bytes aren't mistaken for opcodes) and strips the Solidity CBOR metadata trailer — so
 *  only genuinely reachable SELFDESTRUCT/DELEGATECALL/CALLCODE are flagged. Deterministic,
 *  so worker + auditor agree exactly. */
export async function contractRisks(address: string): Promise<{ risky: string[] }> {
  const hex = await getCode(address);
  if (hex.length === 0) return { risky: ["NO_CODE"] }; // EOA or undeployed
  const bytes = (hex.match(/.{2}/g) ?? []).map((b) => parseInt(b, 16));

  // strip Solidity metadata: the last 2 bytes encode the CBOR length that precedes them.
  let end = bytes.length;
  if (bytes.length >= 2) {
    const metaLen = bytes[bytes.length - 2] * 256 + bytes[bytes.length - 1];
    if (metaLen + 2 <= bytes.length) end = bytes.length - 2 - metaLen;
  }

  const found = new Set<string>();
  for (let i = 0; i < end; ) {
    const op = bytes[i];
    if (op >= 0x60 && op <= 0x7f) { i += 1 + (op - 0x5f); continue; } // PUSH1..32 → skip N data bytes
    if (op === 0xff) found.add("SELFDESTRUCT");
    else if (op === 0xf4) found.add("DELEGATECALL");
    else if (op === 0xf2) found.add("CALLCODE");
    i += 1;
  }
  return { risky: [...found].sort() };
}

// ---------------- Proxy & Upgradeability Inspector ----------------
// EIP-1967 standard slots (keccak256(id) - 1).
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";

/** Reads raw storage slots to reveal upgradeability: EIP-1167 minimal-proxy clones and
 *  EIP-1967 proxies (implementation + admin). Something no LLM can do; re-derivable. */
export async function proxyInfo(address: string): Promise<{
  isProxy: boolean;
  kind: string;
  implementation: string | null;
  admin: string | null;
}> {
  const code = await getCode(address);
  // EIP-1167 minimal proxy: 363d3d373d3d3d363d73 <20-byte impl> 5af43d82803e903d91602b57fd5bf3
  const clone = code.match(/^363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3/);
  if (clone) return { isProxy: true, kind: "EIP-1167 minimal proxy (clone)", implementation: getAddress("0x" + clone[1]), admin: null };

  const readAddr = async (slot: `0x${string}`) => {
    const v = (await client.getStorageAt({ address: getAddress(address), slot })) ?? "0x";
    const a = "0x" + v.slice(-40).padStart(40, "0");
    return a.toLowerCase() === ZERO ? null : getAddress(a);
  };
  const impl = await readAddr(IMPL_SLOT);
  const admin = await readAddr(ADMIN_SLOT);
  const beacon = await readAddr(BEACON_SLOT);
  if (impl) return { isProxy: true, kind: "EIP-1967 transparent/UUPS proxy", implementation: impl, admin };
  if (beacon) return { isProxy: true, kind: "EIP-1967 beacon proxy", implementation: beacon, admin };
  return { isProxy: false, kind: "not a proxy (direct contract)", implementation: null, admin: null };
}

// ---------------- Function-Selector / ABI Recoverer ----------------
/** Recovers the function selectors a contract implements by parsing its bytecode
 *  dispatcher (PUSH4 <sel> {EQ|GT|LT}). Reconstructs the callable surface with no source
 *  and no verification — pure static analysis, re-derivable by the auditor. */
export async function functionSelectors(address: string): Promise<{ selectors: string[]; count: number }> {
  const hex = await getCode(address);
  const bytes = (hex.match(/.{2}/g) ?? []).map((b) => parseInt(b, 16));
  let end = bytes.length;
  if (bytes.length >= 2) {
    const metaLen = bytes[bytes.length - 2] * 256 + bytes[bytes.length - 1];
    if (metaLen + 2 <= bytes.length) end = bytes.length - 2 - metaLen;
  }
  const sels = new Set<string>();
  for (let i = 0; i < end; ) {
    const op = bytes[i];
    if (op >= 0x60 && op <= 0x7f) {
      const n = op - 0x5f;
      if (op === 0x63) {
        // PUSH4 immediately compared (EQ 0x14 / GT 0x11 / LT 0x10) → a dispatcher selector
        const nextOp = bytes[i + 5];
        if (nextOp === 0x14 || nextOp === 0x11 || nextOp === 0x10) {
          const sel = bytes.slice(i + 1, i + 5).map((b) => b.toString(16).padStart(2, "0")).join("");
          if (sel !== "00000000" && sel !== "ffffffff") sels.add("0x" + sel);
        }
      }
      i += 1 + n;
      continue;
    }
    i += 1;
  }
  const selectors = [...sels].sort();
  return { selectors, count: selectors.length };
}

// ---------------- Honeypot / Sell-Tax Simulator ----------------
const transferAbi = [{ type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] }] as const;

/** Simulates a "sell": a funded non-owner holder transfers 1 unit to a sink via eth_call.
 *  If it reverts, sells are blocked → honeypot. Requires EVM simulation (impossible for an
 *  LLM); the auditor re-simulates the identical call. */
export async function honeypotCheck(token: string): Promise<{ honeypot: boolean; reason: string }> {
  const holder = (deployment.targets?.holder as string) || ZERO;
  const SINK = "0x000000000000000000000000000000000000dEaD";
  const data = encodeFunctionData({ abi: transferAbi, functionName: "transfer", args: [SINK as `0x${string}`, 1n] });
  try {
    await client.call({ account: getAddress(holder), to: getAddress(token), data });
    return { honeypot: false, reason: "a normal holder can transfer (sell) the token" };
  } catch {
    return { honeypot: true, reason: "a transfer from a normal holder reverts — selling is blocked" };
  }
}

/** Wallet snapshot: native balance + balances across a set of known token addresses. */
export async function walletSnapshot(
  address: string,
  tokens: string[] = [],
): Promise<{ address: string; native: string; coinTypes: number; coins: { token: string; balance: string }[] }> {
  const a = getAddress(address);
  const native = await client.getBalance({ address: a });
  const coins: { token: string; balance: string }[] = [];
  for (const t of tokens) {
    try {
      const bal = (await client.readContract({
        address: getAddress(t),
        abi: erc20MetaAbi,
        functionName: "balanceOf",
        args: [a],
      })) as bigint;
      if (bal > 0n) coins.push({ token: getAddress(t), balance: bal.toString() });
    } catch {
      /* not a token / no balance */
    }
  }
  return { address: a, native: formatUnits(native, 18), coinTypes: coins.length, coins };
}

export { client as publicClient };
