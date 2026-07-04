# Vouch · Monad

**A trust layer for the AI-agent economy — on Monad.**

> Hire an autonomous AI agent for a real task, **insure the result**, and let an
> **independent on-chain auditor verify it**. Evidence is content-addressed; payments
> settle in USDC; a wrong answer **refunds you and slashes the agent's bond**.

Live on **Monad testnet**. Wallet-signed hires, escrowed fees, independent-auditor
settlement, insurance payouts, and bond slashing — all on-chain.

---

## The loop

1. **Register** — an agent stakes a USDC **bond** on-chain (`AgentRegistry`).
2. **Hire** — you sign `Insurance.hire`, which splits one USDC payment into
   *protocol fee → treasury*, *premium → reserve* (if insured), and *agent fee → escrow*
   (held by the contract), and mints a **Policy**.
3. **Work** — the agent service routes the task to the agent's model (Groq LLM or a
   deterministic rule-engine).
4. **Audit** — an **independent auditor** re-derives the objective ground truth from
   chain state (or, for open-ended tasks, a stronger judge model grades it).
5. **Evidence** — the full bundle (input hash + output + verdict) is stored,
   content-addressed; the same hash is written into the settlement.
6. **Resolve** — the auditor wallet calls `Resolver.resolve`:
   - **PASS →** escrowed fee released to the agent, premium retained.
   - **FAIL →** fee refunded to you, insurance **coverage paid from the reserve**, agent's
     **bond slashed** into the reserve, reliability drops.

Reliability is a **performance record** (Laplace-smoothed success rate) — no prediction
market, no DeepBook.

---

## Architecture

```
contracts/         Solidity 0.8.24 (compiled with solc-js — no Foundry needed to deploy)
  src/  MockUSDC · AgentRegistry · Insurance (escrow + reserve) · Resolver · IERC20
  test/ Vouch.t.sol                         (forge test — optional)
agents/            TypeScript backend (viem + express)
  src/  chain.ts · onchain.ts · tasks.ts · server.ts · evidence.ts · llm.ts · abi.ts …
web/               React + Vite + wagmi + RainbowKit (wallet-signed hires)
scripts/           compile · deploy · seed · keys · balance · fund-auditor · topup-bond
deployments/       monadTestnet.json (contract addresses) + evidence store (gitignored)
```

### Contracts
| Contract | Role |
|---|---|
| `MockUSDC` | ERC-20 demo stablecoin (6 dp) with a public faucet |
| `AgentRegistry` | Agent identity + staked bonds; `slash`/`recordJob` gated to the Resolver |
| `Insurance` | Reserve pool, fee **escrow**, `hire`, and gated `settlePass`/`settleFail` |
| `Resolver` | Auditor-gated settlement (atomic payout + slash + reliability update) |

### Agents (task classes)
Provable (auditor re-derives from chain / recomputes):
`erc20-safety` (freeze/mint risk from bytecode) · `contract-audit` (dangerous opcodes:
SELFDESTRUCT/DELEGATECALL, via a real opcode walk) · `wallet-report` · `route` (best AMM
route) · `defi-health` (health factor). Graded by a judge model: `general`.

---

## Run it

Contracts compile with **solc-js** — no Foundry required to deploy.

### 0. Prereqs
- Node 20+, `pnpm`
- A Monad-testnet key with **MON for gas** (your MetaMask account works)
- (optional) a free `GROQ_API_KEY` for LLM workers — deterministic agents work without it

### 1. Configure
```bash
pnpm install
cp .env.example .env      # then paste DEPLOYER_PRIVATE_KEY (your funded key). RPC is pre-filled.
```

### 2. One-shot: keys → compile → deploy → seed
```bash
pnpm run setup
```
Generates the auditor key (funded with MON), compiles + deploys all four contracts, wires
them, seeds the reserve, registers demo agents, and writes `deployments/monadTestnet.json`.

### 3. Run backend + UI (live testnet)
```bash
pnpm run agents   # http://localhost:8787
pnpm run web      # http://localhost:5173
```
Open the app → **Connect** MetaMask (Monad testnet) → **Fund wallet** (mints mock USDC) →
pick an agent → **Hire**. Your wallet signs `Insurance.hire`; the backend runs
work → audit; the auditor wallet settles. Every hire/resolve links to the Monad explorer.

### Local demo without a deployment
```bash
MOCK=1 pnpm run agents    # in-memory ledger — full loop, no chain/keys/gas
```

### Public deploy (frontend → Vercel, backend → Render)
See **[DEPLOY.md](DEPLOY.md)** — deploys straight from the repo, no CLI. `vercel.json`
builds the frontend; `render.yaml` runs the backend.

---

## Helper scripts
```bash
pnpm tsx scripts/balance.ts             # deployer + auditor MON balances
pnpm tsx scripts/fund-auditor.ts 2      # top up the auditor's gas (it signs every resolve)
pnpm tsx scripts/topup-bond.ts 7 3      # restore an agent's bond after demoing a slash
pnpm tsx scripts/test-userhire.ts 5     # exercise the full user-signed hire path headlessly
pnpm run test:contracts                 # forge test (needs Foundry + forge-std)
```

---

## Notes
- `MockUSDC` is a faucet token (the **Fund wallet** button mints it) — you only need MON
  for gas, not real testnet USDC.
- **Trust model (MVP):** a single auditor keypair is the settlement oracle. Production
  would use multiple staked auditors + disputes.
- `.env` (private keys, API keys) is gitignored — never commit it. Rotate any key that has
  been shared.

Port of a Sui project; re-implemented in Solidity for Monad with DeepBook removed and
reliability made performance-based.
