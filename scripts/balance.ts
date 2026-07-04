// Report the deployer + auditor addresses and their MON balances (reads .env).
// Run:  pnpm tsx scripts/balance.ts
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http, defineChain, formatEther } from "viem";
import { config as dotenv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv({ path: join(__dirname, "..", ".env") });

const key = (k?: string) => k ? ((k.startsWith("0x") ? k : `0x${k}`) as `0x${string}`) : undefined;

async function main() {
  const RPC = process.env.MONAD_RPC || "https://testnet-rpc.monad.xyz";
  const chain = defineChain({ id: Number(process.env.MONAD_CHAIN_ID || 10143), name: "Monad Testnet", nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
  const pub = createPublicClient({ chain, transport: http(RPC) });

  for (const [label, env] of [["deployer", "DEPLOYER_PRIVATE_KEY"], ["auditor", "AUDITOR_PRIVATE_KEY"]] as const) {
    const k = key(process.env[env]);
    if (!k) { console.log(`${label.padEnd(9)}: (not set)`); continue; }
    const acct = privateKeyToAccount(k);
    const bal = await pub.getBalance({ address: acct.address });
    console.log(`${label.padEnd(9)}: ${acct.address}  ${formatEther(bal)} MON`);
  }
}

main().catch((e) => { console.error(String(e)); process.exit(1); });
