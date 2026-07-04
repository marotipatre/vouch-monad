// Client for the Vouch (Monad) agent backend. Custodial hires — the backend wallet pays,
// so the UI needs no wallet connection for the demo. VITE_API overrides the base URL.
const isLocal = typeof location !== "undefined" && /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
const BASE = (import.meta as any).env?.VITE_API ?? (isLocal ? "http://localhost:8787" : "");

export interface TaskMeta {
  label: string; agent: string; blurb: string; does?: string; how?: string; inputHint?: string; examples?: string[];
}
export interface ApiAgent {
  id: string; taskClass: string; name: string; owner: string;
  reliabilityBps: number; bondUsdc: number; jobs: number; fails: number;
  config?: { provider?: string; model?: string; feeUsdc?: number };
}
export interface RunResult {
  hire: { tx: string; feeUsdc: number; protocolFeeUsdc: number; agentNetUsdc: number; premiumUsdc: number; coverageUsdc: number; reliabilityBps: number };
  worker: { mode: string; result: any; trace: string };
  verdict: { pass: boolean; reason: string; recomputed: any };
  evidence: { uri: string; id: string; inputHash: string; stored: boolean };
  resolve: { tx: string; payoutUsdc: number; slashedUsdc: number; newReliabilityBps: number };
  agent: { before: ApiAgent; after: ApiAgent };
}

async function j<T>(p: Promise<Response>): Promise<T> {
  const r = await p;
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
  return r.json();
}

export const api = {
  health: () => j<{ ok: boolean; llm: boolean; provider: string; model: string | null; wallet: string; mock: boolean; network: string; chainId: number; usdc: string; registry: string; insurance: string; resolver: string; treasury: string }>(fetch(`${BASE}/api/health`)),
  agents: () => j<ApiAgent[]>(fetch(`${BASE}/api/agents`)),
  tasks: () => j<Record<string, TaskMeta>>(fetch(`${BASE}/api/tasks`)),
  samples: (tc: string) => j<{ clean: string; tricky: string }>(fetch(`${BASE}/api/samples/${tc}`)),
  revenue: () => j<{ feesUsdc: number; premiumsUsdc: number; payoutsUsdc: number; slashedUsdc: number; netInsuranceUsdc: number; totalUsdc: number; treasury: string }>(fetch(`${BASE}/api/revenue`)),
  activity: () => j<{ ts: number; kind: string; label: string; tx: string }[]>(fetch(`${BASE}/api/activity`)),
  faucet: (address: string) => j<{ digest: string; usdc: number }>(fetch(`${BASE}/api/faucet`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address }) })),
  createAgent: (body: { name: string; taskClass: string; bondUsdc: number; feeUsdc: number; provider?: string; model?: string }) =>
    j<{ agentId: string; tx: string }>(fetch(`${BASE}/api/agents`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })),
  setPrice: (id: string, feeUsdc: number) =>
    j<{ ok: boolean; feeUsdc: number }>(fetch(`${BASE}/api/agents/${id}/price`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ feeUsdc }) })),
  runStream,
};

/** Insurance premium estimate — mirrors the backend (coverage × (1−reliability) × load). */
export const premiumUsdc = (fee: number, reliabilityBps: number) => +(fee * (1 - reliabilityBps / 10000) * 1.2).toFixed(2);

/** URL that serves the full evidence bundle JSON (the proof the on-chain hash points at). */
export const evidenceUrl = (id: string) => (id ? `${BASE}/api/evidence/${id}` : null);

export interface ClientHire { policyId: string; agentNetUsdc: number; protocolFeeUsdc: number; premiumUsdc: number; coverageUsdc: number; userAddress: string; digest?: string }

export async function runStream(
  body: { agentId: string; input: string; withGuarantee: boolean; hire?: ClientHire },
  onLog: (line: string) => void,
): Promise<RunResult> {
  const res = await fetch(`${BASE}/api/run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.body) throw new Error("no stream");
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "", result: RunResult | null = null, error: string | null = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 2);
      if (!chunk.startsWith("data:")) continue;
      const o = JSON.parse(chunk.slice(5).trim());
      if (o.type === "log") onLog(o.msg);
      else if (o.type === "done") result = o.result;
      else if (o.type === "error") error = o.error;
    }
  }
  if (error) throw new Error(error);
  if (!result) throw new Error("run did not complete");
  return result;
}
