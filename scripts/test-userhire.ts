// End-to-end test of the USER-SIGNED hire path (what the "Hire" button does): approve
// USDC → Insurance.hire from a wallet → parse policyId → POST /api/run with the
// client-hire payload → backend runs work → audit → resolve. Uses the deployer key as a
// stand-in "user" (it holds mock USDC). Proves the exact flow the frontend triggers.
//
// Usage:  pnpm tsx scripts/test-userhire.ts [agentId] [fee]
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, createWalletClient, http, defineChain, parseAbi, parseEventLogs, formatUnits } from "viem";
import { config as dotenv } from "dotenv";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
dotenv({ path: join(ROOT, ".env") });
const d = JSON.parse(readFileSync(join(ROOT, "deployments", "monadTestnet.json"), "utf8"));
const API = process.env.API || "http://localhost:8787";
const key = (k: string) => (k.startsWith("0x") ? k : `0x${k}`) as `0x${string}`;

const USDC = parseAbi(["function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)", "function faucet(address,uint256)"]);
const INS = parseAbi([
  "function hire(uint256 agentId,string taskClass,uint256 protocolFee,uint256 premium,uint256 coverage,uint256 agentFee) returns (uint256)",
  "event Hired(uint256 indexed policyId,address indexed holder,uint256 indexed agentId,uint256 protocolFee,uint256 premium,uint256 coverage,uint256 escrow)",
]);

async function main() {
  const agentId = process.argv[2] || "5";
  const chain = defineChain({ id: d.chainId, name: "Monad Testnet", nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [d.rpc] } } });
  const pub = createPublicClient({ chain, transport: http(d.rpc) });
  const user = privateKeyToAccount(key(process.env.DEPLOYER_PRIVATE_KEY!)); // stand-in "user"
  const wallet = createWalletClient({ account: user, chain, transport: http(d.rpc) });

  // find the agent (taskClass, reliability, fee) via the API — same data the UI uses
  const agents: any[] = await (await fetch(`${API}/api/agents`)).json();
  const a = agents.find((x) => x.id === agentId);
  if (!a) throw new Error(`agent ${agentId} not found`);
  const fee = Number(process.argv[3] || a.config?.feeUsdc || 0.3);

  const feeBase = BigInt(Math.round(fee * 1e6));
  const protocolFee = feeBase / 10n;
  const agentFee = feeBase - protocolFee;
  const coverage = feeBase; // insured
  const premium = BigInt(Math.round(fee * 1e6 * (1 - a.reliabilityBps / 10000) * 1.2));
  const total = protocolFee + premium + agentFee;

  console.log(`user ${user.address}`);
  console.log(`hiring #${agentId} ${a.name} (${a.taskClass}) · fee $${fee} · total $${formatUnits(total, 6)} mUSDC`);

  // ensure the user holds enough mock USDC (faucet is public)
  const bal = (await pub.readContract({ address: d.usdc, abi: USDC, functionName: "balanceOf", args: [user.address] })) as bigint;
  if (bal < total) {
    console.log("  fauceting 100 mUSDC…");
    await pub.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: d.usdc, abi: USDC, functionName: "faucet", args: [user.address, 100_000_000n] }) });
  }

  // 1) approve + hire (the two txs the wallet signs)
  console.log("  approve…");
  await pub.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: d.usdc, abi: USDC, functionName: "approve", args: [d.insurance, total] }) });
  console.log("  insurance.hire…");
  const hireHash = await wallet.writeContract({ address: d.insurance, abi: INS, functionName: "hire", args: [BigInt(agentId), a.taskClass, protocolFee, premium, coverage, agentFee] });
  const receipt = await pub.waitForTransactionReceipt({ hash: hireHash });
  const ev = parseEventLogs({ abi: INS, logs: receipt.logs, eventName: "Hired" })[0] as any;
  const policyId = String(ev.args.policyId);
  console.log(`  ✓ policy #${policyId} created · hire tx ${hireHash.slice(0, 18)}…`);

  // 2) hand the client-hire payload to the backend (exactly like the UI)
  const sample = await (await fetch(`${API}/api/samples/${a.taskClass}`)).json();
  const input = sample.clean || sample.tricky || "0x1256867c29ac4eae2d1de09d00999babd8d2b7a2";
  const body = {
    agentId, input, withGuarantee: true,
    hire: { policyId, agentNetUsdc: Number(agentFee) / 1e6, protocolFeeUsdc: Number(protocolFee) / 1e6, premiumUsdc: Number(premium) / 1e6, coverageUsdc: Number(coverage) / 1e6, userAddress: user.address, digest: hireHash },
  };
  console.log("  POST /api/run (backend finishes work → audit → resolve)…");
  const res = await fetch(`${API}/api/run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const text = await res.text();
  const done = text.split("\n\n").map((l) => l.replace(/^data: /, "")).filter(Boolean).map((s) => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);
  const d2 = done.find((o: any) => o.type === "done");
  const errEv = done.find((o: any) => o.type === "error");
  if (errEv) throw new Error("run error: " + errEv.error);
  const r = d2.result;
  console.log(`\nRESULT: ${r.verdict.pass ? "PASS ✓" : "FAIL ✗"} — ${r.verdict.reason}`);
  console.log(`  paid by      : ${r.hire.paidBy}`);
  console.log(`  settlement tx: ${r.resolve.tx}`);
  console.log(`  payout/slash : $${r.resolve.payoutUsdc} / $${r.resolve.slashedUsdc}`);
  console.log(`  evidence     : ${r.evidence.uri}`);
}

main().catch((e) => { console.error("FAILED:", String(e)); process.exit(1); });
