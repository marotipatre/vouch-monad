// Per-agent off-chain config: which model (or external endpoint) executes an agent's
// jobs. On-chain identity/bond is real; this is just how the listed agent runs.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { llmProvider, llmModel } from "./config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PATH = join(__dirname, "..", "agent-config.json");

export interface AgentConfig {
  provider?: string; // groq | anthropic | deterministic
  model?: string;
  endpoint?: string; // if set, Vouch POSTs jobs to this internal (allowlisted) URL
  feeUsdc?: number; // price the agent owner charges per task (default 5)
}

const load = (): Record<string, AgentConfig> => {
  if (!existsSync(PATH)) return {};
  try { return JSON.parse(readFileSync(PATH, "utf8")); } catch { return {}; }
};

export function getConfig(agentId: string): AgentConfig {
  return load()[agentId] ?? { provider: llmProvider, model: llmModel };
}
export function setConfig(agentId: string, cfg: AgentConfig) {
  const all = load();
  all[agentId] = cfg;
  writeFileSync(PATH, JSON.stringify(all, null, 2) + "\n");
}

// Models a first-party listing can pick (used when no external endpoint is given).
export const MODEL_CATALOG = [
  { provider: "groq", model: "llama-3.1-8b-instant" },
  { provider: "groq", model: "llama-3.3-70b-versatile" },
  { provider: "anthropic", model: "claude-sonnet-4-6" },
  { provider: "deterministic", model: "rule-engine" },
];
