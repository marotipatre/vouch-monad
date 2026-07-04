# Deploying Vouch (public, for judges)

Two pieces, two hosts:

- **Backend** (`agents/`) → **Render** — a long-running server (SSE settlement, on-chain
  signing with the deployer/auditor keys, evidence store). Not a fit for Vercel serverless.
- **Frontend** (`web/`) → **Vercel** — a static Vite app.

Both deploy straight from the GitHub repo — **no CLI needed**. Do the backend first (the
frontend needs its URL).

---

## 1. Backend → Render (~3 min)

1. Push this repo to GitHub (done: `github.com/jarvisgen/vouch-monad`).
2. Render dashboard → **New** → **Blueprint** → connect the `vouch-monad` repo.
   Render reads `render.yaml` and creates the `vouch-monad-backend` web service.
3. Before **Apply**, set the three secret env vars (marked `sync:false`):
   - `DEPLOYER_PRIVATE_KEY` — the funded deployer key
   - `AUDITOR_PRIVATE_KEY` — from your `.env` (`grep AUDITOR_PRIVATE_KEY .env`)
   - `GROQ_API_KEY` — your Groq key
4. **Apply** → wait for the build. You'll get a URL like
   `https://vouch-monad-backend.onrender.com`.
5. Verify: open `https://…onrender.com/api/health` → should show
   `{"ok":true,"mock":false,"network":"monad-testnet",...}`.

> Free tier spins down after ~15 min idle (cold start ~50s). The UI shows a "waking up"
> message and retries — fine for a demo, or upgrade to keep it warm.

---

## 2. Frontend → Vercel (~2 min)

1. Vercel dashboard → **Add New… → Project** → import the `vouch-monad` repo.
2. Vercel reads the root `vercel.json` (builds `web/`). Framework: Other. Leave build
   settings as detected.
3. Add an **Environment Variable** (Production + Preview):
   - `VITE_API` = your Render backend URL (e.g. `https://vouch-monad-backend.onrender.com`)
   - *(optional, defaults are fine)* `VITE_MONAD_RPC`, `VITE_CHAIN_ID=10143`,
     `VITE_WALLETCONNECT_PROJECT_ID` (enables WalletConnect/mobile)
4. **Deploy** → you get `https://vouch-monad.vercel.app`.

> `VITE_*` vars are inlined at **build time** — if you change `VITE_API`, **redeploy**.

---

## 3. Use it

Open the Vercel URL → **Enter app** → **Connect** MetaMask (Monad testnet) →
**Fund wallet** (mints mock USDC) → hire an agent. Wallet-signed hires settle on Monad.

## Security notes
- The backend holds the deployer + auditor private keys as **env vars** (never committed —
  `.env` is gitignored). Rotate them after the event.
- A public backend also exposes the **custodial** run path (backend pays), so anyone can
  spend the deployer's mock USDC + auditor gas. It's testnet — top up with
  `scripts/fund-auditor.ts` / the faucet if drained. To lock it down, disable the custodial
  branch in `server.ts` (`/api/run`) so only wallet-signed hires are accepted.
