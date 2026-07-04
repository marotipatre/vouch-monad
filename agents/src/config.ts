// Loads root .env + deployments/monadTestnet.json. Single source of truth for the backend.
import { config as dotenv } from "dotenv";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");

dotenv({ path: join(ROOT, ".env") });

const DEPLOY_PATH = join(ROOT, "deployments", "monadTestnet.json");
export const deployment: {
  chainId: number;
  rpc: string;
  usdc: string;
  registry: string;
  insurance: string;
  resolver: string;
  auditorAgentId: number;
  treasury: string;
  explorer: string;
  targets?: { proxy: string; logic: string; safeToken: string; honeypotToken: string; holder: string };
} = existsSync(DEPLOY_PATH)
  ? JSON.parse(readFileSync(DEPLOY_PATH, "utf8"))
  : ({ chainId: 0, rpc: "", usdc: "", registry: "", insurance: "", resolver: "", auditorAgentId: 0, treasury: "", explorer: "" } as any);

// Tolerant private-key parsing: env values pasted into hosting dashboards often carry
// stray quotes, whitespace, or an accidental "NAME=" prefix. Normalize to a valid
// 0x-prefixed 32-byte hex key, or "" if it isn't one (so a bad paste disables that signer
// instead of crashing the whole server on startup).
export function cleanKey(raw?: string): string {
  let k = (raw ?? "").trim().replace(/^["']+|["']+$/g, "").trim();
  if (k.includes("=") && !k.toLowerCase().startsWith("0x")) k = k.slice(k.lastIndexOf("=") + 1).trim();
  if (k && !k.toLowerCase().startsWith("0x")) k = "0x" + k;
  return /^0x[0-9a-fA-F]{64}$/.test(k) ? k.toLowerCase() : "";
}

export const env = {
  // Monad
  rpc: process.env.MONAD_RPC || deployment.rpc || "https://testnet-rpc.monad.xyz",
  chainId: Number(process.env.MONAD_CHAIN_ID || deployment.chainId || 10143),
  // backend wallet (custodial demo hires + faucet). Auditor uses its own key.
  deployerKey: cleanKey(process.env.DEPLOYER_PRIVATE_KEY),
  auditorKey: cleanKey(process.env.AUDITOR_PRIVATE_KEY),
  // set when a key was provided but couldn't be parsed — surfaced at startup + /api/health
  deployerKeyBad: !!process.env.DEPLOYER_PRIVATE_KEY?.trim() && !cleanKey(process.env.DEPLOYER_PRIVATE_KEY),
  auditorKeyBad: !!process.env.AUDITOR_PRIVATE_KEY?.trim() && !cleanKey(process.env.AUDITOR_PRIVATE_KEY),
  // optional worker LLM (the 4 core agents are deterministic on-chain reads and use none).
  groqKey: process.env.GROQ_API_KEY?.trim() ?? "",
  groqModel: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
  explorer: process.env.EXPLORER_URL || deployment.explorer || "https://testnet.monadexplorer.com",
  port: Number(process.env.PORT || 8787),
};

// Optional worker LLM (Groq). The 4 core agents are deterministic and don't use it.
export const llmProvider = (process.env.LLM_PROVIDER || "").toLowerCase() || (env.groqKey ? "groq" : "none");
export const hasLLM = llmProvider === "groq" && !!env.groqKey;
export const llmModel = env.groqModel;
