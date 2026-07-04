// Top up an agent's staked bond (owner-only). Useful to restore a slashed bond so the
// FAIL/slash path is visible in a demo.  Usage: pnpm tsx scripts/topup-bond.ts <agentId> <usdc>
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, createWalletClient, http, defineChain, parseAbi } from "viem";
import { config as dotenv } from "dotenv";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
dotenv({ path: join(ROOT, ".env") });
const d = JSON.parse(readFileSync(join(ROOT, "deployments", "monadTestnet.json"), "utf8"));
const key = (k: string) => (k.startsWith("0x") ? k : `0x${k}`) as `0x${string}`;

const USDC = parseAbi(["function approve(address,uint256) returns (bool)", "function faucet(address,uint256)"]);
const REG = parseAbi(["function topUpBond(uint256 agentId,uint256 more)", "function bondOf(uint256) view returns (uint256)"]);

async function main() {
  const agentId = BigInt(process.argv[2] || "0");
  const usdc = Number(process.argv[3] || "3");
  if (!agentId) throw new Error("usage: topup-bond.ts <agentId> <usdc>");
  const amount = BigInt(Math.round(usdc * 1e6));

  const chain = defineChain({ id: d.chainId, name: "Monad Testnet", nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [d.rpc] } } });
  const pub = createPublicClient({ chain, transport: http(d.rpc) });
  const owner = privateKeyToAccount(key(process.env.DEPLOYER_PRIVATE_KEY!));
  const wallet = createWalletClient({ account: owner, chain, transport: http(d.rpc) });

  await pub.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: d.usdc, abi: USDC, functionName: "faucet", args: [owner.address, amount] }) });
  await pub.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: d.usdc, abi: USDC, functionName: "approve", args: [d.registry, amount] }) });
  await pub.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: d.registry, abi: REG, functionName: "topUpBond", args: [agentId, amount] }) });

  const bond = (await pub.readContract({ address: d.registry, abi: REG, functionName: "bondOf", args: [agentId] })) as bigint;
  console.log(`agent #${agentId} bond now $${Number(bond) / 1e6}`);
}

main().catch((e) => { console.error(String(e)); process.exit(1); });
