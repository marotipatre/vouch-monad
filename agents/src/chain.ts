// On-chain write layer for Monad (viem). Analog of the Sui `chain.ts`, with all DeepBook
// / prediction-market code removed. Reliability is now purely PERFORMANCE-based.
//
// Two signers: the deployer/backend wallet (custodial demo hires + faucet) and the
// auditor wallet (the only key allowed to call Resolver.resolve).
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  parseEventLogs,
  defineChain,
  formatUnits,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { env, deployment as d, llmProvider, llmModel, hasLLM } from "./config.js";
import { usdcAbi, registryAbi, insuranceAbi, resolverAbi } from "./abi.js";
import { setConfig } from "./models.js";

// MOCK mode: no chain, no keys, no gas — an in-memory ledger so the whole app runs on
// localhost for testing. Auto-enabled when MOCK=1 or no deployment manifest is present.
export const MOCK = process.env.MOCK === "1" || !d.registry;

export const monad = defineChain({
  id: env.chainId,
  name: "Monad Testnet",
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [env.rpc] } },
});

const USDC = parseAbi(usdcAbi as unknown as string[]);
const REGISTRY = parseAbi(registryAbi as unknown as string[]);
const INSURANCE = parseAbi(insuranceAbi as unknown as string[]);
const RESOLVER = parseAbi(resolverAbi as unknown as string[]);

// env.deployerKey / env.auditorKey are already normalized (0x + 64 hex) or "" by config.
const deployer = env.deployerKey ? privateKeyToAccount(env.deployerKey as `0x${string}`) : null;
const auditor = env.auditorKey ? privateKeyToAccount(env.auditorKey as `0x${string}`) : null;

export const ME = deployer?.address ?? "0x0000000000000000000000000000000000000000";
export const AUDITOR = auditor?.address ?? "0x0000000000000000000000000000000000000000";
export const TREASURY = (d.treasury as `0x${string}`) || ME;

export const publicClient = createPublicClient({ chain: monad, transport: http(env.rpc) });
const wallet = deployer ? createWalletClient({ account: deployer, chain: monad, transport: http(env.rpc) }) : null;
const auditorWallet = auditor ? createWalletClient({ account: auditor, chain: monad, transport: http(env.rpc) }) : null;

const addr = {
  usdc: d.usdc as `0x${string}`,
  registry: d.registry as `0x${string}`,
  insurance: d.insurance as `0x${string}`,
  resolver: d.resolver as `0x${string}`,
};

const USDC_UNIT = 1_000_000; // 6 decimals
const toBase = (n: number) => BigInt(Math.round(n * USDC_UNIT));
const fromBase = (b: bigint) => Number(b) / USDC_UNIT;
const PREMIUM_LOAD = 1.2; // insurer's loading factor over expected loss

// ---- in-memory ledger for MOCK mode ----
interface MemAgent { id: number; name: string; taskClass: string; owner: string; reliabilityBps: number; bondUsdc: number; jobs: number; fails: number }
const memAgents = new Map<number, MemAgent>();
const memPolicies = new Map<number, { agentId: number; coverage: number; escrow: number }>();
let memPolicyId = 0;
let memSeeded = false;
function seedMock() {
  if (memSeeded) return;
  memSeeded = true;
  const seed = [
    { name: "RouteOptimizer", taskClass: "route", bond: 3, provider: "deterministic", model: "rule-engine", fee: 3, rel: 9000 },
    { name: "NaiveRouter", taskClass: "route", bond: 3, provider: "naive", model: "naive-rule", fee: 3, rel: 4500 },
    { name: "DeFiHealthChecker", taskClass: "defi-health", bond: 3, provider: "deterministic", model: "rule-engine", fee: 2, rel: 9000 },
    ...(hasLLM ? [{ name: "GeneralBot", taskClass: "general", bond: 2, provider: llmProvider, model: llmModel, fee: 2, rel: 9000 }] : []),
  ];
  seed.forEach((s, i) => {
    const id = i + 1;
    memAgents.set(id, { id, name: s.name, taskClass: s.taskClass, owner: ME, reliabilityBps: s.rel, bondUsdc: s.bond, jobs: 0, fails: 0 });
    setConfig(String(id), { provider: s.provider, model: s.model, feeUsdc: s.fee });
  });
}

// ---- in-memory revenue + activity (like the Sui backend) ----
let revenue = { feesUsdc: 0, premiumsUsdc: 0, payoutsUsdc: 0, slashedUsdc: 0 };
const activityLog: { ts: number; kind: string; label: string; digest: string }[] = [];
const logActivity = (kind: string, label: string, digest: string) => {
  activityLog.unshift({ ts: Date.now(), kind, label, digest });
};
export const getActivity = () => activityLog.slice(0, 50);
export const getRevenue = () => ({
  ...revenue,
  netInsuranceUsdc: revenue.premiumsUsdc - revenue.payoutsUsdc + revenue.slashedUsdc,
  totalUsdc: revenue.feesUsdc + revenue.premiumsUsdc,
  treasury: TREASURY,
});
export function recordHireRevenue(protocolFeeUsdc: number, premiumUsdc: number) {
  revenue.feesUsdc += protocolFeeUsdc;
  revenue.premiumsUsdc += premiumUsdc;
}

// ---- reliability (performance-based, replaces the DeepBook mid) ----
// Laplace-smoothed success rate with a prior mean of 90% (weight ~5 pseudo-jobs), so a
// brand-new agent starts near 9000 bps and moves toward its true rate as jobs accrue.
export function performanceReliability(jobsBefore: number, failsBefore: number, pass: boolean): number {
  const total = jobsBefore + 1;
  const fails = failsBefore + (pass ? 0 : 1);
  const successes = total - fails;
  const PRIOR_WEIGHT = 5, PRIOR_MEAN = 0.9;
  const rate = (successes + PRIOR_WEIGHT * PRIOR_MEAN) / (total + PRIOR_WEIGHT);
  return Math.max(0, Math.min(10000, Math.round(rate * 10000)));
}

// ---- reads ----
export interface AgentView {
  id: string;
  taskClass: string;
  name: string;
  owner: string;
  reliabilityBps: number;
  bondUsdc: number;
  jobs: number;
  fails: number;
}

async function readAgent(id: number): Promise<AgentView | null> {
  const a: any = await publicClient.readContract({ address: addr.registry, abi: REGISTRY, functionName: "getAgent", args: [BigInt(id)] });
  if (!a?.exists) return null;
  return {
    id: String(id),
    taskClass: a.taskClass,
    name: a.name,
    owner: a.owner,
    reliabilityBps: Number(a.reliabilityBps),
    bondUsdc: fromBase(a.bond),
    jobs: Number(a.jobsTotal),
    fails: Number(a.jobsFailed),
  };
}

const memToView = (a: MemAgent): AgentView => ({ id: String(a.id), taskClass: a.taskClass, name: a.name, owner: a.owner, reliabilityBps: a.reliabilityBps, bondUsdc: a.bondUsdc, jobs: a.jobs, fails: a.fails });

export async function readAgentById(id: string): Promise<AgentView | null> {
  if (MOCK) { seedMock(); const a = memAgents.get(Number(id)); return a ? memToView(a) : null; }
  return readAgent(Number(id));
}

export async function listAgents(): Promise<AgentView[]> {
  if (MOCK) {
    seedMock();
    return [...memAgents.values()].map(memToView).sort((a, b) => b.reliabilityBps - a.reliabilityBps || b.jobs - a.jobs || a.fails - b.fails);
  }
  const count = Number(await publicClient.readContract({ address: addr.registry, abi: REGISTRY, functionName: "agentCount" }));
  const out: AgentView[] = [];
  for (let i = 1; i <= count; i++) {
    const a = await readAgent(i);
    if (a && a.taskClass !== "*") out.push(a); // hide the auditor from the leaderboard
  }
  out.sort((a, b) => b.reliabilityBps - a.reliabilityBps || b.jobs - a.jobs || a.fails - b.fails);
  return out;
}
export const leaderboard = listAgents;

// ---- writes ----
async function send(hash: `0x${string}`) {
  return publicClient.waitForTransactionReceipt({ hash });
}

/** Register a worker agent (backend-custodial: the deployer stakes the bond). */
export async function createAgent(name: string, taskClass: string, bondUsdc: number) {
  if (MOCK) {
    seedMock();
    const id = memAgents.size + 1;
    memAgents.set(id, { id, name, taskClass, owner: ME, reliabilityBps: 9000, bondUsdc, jobs: 0, fails: 0 });
    const digest = `0xmock${id.toString(16).padStart(4, "0")}`;
    logActivity("register", `agent ${name} (${taskClass})`, digest);
    return { agentId: String(id), digest };
  }
  if (!wallet || !deployer) throw new Error("no DEPLOYER_PRIVATE_KEY configured");
  const bond = toBase(bondUsdc);
  await send(await wallet.writeContract({ address: addr.usdc, abi: USDC, functionName: "approve", args: [addr.registry, bond] }));
  const hash = await wallet.writeContract({ address: addr.registry, abi: REGISTRY, functionName: "registerAgent", args: [name, taskClass, bond] });
  const receipt = await send(hash);
  const ev = parseEventLogs({ abi: REGISTRY, logs: receipt.logs, eventName: "AgentRegistered" })[0] as any;
  const agentId = ev ? String(ev.args.agentId) : "";
  logActivity("register", `agent ${name} (${taskClass})`, hash);
  return { agentId, digest: hash };
}

/** Custodial demo hire: the backend wallet pays. Returns the created policy + splits. */
export async function hire(agentId: string, withGuarantee: boolean, feeUsdc: number) {
  if (MOCK) {
    seedMock();
    const agent = memAgents.get(Number(agentId));
    if (!agent) throw new Error("agent not found");
    const protocolFee = +(feeUsdc * 0.1).toFixed(4);
    const agentNet = +(feeUsdc - protocolFee).toFixed(4);
    const coverage = withGuarantee ? feeUsdc : 0;
    const premium = withGuarantee ? +(feeUsdc * (1 - agent.reliabilityBps / 10000) * PREMIUM_LOAD).toFixed(4) : 0;
    const policyId = String(++memPolicyId);
    memPolicies.set(memPolicyId, { agentId: Number(agentId), coverage, escrow: agentNet });
    const digest = `0xmockhire${policyId.padStart(4, "0")}`;
    recordHireRevenue(protocolFee, premium);
    logActivity("hire", `hired agent ${agentId}${withGuarantee ? " (insured)" : ""}`, digest);
    return { digest, policyId, agentNetUsdc: agentNet, premiumUsdc: premium, coverageUsdc: coverage };
  }
  if (!wallet) throw new Error("no DEPLOYER_PRIVATE_KEY configured");
  const agent = await readAgent(Number(agentId));
  if (!agent) throw new Error("agent not found");

  const feeBase = toBase(feeUsdc);
  const protocolFee = feeBase / 10n;
  const agentFee = feeBase - protocolFee;
  const coverage = withGuarantee ? feeBase : 0n;
  const premium = withGuarantee ? toBase(feeUsdc * (1 - agent.reliabilityBps / 10000) * PREMIUM_LOAD) : 0n;
  const total = protocolFee + premium + agentFee;

  await send(await wallet.writeContract({ address: addr.usdc, abi: USDC, functionName: "approve", args: [addr.insurance, total] }));
  const hash = await wallet.writeContract({
    address: addr.insurance, abi: INSURANCE, functionName: "hire",
    args: [BigInt(agentId), agent.taskClass, protocolFee, premium, coverage, agentFee],
  });
  const receipt = await send(hash);
  const ev = parseEventLogs({ abi: INSURANCE, logs: receipt.logs, eventName: "Hired" })[0] as any;
  const policyId = ev ? String(ev.args.policyId) : "";
  recordHireRevenue(fromBase(protocolFee), fromBase(premium));
  logActivity("hire", `hired agent ${agentId}${withGuarantee ? " (insured)" : ""}`, hash);
  return {
    digest: hash,
    policyId,
    agentNetUsdc: fromBase(agentFee),
    premiumUsdc: fromBase(premium),
    coverageUsdc: fromBase(coverage),
  };
}

/** Auditor-signed settlement. PASS releases the escrowed fee; FAIL refunds + pays out. */
export async function resolve(
  agentId: string,
  policyId: string,
  pass: boolean,
  evidenceUri: string,
  newReliabilityBps: number,
) {
  if (MOCK) {
    const agent = memAgents.get(Number(agentId));
    const pol = memPolicies.get(Number(policyId));
    let payoutUsdc = 0, slashedUsdc = 0;
    if (agent) {
      agent.jobs += 1;
      if (!pass) {
        agent.fails += 1;
        if (pol) { payoutUsdc = pol.coverage; slashedUsdc = Math.min(pol.coverage, agent.bondUsdc); agent.bondUsdc -= slashedUsdc; }
      }
      agent.reliabilityBps = newReliabilityBps;
    }
    revenue.payoutsUsdc += payoutUsdc;
    revenue.slashedUsdc += slashedUsdc;
    const digest = `0xmockresolve${policyId.padStart(4, "0")}`;
    logActivity("resolve", `${pass ? "PASS" : "FAIL"} policy ${policyId}`, digest);
    return { digest, payoutUsdc, slashedUsdc, newReliabilityBps };
  }
  if (!auditorWallet) throw new Error("no AUDITOR_PRIVATE_KEY configured");
  const hash = await auditorWallet.writeContract({
    address: addr.resolver, abi: RESOLVER, functionName: "resolve",
    args: [BigInt(policyId), BigInt(agentId), pass, evidenceUri, BigInt(newReliabilityBps)],
  });
  const receipt = await send(hash);
  const ev = parseEventLogs({ abi: RESOLVER, logs: receipt.logs, eventName: "Resolved" })[0] as any;
  const payoutUsdc = ev ? fromBase(ev.args.payout) : 0;
  const slashedUsdc = ev ? fromBase(ev.args.slashed) : 0;
  revenue.payoutsUsdc += payoutUsdc;
  revenue.slashedUsdc += slashedUsdc;
  logActivity("resolve", `${pass ? "PASS" : "FAIL"} policy ${policyId}`, hash);
  return { digest: hash, payoutUsdc, slashedUsdc, newReliabilityBps };
}

/** Faucet: mint mock USDC to a connected wallet so the user can pay for hires. */
export async function fundWallet(address: string, usdc = 100) {
  if (MOCK) {
    const digest = `0xmockfaucet`;
    logActivity("faucet", `funded ${address.slice(0, 8)}… ${usdc} mUSDC`, digest);
    return { digest, usdc };
  }
  if (!wallet) throw new Error("no DEPLOYER_PRIVATE_KEY configured");
  const hash = await wallet.writeContract({
    address: addr.usdc, abi: USDC, functionName: "faucet", args: [address as `0x${string}`, toBase(usdc)],
  });
  await send(hash);
  logActivity("faucet", `funded ${address.slice(0, 8)}… ${usdc} mUSDC`, hash);
  return { digest: hash, usdc };
}
