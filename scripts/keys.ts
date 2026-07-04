// Generate the auditor keypair (the on-chain oracle that signs Resolver.resolve) and
// append AUDITOR_PRIVATE_KEY to .env if it isn't already set. The deploy script funds
// this address with a little MON for gas.  Run:  pnpm keys
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV = join(__dirname, "..", ".env");

let text = existsSync(ENV) ? readFileSync(ENV, "utf8") : "";

// Already set to a real key? Do nothing (idempotent).
const set = text.match(/^AUDITOR_PRIVATE_KEY=(0x[0-9a-fA-F]{64})\s*$/m);
if (set) {
  console.log(`AUDITOR_PRIVATE_KEY already set → ${privateKeyToAccount(set[1] as `0x${string}`).address}`);
} else {
  const pk = generatePrivateKey();
  const addr = privateKeyToAccount(pk).address;
  if (/^AUDITOR_PRIVATE_KEY=.*$/m.test(text)) {
    // replace the existing (empty/placeholder) line in place — dotenv keeps the FIRST
    // occurrence, so we must not just append a second line.
    text = text.replace(/^AUDITOR_PRIVATE_KEY=.*$/m, `AUDITOR_PRIVATE_KEY=${pk}`);
  } else {
    text += (text && !text.endsWith("\n") ? "\n" : "") + `AUDITOR_PRIVATE_KEY=${pk}\n`;
  }
  writeFileSync(ENV, text);
  console.log(`Generated auditor key → ${addr}`);
  console.log(`Wrote AUDITOR_PRIVATE_KEY to .env (deploy funds it with MON for gas).`);
}
