// Evidence store — the Monad port's replacement for Walrus. The full bundle (task input
// hash + worker output + auditor verdict) is content-addressed by sha256 and persisted;
// its URI is recorded on-chain at resolve, so anyone can re-fetch and re-verify.
//
// Default backend is a local content-addressed directory (deployments/evidence/). If a
// WEB3_STORAGE / IPFS gateway is configured you can swap `putBundle` for a real upload;
// the on-chain contract only stores an opaque string, so the URI scheme is pluggable.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STORE = join(__dirname, "..", "..", "deployments", "evidence");

export const hashInput = (input: string): string => createHash("sha256").update(input).digest("hex");

/** Persist the bundle content-addressed; returns a `cas:<sha256>` URI. */
export async function putBundle(bundle: unknown): Promise<string> {
  const body = JSON.stringify(bundle);
  const id = createHash("sha256").update(body).digest("hex");
  if (!existsSync(STORE)) mkdirSync(STORE, { recursive: true });
  writeFileSync(join(STORE, `${id}.json`), body);
  return `cas:${id}`;
}

/** The content id (sha256) inside a `cas:` URI, or "" for other schemes. */
export const evidenceId = (uri: string): string => (uri.startsWith("cas:") ? uri.slice(4) : "");

/** Read a stored bundle back by content id. Returns the raw JSON string or null. */
export function getBundle(id: string): string | null {
  if (!/^[0-9a-f]{64}$/.test(id)) return null;
  const p = join(STORE, `${id}.json`);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}
