// Seed a few demo worker agents on-chain (each staking a bond) and wire their off-chain
// model config. Run after `pnpm deploy`.  Run:  pnpm seed
import { config as dotenv } from "dotenv";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createPublicClient, createWalletClient, http, defineChain, parseAbi, parseEventLogs } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
dotenv({ path: join(ROOT, ".env") });

const d = JSON.parse(readFileSync(join(ROOT, "deployments", "monadTestnet.json"), "utf8"));
const key = (k?: string) => (k!.startsWith("0x") ? k! : `0x${k}`) as `0x${string}`;
const deployer = privateKeyToAccount(key(process.env.DEPLOYER_PRIVATE_KEY));
const chain = defineChain({ id: d.chainId, name: "Monad Testnet", nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [d.rpc] } } });
const pub = createPublicClient({ chain, transport: http(d.rpc) });
const wallet = createWalletClient({ account: deployer, chain, transport: http(d.rpc) });

const USDC = parseAbi(["function faucet(address,uint256)", "function approve(address,uint256) returns (bool)"]);
const REGISTRY = parseAbi([
  "function registerAgent(string,string,uint256) returns (uint256)",
  "event AgentRegistered(uint256 indexed agentId,address indexed owner,string taskClass,bool isAuditor,uint256 bond,uint256 reliabilityBps)",
]);
const ONE = 1_000_000n;

const AGENTS = [
  { name: "BytecodeAuditor", taskClass: "contract-audit", bond: 5, provider: "deterministic", model: "opcode-walker", feeUsdc: 0.5 },
  { name: "ProxyInspector", taskClass: "proxy-audit", bond: 5, provider: "deterministic", model: "storage-reader", feeUsdc: 0.6 },
  { name: "SelectorRecoverer", taskClass: "selector-scan", bond: 3, provider: "deterministic", model: "dispatcher-parser", feeUsdc: 0.4 },
  { name: "HoneypotSimulator", taskClass: "honeypot", bond: 5, provider: "deterministic", model: "evm-simulator", feeUsdc: 0.7 },
  // deliberately-flawed agent for the insurance/slash demo — rubber-stamps tokens as safe
  { name: "LazyHoneypotChecker", taskClass: "honeypot", bond: 3, provider: "naive", model: "naive-rule", feeUsdc: 0.3 },
];

async function main() {
  const cfgPath = join(ROOT, "agents", "agent-config.json");
  const cfg: Record<string, any> = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, "utf8")) : {};

  const total = BigInt(AGENTS.reduce((s, a) => s + a.bond, 0)) * ONE;
  await pub.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: d.usdc, abi: USDC, functionName: "faucet", args: [deployer.address, total] }) });
  await pub.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: d.usdc, abi: USDC, functionName: "approve", args: [d.registry, total] }) });

  for (const a of AGENTS) {
    const hash = await wallet.writeContract({ address: d.registry, abi: REGISTRY, functionName: "registerAgent", args: [a.name, a.taskClass, BigInt(a.bond) * ONE] });
    const rc = await pub.waitForTransactionReceipt({ hash });
    const ev = parseEventLogs({ abi: REGISTRY, logs: rc.logs, eventName: "AgentRegistered" })[0] as any;
    const id = String(ev.args.agentId);
    cfg[id] = { provider: a.provider, model: a.model, feeUsdc: a.feeUsdc };
    console.log(`  #${id} ${a.name} (${a.taskClass}) bond ${a.bond} USDC`);
  }

  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
  console.log("Seeded agents + wrote agents/agent-config.json ✓");
}

main().catch((e) => { console.error(e); process.exit(1); });
