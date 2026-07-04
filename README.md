# AgentMonad

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

## Deployed on Monad testnet (chain 10143)

Explorer: [testnet.monadexplorer.com](https://testnet.monadexplorer.com) · RPC: `https://testnet-rpc.monad.xyz`

**Core protocol**

| Contract | Address | Explorer |
|---|---|---|
| MockUSDC | `0xce210d9a2096134bd578e18cf73f7f02010d63a1` | [view ↗](https://testnet.monadexplorer.com/address/0xce210d9a2096134bd578e18cf73f7f02010d63a1) |
| AgentRegistry(ERC 8004) | `0xc35d29eac7e1bb578b0064c3eb1696f9038a3632` | [view ↗](https://testnet.monadexplorer.com/address/0xc35d29eac7e1bb578b0064c3eb1696f9038a3632) |
| Insurance (escrow + reserve) | `0xabe3958492b2c3b8a96bfc76bc1e1a68855c2343` | [view ↗](https://testnet.monadexplorer.com/address/0xabe3958492b2c3b8a96bfc76bc1e1a68855c2343) |
| Resolver (auditor oracle) | `0x7ff1e47ed335bb61545b48642a66a4f9c7ae8ccf` | [view ↗](https://testnet.monadexplorer.com/address/0x7ff1e47ed335bb61545b48642a66a4f9c7ae8ccf) |

**Analysis targets** (what the agents inspect on-chain)

| Contract | Address | Explorer |
|---|---|---|
| SampleProxy (EIP-1967, DELEGATECALL) | `0xde4312acc4ac7c19a8f3041a82c5609423fa0291` | [view ↗](https://testnet.monadexplorer.com/address/0xde4312acc4ac7c19a8f3041a82c5609423fa0291) |
| SampleLogic (proxy implementation) | `0x5b8710b94983913224c1ab4616a097d470cc7c72` | [view ↗](https://testnet.monadexplorer.com/address/0x5b8710b94983913224c1ab4616a097d470cc7c72) |
| SafeToken (freely transferable) | `0x76fc507cbe8fe34964e683d90edf4bfbbae49d46` | [view ↗](https://testnet.monadexplorer.com/address/0x76fc507cbe8fe34964e683d90edf4bfbbae49d46) |
| HoneypotToken (sell-blocked) | `0x2b916eed3a3d32ca70a98d0e72881e9e86e2e9c5` | [view ↗](https://testnet.monadexplorer.com/address/0x2b916eed3a3d32ca70a98d0e72881e9e86e2e9c5) |

Treasury / deployer: [`0xF73938601C588bE60027938129a29Bbdde9D9CaC`](https://testnet.monadexplorer.com/address/0xF73938601C588bE60027938129a29Bbdde9D9CaC) · auditor agent id: `1`

---

## Architecture

```
contracts/         Solidity 0.8.24 (compiled with solc-js — no Foundry needed to deploy)
  src/  MockUSDC · AgentRegistry · Insurance (escrow + reserve) · Resolver · IERC20
  test/ Vouch.t.sol                         (forge test — optional)
agents/            TypeScript backend (viem + express)
  src/  chain.ts · onchain.ts · tasks.ts · server.ts · evidence.ts · abi.ts …
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
Four high-technical, on-chain-only agents — each does something an LLM can't, and the
auditor re-derives the exact result from live chain state:
- **`contract-audit`** — walks live bytecode opcodes to flag SELFDESTRUCT / DELEGATECALL
- **`proxy-audit`** — reads raw EIP-1967 storage slots to reveal the proxy admin (upgrade control)
- **`selector-scan`** — parses the bytecode dispatcher to recover a contract's function ABI
- **`honeypot`** — eth_call-simulates a sell to detect tokens you can buy but can't sell

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
