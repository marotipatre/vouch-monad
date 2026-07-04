// Worker + auditor logic for 4 HIGH-TECHNICAL, on-chain-only task-classes on Monad.
// Each does something a normal AI fundamentally cannot: read/parse/simulate live chain
// state. The worker computes it; the auditor INDEPENDENTLY re-derives the identical result
// from chain state → PASS only on an exact match. No LLM, no guessing — pure provable work.
//
//   contract-audit : dangerous opcodes (SELFDESTRUCT/DELEGATECALL) via an opcode walk
//   proxy-audit    : EIP-1967/1167 upgradeability from raw storage slots (who can rug you)
//   selector-scan  : recover a contract's function selectors from its bytecode dispatcher
//   honeypot       : eth_call-simulate a sell to detect tokens you can buy but not sell
import { contractRisks, proxyInfo, functionSelectors, honeypotCheck } from "./onchain.js";

export type TaskClass = "contract-audit" | "proxy-audit" | "selector-scan" | "honeypot";

export interface ModelCfg { provider: string; model: string }
export interface WorkerResult { result: any; trace: string; mode: string }
export interface Verdict { pass: boolean; reason: string; recomputed: any }

export const TASK_META: Record<TaskClass, { label: string; agent: string; blurb: string; does: string; how: string; inputHint: string; examples: string[] }> = {
  "contract-audit": {
    label: "Contract Bytecode Audit",
    agent: "BytecodeAuditor",
    blurb: "Flags dangerous low-level ops in a deployed contract.",
    does: "Fetches a contract's live deployed bytecode and walks the opcode stream to flag dangerous capabilities — SELFDESTRUCT (can be wiped) and DELEGATECALL/CALLCODE (upgradeable / proxy foot-guns) — the attack surface you'd otherwise disassemble by hand.",
    how: "The auditor re-fetches the same bytecode and re-derives the risky-op list; PASS only if it matches exactly.",
    inputHint: "A deployed Monad contract address — paste 0x…",
    examples: [],
  },
  "proxy-audit": {
    label: "Proxy & Upgradeability Inspector",
    agent: "ProxyInspector",
    blurb: "Reveals if a contract is an upgradeable proxy — and who controls it.",
    does: "Reads the raw EIP-1967 storage slots (and detects EIP-1167 minimal-proxy clones) to reveal whether a contract is an upgradeable proxy, its implementation address, and the admin who can swap the logic out from under you — the #1 hidden rug vector.",
    how: "The auditor re-reads the same storage slots on-chain and re-derives implementation + admin; PASS only if they match. Reading raw storage is impossible for a chatbot.",
    inputHint: "A deployed Monad contract / proxy address — paste 0x…",
    examples: [],
  },
  "selector-scan": {
    label: "Function-Selector Recoverer",
    agent: "SelectorRecoverer",
    blurb: "Recovers a contract's callable functions from bytecode — no source needed.",
    does: "Parses the contract's bytecode dispatcher (the PUSH4-selector jump table) to recover every function selector it actually implements — reconstructing the callable ABI of an unverified contract with no source code.",
    how: "The auditor re-parses the same bytecode and re-derives the selector set; PASS only on an exact match. Real static analysis, not something an LLM can do.",
    inputHint: "Any deployed Monad contract address — paste 0x…",
    examples: [],
  },
  honeypot: {
    label: "Honeypot / Sell-Tax Simulator",
    agent: "HoneypotSimulator",
    blurb: "Detects tokens you can buy but can't sell.",
    does: "Uses an eth_call EVM simulation to attempt a sell (a transfer from a normal holder) and detects honeypot tokens that let you buy but block or tax the sell — the trap that drains buyers. The interface looks normal; only simulation reveals it.",
    how: "The auditor re-runs the identical simulation on-chain; PASS only if the verdict matches. Requires EVM simulation — impossible for a chatbot.",
    inputHint: "A Monad token address — paste 0x…",
    examples: [],
  },
};

const ADDR = /0x[0-9a-fA-F]{40}/;

function parseDeterministic(_tc: TaskClass, text: string): string | null {
  return text.match(ADDR)?.[0] ?? null;
}

const PARSE_HELP: Record<TaskClass, string> = {
  "contract-audit": "Paste a deployed contract address (0x…) to audit.",
  "proxy-audit": "Paste a contract / proxy address (0x…) to inspect.",
  "selector-scan": "Paste a deployed contract address (0x…) to recover its selectors.",
  honeypot: "Paste a token address (0x…) to simulate a sell.",
};

export function normalizeStrict(taskClass: TaskClass, raw: string): string {
  const det = parseDeterministic(taskClass, (raw || "").trim());
  if (!det) throw new Error(PARSE_HELP[taskClass]);
  return det;
}

export async function resolveInput(
  taskClass: TaskClass,
  raw: string,
): Promise<{ status: "exact" | "suggest" | "none"; input?: string; label?: string; help?: string }> {
  const det = parseDeterministic(taskClass, (raw || "").trim());
  if (det) return { status: "exact", input: det };
  return { status: "none", help: PARSE_HELP[taskClass] };
}

// ---------------- worker ----------------
export async function runWorker(taskClass: TaskClass, input: string, cfg?: ModelCfg): Promise<WorkerResult> {
  // A deliberately-flawed agent: skips the real work and rubber-stamps everything as safe.
  // The auditor catches it → demonstrates the insurance refund + bond slash reproducibly.
  if (cfg?.provider === "naive") return { ...(await runWorkerNaive(taskClass, input)), mode: "naive-rule" };
  return { ...(await runWorkerReal(taskClass, input)), mode: "on-chain-read" };
}

async function runWorkerReal(taskClass: TaskClass, input: string): Promise<Omit<WorkerResult, "mode">> {
  const a = input.trim();
  if (taskClass === "contract-audit") return { result: await contractRisks(a), trace: "opcode walk of live bytecode" };
  if (taskClass === "proxy-audit") return { result: await proxyInfo(a), trace: "EIP-1967/1167 storage-slot read" };
  if (taskClass === "selector-scan") return { result: await functionSelectors(a), trace: "bytecode dispatcher parse" };
  return { result: await honeypotCheck(a), trace: "eth_call sell simulation" };
}

async function runWorkerNaive(taskClass: TaskClass, input: string): Promise<Omit<WorkerResult, "mode">> {
  if (taskClass === "honeypot") return { result: { honeypot: false, reason: "(did not simulate — assumed safe)" }, trace: "naive: skips the sell simulation" };
  if (taskClass === "contract-audit") return { result: { risky: [] }, trace: "naive: skips the opcode scan" };
  if (taskClass === "proxy-audit") return { result: { isProxy: false, kind: "not a proxy (direct contract)", implementation: null, admin: null }, trace: "naive: assumes not a proxy" };
  return runWorkerReal(taskClass, input); // selector-scan: no naive variant
}

// ---------------- auditor (re-derived from chain) ----------------
const eqArr = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const norm = (x: any) => (x == null ? null : String(x).toLowerCase());
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const pass = (reason: string, recomputed: any): Verdict => ({ pass: true, reason, recomputed });
const fail = (reason: string, recomputed: any): Verdict => ({ pass: false, reason, recomputed });

export async function runAuditor(taskClass: TaskClass, input: string, worker: any): Promise<Verdict> {
  const a = input.trim();

  if (taskClass === "contract-audit") {
    const truth = (await contractRisks(a)).risky;
    const claimed = [...new Set((worker?.risky || []).map(String))].sort() as string[];
    return eqArr(truth, claimed)
      ? pass(`Correctly surfaced ${truth.length} risky op(s): [${truth.join(", ") || "none"}].`, { risky: truth })
      : fail(`Risk list wrong. On-chain truth: [${truth.join(", ") || "none"}]. Agent: [${claimed.join(", ") || "none"}].`, { risky: truth });
  }

  if (taskClass === "proxy-audit") {
    const t = await proxyInfo(a);
    const ok = !!worker?.isProxy === t.isProxy && norm(worker?.implementation) === norm(t.implementation) && norm(worker?.admin) === norm(t.admin);
    return ok
      ? pass(`Correct: ${t.kind}${t.implementation ? `, impl ${short(t.implementation)}` : ""}${t.admin ? `, admin ${short(t.admin)}` : ""}.`, t)
      : fail(`Wrong. On-chain: ${t.isProxy ? t.kind : "not a proxy"}${t.implementation ? `, impl ${short(t.implementation)}` : ""}${t.admin ? `, admin ${short(t.admin)}` : ""}.`, t);
  }

  if (taskClass === "selector-scan") {
    const t = await functionSelectors(a);
    const claimed = [...new Set((worker?.selectors || []).map(String))].sort() as string[];
    return eqArr(t.selectors, claimed)
      ? pass(`Correctly recovered ${t.count} function selector(s).`, t)
      : fail(`Selector set mismatch. On-chain (${t.count}): [${t.selectors.join(", ")}]. Agent: [${claimed.join(", ")}].`, t);
  }

  // honeypot
  const t = await honeypotCheck(a);
  const ok = !!worker?.honeypot === t.honeypot;
  return ok
    ? pass(`Correct: ${t.honeypot ? "HONEYPOT — a normal holder cannot sell" : "safe — a normal holder can sell"}.`, t)
    : fail(`Wrong verdict. On-chain: ${t.honeypot ? "HONEYPOT (sells blocked)" : "safe"}; agent said ${worker?.honeypot ? "honeypot" : "safe"}.`, t);
}

// SAMPLES are injected by the server from the deployed target contracts (see server.ts).
export const SAMPLES: Record<TaskClass, { clean: string; tricky: string }> = {
  "contract-audit": { clean: "", tricky: "" },
  "proxy-audit": { clean: "", tricky: "" },
  "selector-scan": { clean: "", tricky: "" },
  honeypot: { clean: "", tricky: "" },
};
