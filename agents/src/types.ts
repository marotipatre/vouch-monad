// Shared types across the agent layer. The evidence bundle is the contract between
// worker → evidence store → auditor → on-chain resolution.

export type TaskClass =
  | "erc20-safety"
  | "contract-audit"
  | "wallet-report"
  | "route"
  | "defi-health"
  | "general";

export interface WorkerOutput {
  agentId: string;
  taskClass: TaskClass;
  result: unknown;
  trace: string;
  mode: string;
}

export interface AuditorVerdict {
  pass: boolean;
  reason: string;
  recomputed: unknown;
}

/** The full bundle stored off-chain; its uri/hash is recorded on-chain at resolve. */
export interface EvidenceBundle {
  task: { taskClass: TaskClass; inputHash: string; input: string };
  output: { mode: string; result: unknown; trace: string };
  verdict: AuditorVerdict;
  createdAt: string; // ISO
}
