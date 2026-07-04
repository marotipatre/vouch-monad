// EVM on-chain reads for the worker + auditor (Monad, via viem). Every read here is
// DETERMINISTIC and re-runnable, so the auditor can independently re-derive the same
// ground truth the worker claims. Analog of the Sui `onchain.ts`.
import { createPublicClient, http, getAddress, formatUnits } from "viem";
import { env } from "./config.js";

const client = createPublicClient({ transport: http(env.rpc) });

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
