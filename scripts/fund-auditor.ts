// Top up the auditor wallet with MON for gas (it signs every resolve).
// Usage:  pnpm tsx scripts/fund-auditor.ts [amountMON]   (default 1)
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, createWalletClient, http, defineChain, parseEther, formatEther } from "viem";
import { config as dotenv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv({ path: join(__dirname, "..", ".env") });

const key = (k: string) => (k.startsWith("0x") ? k : `0x${k}`) as `0x${string}`;

async function main() {
  const amount = process.argv[2] || "1";
  const RPC = process.env.MONAD_RPC || "https://testnet-rpc.monad.xyz";
  const chain = defineChain({ id: Number(process.env.MONAD_CHAIN_ID || 10143), name: "Monad Testnet", nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
  const pub = createPublicClient({ chain, transport: http(RPC) });
  const deployer = privateKeyToAccount(key(process.env.DEPLOYER_PRIVATE_KEY!));
  const auditor = privateKeyToAccount(key(process.env.AUDITOR_PRIVATE_KEY!));
  const wallet = createWalletClient({ account: deployer, chain, transport: http(RPC) });

  console.log(`sending ${amount} MON → auditor ${auditor.address}…`);
  const hash = await wallet.sendTransaction({ to: auditor.address, value: parseEther(amount) });
  await pub.waitForTransactionReceipt({ hash });
  console.log(`  ✓ tx ${hash}`);
  console.log(`  auditor balance now: ${formatEther(await pub.getBalance({ address: auditor.address }))} MON`);
  console.log(`  deployer balance now: ${formatEther(await pub.getBalance({ address: deployer.address }))} MON`);
}

main().catch((e) => { console.error(String(e)); process.exit(1); });
