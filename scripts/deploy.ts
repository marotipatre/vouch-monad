// Deploy + wire the Vouch contracts on Monad testnet, then write
// deployments/monadTestnet.json (consumed by the agent service + web).
//
// Prereqs:
//   1) `cd contracts && forge build`   (produces out/<Contract>.sol/<Contract>.json)
//   2) set DEPLOYER_PRIVATE_KEY, AUDITOR_PRIVATE_KEY, MONAD_RPC in ../.env
//   3) the deployer needs testnet MON for gas
//
// Run:  pnpm deploy
import { config as dotenv } from "dotenv";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createPublicClient, createWalletClient, http, defineChain, parseEventLogs, parseEther, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
dotenv({ path: join(ROOT, ".env") });

const RPC = process.env.MONAD_RPC || "https://testnet-rpc.monad.xyz";
const CHAIN_ID = Number(process.env.MONAD_CHAIN_ID || 10143);
const EXPLORER = process.env.EXPLORER_URL || "https://testnet.monadexplorer.com";
const key = (k?: string) => { if (!k) throw new Error("missing key"); return (k.startsWith("0x") ? k : `0x${k}`) as `0x${string}`; };

const deployer = privateKeyToAccount(key(process.env.DEPLOYER_PRIVATE_KEY));
const auditor = privateKeyToAccount(key(process.env.AUDITOR_PRIVATE_KEY));
const TREASURY = (process.env.TREASURY_ADDRESS || deployer.address) as `0x${string}`;

const chain = defineChain({ id: CHAIN_ID, name: "Monad Testnet", nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC) });
const wallet = createWalletClient({ account: deployer, chain, transport: http(RPC) });

const artifact = (name: string) => {
  const j = JSON.parse(readFileSync(join(ROOT, "contracts", "out", `${name}.sol`, `${name}.json`), "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object as `0x${string}` };
};

async function deploy(name: string, args: any[] = []): Promise<`0x${string}`> {
  const { abi, bytecode } = artifact(name);
  const hash = await wallet.deployContract({ abi, bytecode, args });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) throw new Error(`${name}: no contract address`);
  console.log(`  ${name.padEnd(14)} ${receipt.contractAddress}`);
  return receipt.contractAddress;
}

const ONE = 1_000_000n; // 1 USDC (6 dp)

async function main() {
  console.log(`Deploying Vouch to Monad (chain ${CHAIN_ID}) as ${deployer.address}`);
  console.log(`  auditor operator: ${auditor.address}`);

  const bal = await pub.getBalance({ address: deployer.address });
  console.log(`  deployer balance: ${formatEther(bal)} MON`);
  if (bal === 0n) throw new Error("deployer has 0 MON — fund it with testnet MON first");

  // Fund the auditor with a little MON for gas (it signs every resolve).
  const auditorBal = await pub.getBalance({ address: auditor.address });
  if (auditorBal < parseEther("0.1")) {
    console.log(`  funding auditor with 0.2 MON for gas…`);
    await pub.waitForTransactionReceipt({ hash: await wallet.sendTransaction({ to: auditor.address, value: parseEther("0.2") }) });
  }

  const usdc = await deploy("MockUSDC");
  const registry = await deploy("AgentRegistry", [usdc]);
  const insurance = await deploy("Insurance", [usdc, TREASURY]);

  const { abi: usdcAbi } = artifact("MockUSDC");
  const { abi: registryAbi } = artifact("AgentRegistry");
  const { abi: insuranceAbi } = artifact("Insurance");

  const write = async (address: `0x${string}`, abi: any, functionName: string, args: any[]) => {
    const hash = await wallet.writeContract({ address, abi, functionName, args });
    return pub.waitForTransactionReceipt({ hash });
  };

  // fund the deployer with mock USDC, register the auditor (10 USDC bond)
  console.log("Registering auditor…");
  await write(usdc, usdcAbi, "faucet", [deployer.address, 1000n * ONE]);
  await write(usdc, usdcAbi, "approve", [registry, 1000n * ONE]);
  const rc = await write(registry, registryAbi, "registerAuditor", ["Vouch Auditor", auditor.address, 10n * ONE]);
  const ev = parseEventLogs({ abi: registryAbi, logs: rc.logs, eventName: "AgentRegistered" })[0] as any;
  const auditorAgentId = Number(ev.args.agentId);
  console.log(`  auditor agentId = ${auditorAgentId}`);

  const resolver = await deploy("Resolver", [registry, insurance, BigInt(auditorAgentId)]);

  console.log("Wiring resolver + seeding reserve…");
  await write(registry, registryAbi, "setResolver", [resolver]);
  await write(insurance, insuranceAbi, "setResolver", [resolver]);
  await write(usdc, usdcAbi, "approve", [insurance, 500n * ONE]);
  await write(insurance, insuranceAbi, "deposit", [500n * ONE]); // seed reserve

  const out = { chainId: CHAIN_ID, rpc: RPC, explorer: EXPLORER, usdc, registry, insurance, resolver, auditorAgentId, treasury: TREASURY };
  writeFileSync(join(ROOT, "deployments", "monadTestnet.json"), JSON.stringify(out, null, 2) + "\n");
  console.log("Wrote deployments/monadTestnet.json ✓");
}

main().catch((e) => { console.error(e); process.exit(1); });
