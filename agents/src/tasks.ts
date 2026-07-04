// Worker + auditor logic for genuine EVM task-classes on Monad. The agent does work you
// can't trivially do (reads + interprets real on-chain bytecode/state, searches routes);
// the auditor independently re-derives the objective ground truth (re-reads the chain /
// recomputes) so PASS/FAIL is provable — except "general", which a stronger model judges.
//
//   erc20-safety  : can this token be frozen (pausable/blacklist) or freely minted?
//   contract-audit: which dangerous low-level ops (SELFDESTRUCT/DELEGATECALL) a contract has
//   wallet-report : reads a wallet's balances on-chain and writes a report (figures certified)
//   route         : pick the swap route with the best fee-adjusted output across pools
//   defi-health   : compute a lending position's health factor & liquidation buffer
//   general       : open-ended Q&A, graded by an independent auditor model
import { hasLLM } from "./config.js";
import { workerComplete } from "./llm.js";
import { erc20Flags, tokenFacts, contractRisks, walletSnapshot } from "./onchain.js";

export type TaskClass =
  | "erc20-safety"
  | "contract-audit"
  | "wallet-report"
  | "route"
  | "defi-health"
  | "general";

const JUDGE = { provider: "groq", model: "llama-3.3-70b-versatile" }; // independent auditor model
export interface ModelCfg { provider: string; model: string }
export interface WorkerResult { result: any; trace: string; mode: string }
export interface Verdict { pass: boolean; reason: string; recomputed: any }

export const TASK_META: Record<TaskClass, { label: string; agent: string; blurb: string; does: string; how: string; inputHint: string; examples: string[] }> = {
  "erc20-safety": {
    label: "ERC-20 Safety Check",
    agent: "TokenSafetyChecker",
    blurb: "Checks whether an ERC-20 can be frozen or freely minted.",
    does: "Reads a token contract's deployed bytecode on Monad and reports two risks: can the issuer freeze/blacklist your balance (Pausable / blacklist), and can new supply be minted (a public mint selector).",
    how: "The auditor independently re-reads the same bytecode on-chain and recomputes the freeze/mint flags; the agent passes only if they match exactly.",
    inputHint: "A Monad token address — paste 0x…",
    examples: [],
  },
  "contract-audit": {
    label: "Contract Bytecode Audit",
    agent: "BytecodeAuditor",
    blurb: "Flags dangerous low-level ops in a deployed contract.",
    does: "Scans a deployed contract's bytecode for dangerous capabilities — SELFDESTRUCT (can be wiped), DELEGATECALL/CALLCODE (upgradeable / proxy foot-guns) — the attack surface you'd otherwise disassemble by hand.",
    how: "The auditor re-fetches the same bytecode and re-derives the risky-op list; the agent passes only if its list matches exactly.",
    inputHint: "A deployed Monad contract address — paste 0x…",
    examples: [],
  },
  "wallet-report": {
    label: "Wallet / Portfolio Report",
    agent: "WalletReporter",
    blurb: "Reads a wallet on-chain and writes a holdings report.",
    does: "Given a Monad address, reads its native balance and known-token balances on-chain and produces a readable portfolio summary — the kind of report you'd otherwise compile from an explorer.",
    how: "Provable: the auditor re-reads the same wallet on-chain and confirms every balance and count in the report matches real chain state. The AI only writes the prose; the figures are certified.",
    inputHint: "A Monad wallet address — paste 0x…",
    examples: [],
  },
  route: {
    label: "Swap Route Optimizer",
    agent: "RouteOptimizer",
    blurb: "Finds the best-output route across candidate AMM pools.",
    does: "Given several AMM pools, computes the fee-adjusted output for each and returns the pool that gives the most tokens out — the routing you'd otherwise compute by hand across every venue.",
    how: "The auditor recomputes every pool's constant-product output and checks the agent picked the true best route at the correct amount.",
    inputHint: "Pools JSON (tokenIn, amountIn, pools[]) — click an example to start",
    examples: [],
  },
  "defi-health": {
    label: "DeFi Position Health",
    agent: "DeFiHealthChecker",
    blurb: "Computes a lending position's health factor & liquidation buffer.",
    does: "Given a lending position (collateral, debt, liquidation threshold), computes the health factor and how far the collateral can fall before liquidation.",
    how: "Provable: the auditor recomputes the health factor and liquidation buffer from the same inputs and checks the agent's numbers.",
    inputHint: "Position JSON {collateralUsd, debtUsd, liquidationThreshold} — click an example",
    examples: [],
  },
  general: {
    label: "General Analyst",
    agent: "GeneralBot",
    blurb: "Open-ended Q&A / analysis, answer graded by an independent auditor.",
    does: "A general-purpose AI analyst — ask anything. Useful when there's no fixed format, just a question that needs a good answer.",
    how: "No on-chain ground truth here, so a separate, stronger auditor model independently judges whether the answer is correct. Best-effort verification (a model's judgment), not a proof.",
    inputHint: "Ask anything — e.g. “Explain how a constant-product AMM sets price.”",
    examples: ["What is the capital of Australia?", "Explain how a constant-product AMM prices a swap.", "What are 3 risks of granting an unlimited token approval?"],
  },
};

const ADDR = /0x[0-9a-fA-F]{40}/;

/** Fast, deterministic extraction. Returns the structured input or null if not found. */
function parseDeterministic(taskClass: TaskClass, text: string): string | null {
  if (taskClass === "erc20-safety" || taskClass === "contract-audit" || taskClass === "wallet-report") {
    return text.match(ADDR)?.[0] ?? null;
  }
  if (taskClass === "general") return text.length ? text : null;
  if (taskClass === "defi-health") {
    try {
      const p = JSON.parse(text);
      if (["collateralUsd", "debtUsd", "liquidationThreshold"].every((k) => typeof p[k] === "number")) return JSON.stringify(p);
    } catch { /* not json */ }
    return null;
  }
  try {
    const p = JSON.parse(text);
    if (Array.isArray(p.pools) && p.pools.length) return JSON.stringify(p);
  } catch { /* not json */ }
  return null;
}

const PARSE_HELP: Record<TaskClass, string> = {
  "erc20-safety": "Paste an ERC-20 token address (0x…) on Monad to check.",
  "contract-audit": "Paste a deployed contract address (0x…) to audit.",
  "wallet-report": "Paste a Monad wallet address (0x…) to report on.",
  route: "Route needs pools JSON — click an example below to start, then edit the numbers.",
  "defi-health": "Position needs JSON {collateralUsd, debtUsd, liquidationThreshold} — click an example.",
  general: "Type a question or prompt for the analyst.",
};

/** Strict deterministic normalize used by the run itself (no guessing). */
export function normalizeStrict(taskClass: TaskClass, raw: string): string {
  const det = parseDeterministic(taskClass, (raw || "").trim());
  if (!det) throw new Error(PARSE_HELP[taskClass]);
  return det;
}

/** Resolve free text to a target. exact = run now; none = couldn't understand it. */
export async function resolveInput(
  taskClass: TaskClass,
  raw: string,
): Promise<{ status: "exact" | "suggest" | "none"; input?: string; label?: string; help?: string }> {
  const det = parseDeterministic(taskClass, (raw || "").trim());
  if (det) return { status: "exact", input: det };
  return { status: "none", help: PARSE_HELP[taskClass] };
}

function defiHealthGroundTruth(i: any) {
  const c = Number(i.collateralUsd), d = Number(i.debtUsd), lt = Number(i.liquidationThreshold);
  const hf = d > 0 ? (c * lt) / d : Infinity;
  const drawdown = isFinite(hf) && hf > 0 ? Math.max(0, 1 - 1 / hf) * 100 : 100;
  return { healthFactor: isFinite(hf) ? Math.round(hf * 1000) / 1000 : 9999, maxDrawdownPct: Math.round(drawdown * 100) / 100 };
}

function routeGroundTruth(i: any) {
  const out = (i.pools || []).map((p: any) => {
    const inWithFee = i.amountIn * (10000 - p.feeBps) / 10000;
    return { dex: p.dex, amountOut: (p.reserveOut * inWithFee) / (p.reserveIn + inWithFee) };
  });
  const best = out.reduce((a: any, b: any) => (b.amountOut > a.amountOut ? b : a), out[0]);
  return { bestDex: best.dex, amountOut: Math.round(best.amountOut * 1e6) / 1e6, all: out };
}

// ---------------- worker ----------------
export async function runWorker(taskClass: TaskClass, input: string, cfg?: ModelCfg): Promise<WorkerResult> {
  // A deliberately-flawed agent (deterministic): ignores AMM fees / liquidation threshold,
  // so the auditor catches it — demonstrates the insurance refund + bond slash reproducibly.
  if (cfg?.provider === "naive") return { ...(await runWorkerNaive(taskClass, input)), mode: "naive-rule" };
  const useLLM = cfg ? cfg.provider === "groq" || cfg.provider === "anthropic" : false;
  if (useLLM) {
    try { return { ...(await runWorkerLLM(taskClass, input, cfg)), mode: cfg!.model }; } catch { /* fall back */ }
  }
  return { ...(await runWorkerDeterministic(taskClass, input)), mode: "rule-engine" };
}

async function runWorkerLLM(taskClass: TaskClass, input: string, cfg?: ModelCfg): Promise<Omit<WorkerResult, "mode">> {
  if (taskClass === "erc20-safety") {
    const facts = await tokenFacts(input.trim());
    const { json, trace } = await workerComplete(
      'You are TokenSafetyChecker. Given verified on-chain token facts, report freeze/mint risk. Reply ONLY JSON {"freezable":boolean,"publiclyMintable":boolean}.',
      JSON.stringify(facts), cfg,
    );
    return { result: { freezable: !!json?.freezable, publiclyMintable: !!json?.publiclyMintable }, trace };
  }
  if (taskClass === "contract-audit") {
    const truth = await contractRisks(input.trim());
    const { json, trace } = await workerComplete(
      'You are BytecodeAuditor. From this list of detected dangerous opcodes, echo the ones that are genuinely dangerous. Reply ONLY JSON {"risky":["SELFDESTRUCT","DELEGATECALL",...]}.',
      JSON.stringify(truth), cfg,
    );
    return { result: { risky: [...new Set((json?.risky || []).map(String))].sort() }, trace };
  }
  if (taskClass === "wallet-report") {
    const snap = await walletSnapshot(input.trim());
    const { json } = await workerComplete(
      'You are WalletReporter. Write a concise 1-2 sentence portfolio summary of this wallet snapshot. Reply ONLY JSON {"summary": string}.',
      JSON.stringify(snap), cfg,
    );
    return { result: { ...snap, summary: json?.summary || "" }, trace: "on-chain wallet read + LLM summary" };
  }
  if (taskClass === "general") {
    const { json, trace } = await workerComplete(
      'You are a precise AI analyst. Answer the user\'s question accurately and concisely. Reply ONLY JSON {"answer": string}.',
      input, cfg,
    );
    return { result: json, trace };
  }
  if (taskClass === "defi-health") {
    const { json, trace } = await workerComplete(
      'You are DeFiHealthChecker. healthFactor = collateralUsd*liquidationThreshold/debtUsd. maxDrawdownPct = (1 - 1/healthFactor)*100. Reply ONLY JSON {"healthFactor":number,"maxDrawdownPct":number}.',
      input, cfg,
    );
    return { result: json, trace };
  }
  const { json, trace } = await workerComplete(
    'You are RouteOptimizer. For each pool: amountInWithFee = amountIn*(10000-feeBps)/10000; amountOut = reserveOut*amountInWithFee/(reserveIn+amountInWithFee). Return the pool (dex) with the highest amountOut. Reply ONLY JSON {"bestDex":string,"amountOut":number}.',
    input, cfg,
  );
  return { result: json, trace };
}

async function runWorkerNaive(taskClass: TaskClass, input: string): Promise<Omit<WorkerResult, "mode">> {
  if (taskClass === "route") {
    const i = JSON.parse(input);
    const naive = (i.pools || []).reduce((a: any, b: any) => (b.reserveOut > a.reserveOut ? b : a), i.pools[0]);
    const out = (naive.reserveOut * i.amountIn) / (naive.reserveIn + i.amountIn); // ignores fee → wrong
    return { result: { bestDex: naive.dex, amountOut: Math.round(out * 1e6) / 1e6 }, trace: "naive: picks biggest reserve, ignores fees" };
  }
  if (taskClass === "defi-health") {
    const i = JSON.parse(input);
    const hf = Number(i.collateralUsd) / Number(i.debtUsd); // ignores liquidation threshold → wrong
    return { result: { healthFactor: Math.round(hf * 1000) / 1000, maxDrawdownPct: 0 }, trace: "naive: ignores liquidation threshold" };
  }
  return runWorkerDeterministic(taskClass, input); // no naive variant → behaves correctly
}

async function runWorkerDeterministic(taskClass: TaskClass, input: string): Promise<Omit<WorkerResult, "mode">> {
  if (taskClass === "erc20-safety") return { result: await erc20Flags(input.trim()), trace: "rule engine: bytecode selector scan" };
  if (taskClass === "contract-audit") return { result: await contractRisks(input.trim()), trace: "rule engine: opcode scan" };
  if (taskClass === "wallet-report") {
    const snap = await walletSnapshot(input.trim());
    return { result: { ...snap, summary: `${snap.native} native, ${snap.coinTypes} token position(s).` }, trace: "rule engine: wallet read" };
  }
  if (taskClass === "general") return { result: { answer: "(this agent needs an LLM worker configured)" }, trace: "no llm" };
  if (taskClass === "defi-health") return { result: defiHealthGroundTruth(JSON.parse(input)), trace: "rule engine: health factor" };
  const gt = routeGroundTruth(JSON.parse(input));
  return { result: { bestDex: gt.bestDex, amountOut: gt.amountOut }, trace: "rule engine: route search" };
}

// ---------------- auditor (objective, re-derived from chain / recomputed) ----------------
export async function runAuditor(taskClass: TaskClass, input: string, worker: any): Promise<Verdict> {
  if (taskClass === "general") {
    const { json } = await workerComplete(
      'You are a strict independent auditor. Decide if the Answer correctly and accurately answers the Question. Penalize factual or arithmetic errors. Reply ONLY JSON {"correct":boolean,"reason":string}.',
      `Question:\n${input}\n\nAnswer:\n${worker?.answer ?? ""}`,
      JUDGE,
    );
    return { pass: !!json?.correct, reason: json?.reason || "auditor judgment", recomputed: { judge: JUDGE.model } };
  }
  if (taskClass === "erc20-safety") {
    const truth = await erc20Flags(input.trim());
    const ok = !!worker?.freezable === truth.freezable && !!worker?.publiclyMintable === truth.publiclyMintable;
    return ok
      ? { pass: true, reason: `Correct: freezable=${truth.freezable}, publiclyMintable=${truth.publiclyMintable}.`, recomputed: truth }
      : { pass: false, reason: `Wrong flags. On-chain truth ${JSON.stringify(truth)}, agent ${JSON.stringify({ freezable: !!worker?.freezable, publiclyMintable: !!worker?.publiclyMintable })}.`, recomputed: truth };
  }
  if (taskClass === "contract-audit") {
    const truth = (await contractRisks(input.trim())).risky;
    const claimed = [...new Set((worker?.risky || []).map(String))].sort() as string[];
    const ok = truth.length === claimed.length && truth.every((t, i) => t === claimed[i]);
    return ok
      ? { pass: true, reason: `Correctly surfaced ${truth.length} risky op(s): [${truth.join(", ") || "none"}].`, recomputed: { risky: truth } }
      : { pass: false, reason: `Risk list wrong. On-chain truth: [${truth.join(", ") || "none"}]. Agent: [${claimed.join(", ") || "none"}].`, recomputed: { risky: truth } };
  }
  if (taskClass === "wallet-report") {
    const truth = await walletSnapshot(input.trim());
    const key = (c: any[]) => c.map((x) => `${x.token}=${x.balance}`).sort().join("|");
    const ok = worker?.coinTypes === truth.coinTypes && key(worker?.coins || []) === key(truth.coins) && String(worker?.native) === String(truth.native);
    return ok
      ? { pass: true, reason: `Verified on-chain: ${truth.native} native, ${truth.coinTypes} token position(s) — all balances match.`, recomputed: truth }
      : { pass: false, reason: `Report doesn't match chain. On-chain: ${truth.native} native / ${truth.coinTypes} positions.`, recomputed: truth };
  }
  if (taskClass === "defi-health") {
    const gt = defiHealthGroundTruth(JSON.parse(input));
    const near = (a: number, b: number) => b === 0 ? a === 0 : Math.abs(a - b) / Math.abs(b) < 0.01;
    const ok = near(Number(worker?.healthFactor), gt.healthFactor) && near(Number(worker?.maxDrawdownPct), gt.maxDrawdownPct);
    return ok
      ? { pass: true, reason: `Correct: health factor ${gt.healthFactor}, liquidation buffer ${gt.maxDrawdownPct}%.`, recomputed: gt }
      : { pass: false, reason: `Wrong math. Truth: HF ${gt.healthFactor}, buffer ${gt.maxDrawdownPct}%; agent: HF ${worker?.healthFactor}, buffer ${worker?.maxDrawdownPct}%.`, recomputed: gt };
  }
  const gt = routeGroundTruth(JSON.parse(input));
  const ok = worker?.bestDex === gt.bestDex && Math.abs(Number(worker?.amountOut) - gt.amountOut) / gt.amountOut < 0.01;
  return ok
    ? { pass: true, reason: `Best route correct: ${gt.bestDex} → ${gt.amountOut}.`, recomputed: gt }
    : { pass: false, reason: `Wrong route. Best is ${gt.bestDex} (${gt.amountOut}); agent said ${worker?.bestDex} (${worker?.amountOut}).`, recomputed: gt };
}

// ---------------- demo samples ----------------
export const SAMPLES: Record<TaskClass, { clean: string; tricky: string }> = {
  "erc20-safety": { clean: "", tricky: "" }, // filled with your deployed MockUSDC / test tokens
  "contract-audit": { clean: "", tricky: "" },
  "wallet-report": { clean: "", tricky: "" },
  route: {
    clean: JSON.stringify({ tokenIn: "MON", tokenOut: "USDC", amountIn: 1000, pools: [
      { dex: "BigPool", reserveIn: 1000000, reserveOut: 510000, feeBps: 300 },
      { dex: "LeanPool", reserveIn: 1000000, reserveOut: 500000, feeBps: 5 },
    ] }, null, 2),
    tricky: JSON.stringify({ tokenIn: "MON", tokenOut: "USDC", amountIn: 1000, pools: [
      { dex: "AlphaDex", reserveIn: 1000000, reserveOut: 520000, feeBps: 30 },
      { dex: "BetaDex", reserveIn: 1000000, reserveOut: 480000, feeBps: 30 },
    ] }, null, 2),
  },
  "defi-health": {
    clean: JSON.stringify({ collateralUsd: 1000, debtUsd: 400, liquidationThreshold: 0.8 }, null, 2),
    tricky: JSON.stringify({ collateralUsd: 1500, debtUsd: 1100, liquidationThreshold: 0.85 }, null, 2),
  },
  general: {
    clean: "What is the capital of Australia?",
    tricky: "What are three risks of granting an unlimited token approval to a smart contract?",
  },
};
