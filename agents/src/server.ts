// Vouch agent service (Monad). Drives the real end-to-end loop the UI calls:
//   hire (tx #1) -> worker -> auditor -> evidence store -> resolve (tx #2)
// No DeepBook / prediction market — reliability is performance-based.
import express from "express";
import cors from "cors";
import { createHash } from "node:crypto";
import { env, deployment as d, hasLLM, llmProvider, llmModel } from "./config.js";
import { runWorker, runAuditor, normalizeStrict, resolveInput, SAMPLES, TASK_META, type TaskClass } from "./tasks.js";
import { putBundle, evidenceId, getBundle } from "./evidence.js";
import {
  hire, resolve, leaderboard, readAgentById, createAgent, performanceReliability,
  getActivity, getRevenue, fundWallet, recordHireRevenue, TREASURY, ME, AUDITOR, MOCK,
} from "./chain.js";
import { getConfig, setConfig, MODEL_CATALOG } from "./models.js";

const TASK_CLASSES: TaskClass[] = ["erc20-safety", "contract-audit", "wallet-report", "route", "defi-health", "general"];

// Only our own internal worker may be called — no user-supplied URLs reach fetch() (SSRF guard).
const EXTRA_ORIGINS = (process.env.VOUCH_WORKER_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
async function callExternalAgent(url: string, taskClass: string, input: string) {
  let u: URL;
  try { u = new URL(url); } catch { throw new Error("invalid worker url"); }
  if (u.hostname === "localhost" || u.hostname === "127.0.0.1") u.port = String(env.port);
  const allow = [`http://localhost:${env.port}`, `http://127.0.0.1:${env.port}`, ...EXTRA_ORIGINS];
  if (!allow.includes(u.origin)) throw new Error(`worker origin not allowlisted: ${u.origin}`);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const r = await fetch(u.toString(), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ taskClass, input }), signal: ctrl.signal, redirect: "error" });
    if (!r.ok) throw new Error(`agent endpoint ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const text = (await r.text()).slice(0, 100_000);
    const dd: any = JSON.parse(text);
    return { result: dd.result, trace: `internal worker @ ${u.origin}`, mode: dd.mode || "external" };
  } finally { clearTimeout(timer); }
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const explorer = (hash: string) => `${env.explorer}/tx/${hash}`;

app.get("/api/health", (_req, res) =>
  res.json({
    ok: true,
    llm: hasLLM,
    provider: hasLLM ? llmProvider : "deterministic",
    model: hasLLM ? llmModel : null,
    wallet: ME,
    auditor: AUDITOR,
    mock: MOCK,
    deployerKeyBad: env.deployerKeyBad,
    auditorKeyBad: env.auditorKeyBad,
    auditorLoaded: AUDITOR !== "0x0000000000000000000000000000000000000000",
    network: MOCK ? "mock (in-memory)" : "monad-testnet",
    chainId: env.chainId,
    usdc: d.usdc,
    registry: d.registry,
    insurance: d.insurance,
    resolver: d.resolver,
    treasury: TREASURY,
    backend: ME,
  }),
);

// Faucet: mint mock USDC to a connected wallet so the user can pay for hires.
app.post("/api/faucet", async (req, res) => {
  const address = String((req.body as { address?: string }).address || "");
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return res.status(400).json({ error: "valid 0x address required" });
  try { res.json(await fundWallet(address)); }
  catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get("/api/agents", async (_req, res) => {
  try {
    const agents = await leaderboard();
    res.json(agents.map((a: any) => ({ ...a, config: getConfig(a.id) })));
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// Dogfood worker endpoint: lets us register built-in agents as "internal" endpoints.
app.post("/agent", async (req, res) => {
  const { taskClass, input } = req.body as { taskClass: TaskClass; input: string };
  const provider = (req.query.provider as string) || "groq";
  const model = (req.query.model as string) || "llama-3.1-8b-instant";
  try {
    const w = await runWorker(taskClass, input, { provider, model });
    res.json({ result: w.result, mode: w.mode });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get("/api/models", (_req, res) => res.json(MODEL_CATALOG));
app.get("/api/tasks", (_req, res) => res.json(TASK_META));
app.get("/api/revenue", (_req, res) => res.json(getRevenue()));
app.get("/api/activity", (_req, res) =>
  res.json(getActivity().map((a) => ({ ...a, tx: explorer(a.digest) }))),
);
app.get("/api/samples/:taskClass", (req, res) => {
  const tc = req.params.taskClass as TaskClass;
  const s = { ...(SAMPLES[tc] ?? {}) };
  // On-chain tasks need a real address — default to the deployed contracts so every
  // agent has a working one-click example.
  if (tc === "erc20-safety" && !s.clean) { s.clean = d.usdc; s.tricky = d.usdc; }
  if (tc === "contract-audit" && !s.clean) { s.clean = d.insurance; s.tricky = d.registry; }
  if (tc === "wallet-report" && !s.clean) { s.clean = TREASURY; s.tricky = TREASURY; }
  res.json(s);
});

// Serve a stored evidence bundle (the full proof: input hash + worker output + verdict).
// This is the content the on-chain `evidenceUri` points at — anyone can re-verify it.
app.get("/api/evidence/:id", (req, res) => {
  const body = getBundle(req.params.id);
  if (!body) return res.status(404).json({ error: "evidence not found" });
  res.type("application/json").send(body);
});

// Import / list an agent: register an on-chain identity + bond, point Vouch at a hosted model.
app.post("/api/agents", async (req, res) => {
  const { name, taskClass, bondUsdc, endpoint, provider, model, feeUsdc } = req.body as {
    name: string; taskClass: string; bondUsdc: number; endpoint?: string; provider?: string; model?: string; feeUsdc?: number;
  };
  if (!name || !TASK_CLASSES.includes(taskClass as TaskClass)) return res.status(400).json({ error: "name + valid taskClass required" });
  if (!(bondUsdc >= 1)) return res.status(400).json({ error: "bondUsdc must be ≥ 1 (min stake)" });
  if (endpoint) return res.status(400).json({ error: "external endpoints are disabled; create a hosted agent (provider + model)" });
  if (!provider || !model) return res.status(400).json({ error: "choose a hosted model (provider + model)" });
  const fee = feeUsdc && feeUsdc > 0 ? Number(feeUsdc) : 5;
  try {
    const { agentId, digest } = await createAgent(name, taskClass, bondUsdc);
    if (agentId) setConfig(agentId, { provider, model, feeUsdc: fee });
    res.json({ agentId, taskClass, tx: explorer(digest) });
  } catch (e) { console.error(e); res.status(500).json({ error: String(e) }); }
});

app.post("/api/agents/:id/price", (req, res) => {
  const feeUsdc = Number((req.body as { feeUsdc: number }).feeUsdc);
  if (!(feeUsdc >= 0.1)) return res.status(400).json({ error: "feeUsdc must be ≥ 0.1" });
  setConfig(req.params.id, { ...getConfig(req.params.id), feeUsdc });
  res.json({ ok: true, feeUsdc });
});

app.post("/api/resolve", async (req, res) => {
  const { taskClass, text } = req.body as { taskClass: TaskClass; text: string };
  try { res.json(await resolveInput(taskClass, text)); }
  catch (e) { res.status(500).json({ error: String(e) }); }
});

// Streamed run: emits a terminal line per on-chain step (SSE), then a final result.
app.post("/api/run", async (req, res) => {
  const { agentId, input: rawInput, withGuarantee, hire: clientHire } = req.body as {
    agentId: string; input: string; withGuarantee: boolean;
    // present when the user signed & paid the hire from their own wallet (client-side)
    hire?: { policyId: string; agentNetUsdc: number; protocolFeeUsdc: number; premiumUsdc: number; coverageUsdc: number; userAddress: string; digest?: string };
  };
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  const send = (o: any) => res.write(`data: ${JSON.stringify(o)}\n\n`);
  const log = (msg: string) => send({ type: "log", msg });

  try {
    if (!agentId || typeof rawInput !== "string") throw new Error("agentId + input required");
    const before = await readAgentById(agentId);
    if (!before) throw new Error("agent not found");
    const taskClass = before.taskClass as TaskClass;
    const cfg = getConfig(agentId);
    const fee = cfg.feeUsdc ?? 5;

    // 0) deterministic target
    const input = normalizeStrict(taskClass, rawInput);
    log(`PARSE target → ${input.slice(0, 64)}${input.length > 64 ? "…" : ""}`);

    // 1) hire (tx #1) — user-signed (paid from their wallet) or custodial (backend pays)
    let hr: { digest: string; policyId?: string; agentNetUsdc: number; premiumUsdc: number; coverageUsdc: number };
    const paidBy = clientHire?.policyId ? "user" : "custodial";
    if (clientHire?.policyId) {
      log(`HIRE  $${fee} paid from wallet ${clientHire.userAddress.slice(0, 8)}… — $${clientHire.protocolFeeUsdc} platform fee, $${clientHire.agentNetUsdc} escrowed${withGuarantee ? `, + $${clientHire.premiumUsdc} premium → reserve` : ""}`);
      recordHireRevenue(clientHire.protocolFeeUsdc, clientHire.premiumUsdc);
      hr = { digest: clientHire.digest ?? "", policyId: clientHire.policyId, agentNetUsdc: clientHire.agentNetUsdc, premiumUsdc: clientHire.premiumUsdc, coverageUsdc: clientHire.coverageUsdc };
      log(`  ✓ policy ${clientHire.policyId} created by user · escrow $${clientHire.agentNetUsdc} held`);
    } else {
      log(`HIRE  $${fee} (custodial demo wallet): $${(fee * 0.1).toFixed(2)} platform fee, $${(fee * 0.9).toFixed(2)} escrowed${withGuarantee ? ", + premium → reserve" : ""}`);
      hr = await hire(agentId, !!withGuarantee, fee); // records revenue internally
      log(`  ✓ ${withGuarantee ? `guarantee ($${hr.coverageUsdc} cover, $${hr.premiumUsdc} premium)` : "no guarantee"} · escrow $${hr.agentNetUsdc} held · tx ${hr.digest.slice(0, 10)}…`);
    }
    if (!hr.policyId) throw new Error("hire produced no policy");

    // 2) worker
    log(`WORK  ${cfg.endpoint ? "calling internal agent endpoint" : "running worker " + (cfg.model ?? "")} on ${taskClass}…`);
    const worker = cfg.endpoint
      ? await callExternalAgent(cfg.endpoint, taskClass, input)
      : await runWorker(taskClass, input, cfg.provider && cfg.model ? { provider: cfg.provider, model: cfg.model } : undefined);
    log(`  ✓ agent (${worker.mode}) returned: ${JSON.stringify(worker.result).slice(0, 80)}`);

    // 3) auditor
    log(`AUDIT independent auditor re-deriving ground truth from on-chain state…`);
    const verdict = await runAuditor(taskClass, input, worker.result);
    log(`  ${verdict.pass ? "✓ PASS" : "✗ FAIL"} — ${verdict.reason.slice(0, 90)}`);

    // 4) evidence store
    log(`EVIDENCE storing bundle (input hash + output + verdict)…`);
    const bundle = { task: { taskClass, inputHash: sha256(input), input }, output: { mode: worker.mode, result: worker.result, trace: worker.trace }, verdict, createdAt: new Date().toISOString() };
    let uri: string; let stored = true;
    try { uri = await putBundle(bundle); } catch { stored = false; uri = `sha256:${bundle.task.inputHash.slice(0, 32)}`; }
    log(`  ✓ ${uri.slice(0, 20)}… ${stored ? "(stored, content-addressed)" : "(fallback hash)"}`);

    // 5) resolve (tx #2)
    const newRel = performanceReliability(before.jobs, before.fails, verdict.pass);
    log(`RESOLVE auditor settling on-chain · ${verdict.pass ? "release fee to agent" : "REFUND user, agent gets nothing, slash bond"}…`);
    const r = await resolve(agentId, hr.policyId, verdict.pass, uri, newRel);
    if (verdict.pass) log(`  ✓ fee $${hr.agentNetUsdc} released to agent · premium $${hr.premiumUsdc} kept · tx ${r.digest.slice(0, 10)}…`);
    else log(`  ✓ your $${hr.agentNetUsdc} fee refunded · agent earned $0 · bond slashed $${r.slashedUsdc} · tx ${r.digest.slice(0, 10)}…`);
    const after = await readAgentById(agentId);
    log(`  reliability ${(before.reliabilityBps / 100).toFixed(0)}% → ${(newRel / 100).toFixed(0)}%`);

    send({
      type: "done",
      result: {
        hire: { feeUsdc: fee, protocolFeeUsdc: clientHire?.protocolFeeUsdc ?? +(fee * 0.1).toFixed(4), agentNetUsdc: hr.agentNetUsdc, premiumUsdc: hr.premiumUsdc, coverageUsdc: hr.coverageUsdc, reliabilityBps: before.reliabilityBps, paidBy, tx: hr.digest ? explorer(hr.digest) : "" },
        worker,
        verdict,
        evidence: { uri, id: evidenceId(uri), inputHash: bundle.task.inputHash, stored },
        resolve: { ...r, tx: explorer(r.digest) },
        agent: { before, after },
      },
    });
  } catch (e) {
    console.error(e);
    send({ type: "error", error: String(e) });
  }
  res.end();
});

app.listen(env.port, () => {
  console.log(`vouch agent service (Monad) → http://localhost:${env.port}`);
  console.log(`  mode   ${MOCK ? "MOCK (in-memory, no chain)" : "on-chain (Monad testnet)"}`);
  console.log(`  wallet ${ME}`);
  if (env.deployerKeyBad) console.warn(`  ⚠ DEPLOYER_PRIVATE_KEY is set but not a valid 0x + 64-hex key — deployer signer disabled`);
  if (env.auditorKeyBad) console.warn(`  ⚠ AUDITOR_PRIVATE_KEY is set but not a valid 0x + 64-hex key — settlement disabled`);
  if (!MOCK && ME === "0x0000000000000000000000000000000000000000") console.warn(`  ⚠ no valid DEPLOYER_PRIVATE_KEY — set it in the host's env vars`);
  console.log(`  worker ${hasLLM ? llmProvider + " (" + llmModel + ")" : "deterministic"}`);
});
