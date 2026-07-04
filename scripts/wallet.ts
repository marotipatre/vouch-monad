// Derive the deployer account from a BIP39 mnemonic (passed via the MNEMONIC env var),
// write DEPLOYER_PRIVATE_KEY into .env, and report the address + MON balance.
// Usage:  MNEMONIC="word1 word2 ... word12" pnpm tsx scripts/wallet.ts
import { mnemonicToAccount } from "viem/accounts";
import { createPublicClient, http, defineChain, formatEther, toHex } from "viem";
import { config as dotenv } from "dotenv";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const ENV = join(ROOT, ".env");
dotenv({ path: ENV });

async function main() {
  const mnemonic = (process.env.MNEMONIC || "").trim().replace(/\s+/g, " ");
  if (!mnemonic) throw new Error("set MNEMONIC env var (the 12/24-word seed phrase)");

  const account = mnemonicToAccount(mnemonic); // default path m/44'/60'/0'/0/0
  const pk = toHex(account.getHdKey().privateKey!);

  // write/replace DEPLOYER_PRIVATE_KEY in .env
  let text = existsSync(ENV) ? readFileSync(ENV, "utf8") : "";
  if (/^DEPLOYER_PRIVATE_KEY=.*$/m.test(text)) text = text.replace(/^DEPLOYER_PRIVATE_KEY=.*$/m, `DEPLOYER_PRIVATE_KEY=${pk}`);
  else text += (text && !text.endsWith("\n") ? "\n" : "") + `DEPLOYER_PRIVATE_KEY=${pk}\n`;
  writeFileSync(ENV, text);

  const RPC = process.env.MONAD_RPC || "https://testnet-rpc.monad.xyz";
  const chain = defineChain({ id: Number(process.env.MONAD_CHAIN_ID || 10143), name: "Monad Testnet", nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
  const pub = createPublicClient({ chain, transport: http(RPC) });
  const bal = await pub.getBalance({ address: account.address });

  console.log(`deployer address : ${account.address}`);
  console.log(`MON balance      : ${formatEther(bal)} MON`);
  console.log(`wrote DEPLOYER_PRIVATE_KEY to .env`);
  if (bal === 0n) console.log(`⚠ balance is 0 — send this address testnet MON before deploying.`);
}

main().catch((e) => { console.error(String(e)); process.exit(1); });
