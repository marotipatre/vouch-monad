import { useEffect, useRef, useState } from "react";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount, useChainId, useDisconnect, useSwitchChain } from "wagmi";
import { createWalletClient, createPublicClient, custom, http, parseEventLogs } from "viem";
import { api, premiumUsdc, evidenceUrl, type ApiAgent, type ClientHire, type RunResult, type TaskMeta } from "./api";
import { usdcAbi, insuranceAbi } from "./contracts";
import { monadTestnet, config } from "./providers";

type Health = { llm: boolean; provider: string; model: string | null; wallet: string; mock: boolean; network: string; chainId: number; usdc: string; insurance: string; treasury: string };

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [agents, setAgents] = useState<ApiAgent[]>([]);
  const [selId, setSelId] = useState<string>("");
  const [samples, setSamples] = useState<{ clean: string; tricky: string } | null>(null);
  const [input, setInput] = useState("");
  const [guarantee, setGuarantee] = useState(true);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);
  const [taskMeta, setTaskMeta] = useState<Record<string, TaskMeta>>({});
  const [activity, setActivity] = useState<{ ts: number; kind: string; label: string; tx: string }[]>([]);
  const [termLines, setTermLines] = useState<string[]>([]);
  const [rev, setRev] = useState<{ feesUsdc: number; premiumsUsdc: number; payoutsUsdc: number; slashedUsdc: number; netInsuranceUsdc: number; totalUsdc: number } | null>(null);
  const [funding, setFunding] = useState(false);
  const termRef = useRef<HTMLDivElement>(null);
  const meta = (tc: string) => taskMeta[tc];
  const refreshActivity = () => api.activity().then(setActivity).catch(() => {});
  const refreshRev = () => api.revenue().then(setRev).catch(() => {});

  // wallet (wagmi) — user-signed hires when on the real testnet
  const { address, isConnected } = useAccount();
  const { disconnectAsync } = useDisconnect();
  const chainId = useChainId();

  // Robust disconnect: RainbowKit's default config keeps the injected connector alive, so
  // disconnect() alone can be auto-reconnected. Disconnect the active connection AND every
  // configured connector, so it actually stays disconnected.
  async function fullDisconnect() {
    try { await disconnectAsync(); } catch { /* ignore */ }
    await Promise.all(config.connectors.map((c) => c.disconnect().catch(() => {})));
  }
  const { switchChainAsync } = useSwitchChain();
  const canSelfPay = isConnected && !!address && !!health && !health.mock && !!health.insurance;

  const selected = agents.find((a) => a.id === selId);
  const taskClass = selected?.taskClass ?? "route";
  const reliability = selected?.reliabilityBps ?? 9000;
  const fee = selected?.config?.feeUsdc ?? 5;
  const premium = premiumUsdc(fee, reliability);

  const refreshAgents = () => api.agents().then((a) => { setAgents(a); if (!selId && a[0]) setSelId(a[0].id); }).catch((e) => setErr(String(e)));

  useEffect(() => {
    api.health().then(setHealth).catch(() =>
      setErr(
        /^(localhost|127\.0\.0\.1)$/.test(location.hostname)
          ? "Backend not reachable on :8787 — start it with `MOCK=1 pnpm agents`."
          : "Backend waking up — retry in a moment.",
      ),
    );
    api.tasks().then(setTaskMeta).catch(() => {});
    refreshAgents();
    refreshActivity();
    refreshRev();
    const t = setInterval(() => { refreshActivity(); refreshRev(); }, 4000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!selected) return;
    api.samples(taskClass).then(setSamples).catch(() => {});
    setInput("");
    setResult(null);
  }, [selId, taskClass]);

  useEffect(() => { if (termRef.current) termRef.current.scrollTop = termRef.current.scrollHeight; }, [termLines]);

  // Build + sign the hire from the CONNECTED wallet (user pays). Approves USDC, calls
  // Insurance.hire, returns the payload the backend finishes (work → audit → resolve).
  //
  // Clients are fetched IMPERATIVELY (not via reactive hook data) after ensuring the
  // wallet is on Monad — so a wrong-network or not-yet-hydrated hook can't wrongly report
  // "wallet not connected".
  async function signHire(): Promise<ClientHire> {
    if (!selected || !health) throw new Error("no agent / backend");
    if (!isConnected || !address) throw new Error("connect a wallet first");

    const eth = (window as any).ethereum;
    if (!eth) throw new Error("no injected wallet (MetaMask) found");

    // ensure the wallet is on Monad testnet
    if (chainId !== health.chainId) {
      try { await switchChainAsync({ chainId: health.chainId }); }
      catch { throw new Error(`switch your wallet to Monad testnet (chain ${health.chainId})`); }
    }
    const wallet = createWalletClient({ account: address as `0x${string}`, chain: monadTestnet, transport: custom(eth) });
    const pub = createPublicClient({ chain: monadTestnet, transport: http() });

    const feeBase = BigInt(Math.round(fee * 1e6));
    const protocolFee = feeBase / 10n;
    const agentFee = feeBase - protocolFee;
    const coverage = guarantee ? feeBase : 0n;
    const premiumBase = guarantee ? BigInt(Math.round(fee * 1e6 * (1 - reliability / 10000) * 1.2)) : 0n;
    const total = protocolFee + premiumBase + agentFee;
    const usdc = health.usdc as `0x${string}`, insurance = health.insurance as `0x${string}`;
    setTermLines((l) => [...l, `HIRE  approve ~$${(Number(total) / 1e6).toFixed(2)} mUSDC + call insurance.hire in your wallet…`]);
    const approveHash = await wallet.writeContract({ address: usdc, abi: usdcAbi, functionName: "approve", args: [insurance, total] });
    await pub.waitForTransactionReceipt({ hash: approveHash });
    const hireHash = await wallet.writeContract({ address: insurance, abi: insuranceAbi, functionName: "hire", args: [BigInt(selected.id), taskClass, protocolFee, premiumBase, coverage, agentFee] });
    const receipt = await pub.waitForTransactionReceipt({ hash: hireHash });
    const ev = parseEventLogs({ abi: insuranceAbi, logs: receipt.logs, eventName: "Hired" })[0] as any;
    if (!ev) throw new Error("hire didn't create a policy — is your wallet funded with mUSDC?");
    return {
      policyId: String(ev.args.policyId),
      agentNetUsdc: Number(agentFee) / 1e6,
      protocolFeeUsdc: Number(protocolFee) / 1e6,
      premiumUsdc: Number(premiumBase) / 1e6,
      coverageUsdc: Number(coverage) / 1e6,
      userAddress: address,
      digest: hireHash,
    };
  }

  async function fund() {
    if (!address) return;
    setFunding(true); setErr(null);
    try { const f = await api.faucet(address); setTermLines((l) => [...l, `✓ funded your wallet with ${f.usdc} mUSDC`]); }
    catch (e) { setErr(String(e)); } finally { setFunding(false); }
  }

  async function run() {
    if (!selected) return;
    setRunning(true); setErr(null); setResult(null);
    try {
      // Validate/normalize the input BEFORE any on-chain payment — a bad input must never
      // cost a transaction or orphan a paid-for policy.
      const chk = await api.resolve(taskClass, input);
      if (chk.status === "none") throw new Error(chk.help || "Couldn't understand that input — click an example.");
      const resolvedInput = chk.input ?? input;

      setTermLines((l) => [...l, `$ run · ${selected.name} · ${meta(taskClass)?.label ?? taskClass}`]);
      let hire: ClientHire | undefined;
      if (canSelfPay) {
        hire = await signHire();
        setTermLines((l) => [...l, `  ✓ paid from your wallet · policy ${hire!.policyId}`]);
      }
      const r = await api.runStream({ agentId: selected.id, input: resolvedInput, withGuarantee: guarantee, hire }, (line) => setTermLines((l) => [...l.slice(-300), line]));
      setResult(r);
      await refreshAgents(); await refreshActivity(); await refreshRev();
    } catch (e) { setErr(String(e)); setTermLines((l) => [...l, `! ${String(e)}`]); }
    finally { setRunning(false); }
  }

  const passRate = selected && selected.jobs ? Math.round(((selected.jobs - selected.fails) / selected.jobs) * 100) : 100;
  const term = [
    `agentmonad trust terminal — ${health ? (health.mock ? "MOCK · in-memory" : health.network) + " · worker " + health.provider : "connecting…"}`,
    ...(termLines.length ? termLines.slice(-40) : ["idle · select an agent and Hire & run to stream live on-chain steps"]),
  ];

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-slate-950 text-slate-100" style={{ fontFamily: "'Inter',system-ui,sans-serif" }}>
      <header className="flex items-center justify-between border-b border-slate-800 px-4 py-2.5">
        <div className="flex items-center gap-3">
          <button onClick={() => { window.location.hash = ""; }} className="font-display text-base font-bold tracking-tight hover:text-indigo-300" title="Home">⬡ Agent <span className="text-violet-400">· Monad</span></button>
          {selected && <span className="rounded-md bg-slate-800 px-2 py-1 text-xs text-slate-200">{selected.name}</span>}
          {health && <span className={`rounded px-2 py-0.5 text-[10px] font-semibold uppercase ${health.mock ? "bg-amber-500/20 text-amber-300" : "bg-emerald-500/20 text-emerald-300"}`}>{health.mock ? "mock" : "testnet"}</span>}
        </div>
        <div className="flex items-center gap-2">
          {rev && (
            <div className="hidden rounded-lg border border-slate-800 bg-slate-900 px-3 py-1 text-right sm:block" title={`fees $${rev.feesUsdc} + underwriting $${rev.netInsuranceUsdc} (premiums $${rev.premiumsUsdc} − payouts $${rev.payoutsUsdc} + bonds recovered $${rev.slashedUsdc})`}>
              <div className="text-sm font-bold tabular-nums text-slate-100">${rev.totalUsdc.toFixed(2)}</div>
              <div className="text-[9px] uppercase tracking-wide text-slate-500">protocol revenue</div>
            </div>
          )}
          {canSelfPay && (
            <button onClick={fund} disabled={funding} className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-200 hover:border-indigo-500 hover:text-indigo-300 disabled:opacity-50">
              {funding ? "Funding…" : "Fund wallet"}
            </button>
          )}
          <ConnectButton showBalance={false} chainStatus="icon" accountStatus="avatar" />
          {isConnected && (
            <button onClick={fullDisconnect} title="Disconnect wallet" className="rounded-lg border border-slate-700 px-2.5 py-1.5 text-sm text-slate-300 hover:border-rose-500 hover:text-rose-300">
              Disconnect
            </button>
          )}
        </div>
      </header>

      {err && <div className="bg-rose-500/10 px-4 py-1 text-xs text-rose-300">{err}</div>}

      <div ref={termRef} className="mx-3 mt-3 h-28 shrink-0 overflow-auto rounded-xl border border-slate-800 bg-slate-950 p-3 font-mono text-[11px] leading-5 text-slate-400">
        {term.map((l, i) => <div key={i} className="whitespace-pre-wrap break-words">{`> ${l}`}</div>)}
        <span className="animate-pulse">▌</span>
      </div>

      <main className="grid min-h-0 flex-1 grid-cols-1 gap-3 p-3 lg:grid-cols-12">
        {/* Agents */}
        <Panel title="Agents" className="lg:col-span-5 lg:order-1" right={<span className="text-[10px] text-slate-500">{agents.length} listed</span>}>
          <div className="space-y-2">
            {[...agents].sort((a, b) => b.reliabilityBps - a.reliabilityBps).map((a) => {
              const open = a.id === selId;
              return (
                <div key={a.id} className={`overflow-hidden rounded-lg border ${open ? "border-indigo-400 bg-indigo-400/5" : "border-slate-800"}`}>
                  <button onClick={() => !running && setSelId(open ? "" : a.id)} className="flex w-full items-center gap-3 p-2.5 text-left hover:bg-slate-800/40">
                    <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 to-violet-500 text-xs font-bold text-white">{a.name[0]}</div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-slate-200">{a.name}</div>
                      <div className="truncate text-[11px] text-slate-500">{meta(a.taskClass)?.label} · {meta(a.taskClass)?.blurb}</div>
                    </div>
                    <div className="text-right">
                      <div className="text-sm font-bold tabular-nums text-slate-200">{(a.reliabilityBps / 100).toFixed(0)}%</div>
                      <div className="text-[10px] text-slate-500">${a.config?.feeUsdc ?? 5}/task</div>
                    </div>
                    <span className="text-slate-500">{open ? "▾" : "▸"}</span>
                  </button>
                  {open && (
                    <div className="space-y-3 border-t border-slate-800 p-3 text-xs">
                      <p className="leading-relaxed text-slate-300">{meta(a.taskClass)?.does}</p>
                      <div className="rounded-lg bg-slate-950 p-2">
                        <div className="text-[10px] uppercase tracking-wide text-slate-500">accepted input</div>
                        <div className="text-slate-300">{meta(a.taskClass)?.inputHint}</div>
                      </div>
                      <p className="text-slate-500"><b className="text-slate-400">Verified by:</b> {meta(a.taskClass)?.how}</p>
                      <div className="space-y-1">
                        <Row k="worker" v={a.config?.model ?? "—"} />
                        <Row k="bond staked" v={`$${a.bondUsdc}`} />
                        <Row k="jobs / fails" v={`${a.jobs} / ${a.fails}`} />
                        <Row k="owner" v={`${a.owner.slice(0, 6)}…${a.owner.slice(-4)}`} />
                      </div>
                      <PriceEditor agent={a} feeUsdc={a.config?.feeUsdc ?? 5} onSaved={refreshAgents} />
                    </div>
                  )}
                </div>
              );
            })}
            {!agents.length && <div className="text-sm text-slate-500">No agents — run <code>pnpm seed</code> (or start the backend with MOCK=1).</div>}
          </div>
        </Panel>

        {/* Hire + result */}
        <Panel title={`Hire ${selected?.name ?? ""}`} className="lg:col-span-4 lg:order-2" right={<span className="text-xs font-semibold text-indigo-300">${fee.toFixed(2)}/task</span>}>
          <div className="space-y-3">
            {samples && (samples.clean || samples.tricky) && (
              <div className="flex justify-end gap-1 text-[11px]">
                {samples.clean && <button disabled={running} onClick={() => setInput(samples.clean)} className="rounded px-2 py-0.5 text-slate-400 hover:bg-slate-800">example</button>}
                {samples.tricky && <button disabled={running} onClick={() => setInput(samples.tricky)} className="rounded px-2 py-0.5 text-slate-400 hover:bg-slate-800">hard example</button>}
              </div>
            )}
            <textarea value={input} onChange={(e) => setInput(e.target.value)} spellCheck={false} placeholder={meta(taskClass)?.inputHint}
              className="h-24 w-full resize-none rounded-xl border border-slate-700 bg-slate-950 p-2.5 font-mono text-[11px] text-slate-300" />
            {!!meta(taskClass)?.examples?.length && (
              <div className="flex flex-wrap gap-1">
                <span className="text-[10px] text-slate-600">try:</span>
                {meta(taskClass)!.examples!.map((ex, i) => (
                  <button key={i} disabled={running} onClick={() => setInput(ex)} className="max-w-[180px] truncate rounded-full border border-slate-700 px-2 py-0.5 text-[10px] text-slate-400 hover:border-indigo-500 hover:text-indigo-300">{ex}</button>
                ))}
              </div>
            )}
            <label className="flex cursor-pointer items-center justify-between text-xs">
              <span className="text-slate-300">Guarantee · refund ${fee} on fail <span className="text-slate-500">(premium ${premium.toFixed(2)})</span></span>
              <button onClick={() => setGuarantee(!guarantee)} className={`relative h-5 w-9 rounded-full transition ${guarantee ? "bg-indigo-500" : "bg-slate-600"}`}>
                <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition ${guarantee ? "left-[18px]" : "left-0.5"}`} />
              </button>
            </label>
            <button onClick={run} disabled={running || !selected || !input} className="w-full rounded-xl bg-gradient-to-r from-indigo-500 to-violet-500 px-4 py-2.5 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50">
              {running ? "Working on-chain…" : `Hire & run · $${(guarantee ? fee + premium : fee).toFixed(2)}`}
            </button>
            {result && <ResultChat r={result} />}

            {/* Reliability */}
            <div className="rounded-xl border border-slate-800 bg-slate-950 p-3">
              <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-slate-500">Reliability</div>
              <div className="flex justify-around">
                <Ring value={reliability / 100} label="reliability" />
                <Ring value={passRate} label="pass rate" tone="slate" />
              </div>
              <div className="mt-3 grid grid-cols-4 gap-2 text-center">
                <Tile k="jobs" v={`${selected?.jobs ?? 0}`} />
                <Tile k="fails" v={`${selected?.fails ?? 0}`} tone={selected?.fails ? "rose" : undefined} />
                <Tile k="price" v={`$${fee.toFixed(2)}`} />
                <Tile k="premium" v={`$${premium.toFixed(2)}`} />
              </div>
            </div>
          </div>
        </Panel>

        {/* Insurance + activity */}
        <Panel title="Insurance & activity" className="lg:col-span-3 lg:order-3">
          <div className="rounded-xl border border-slate-800 bg-slate-950 p-3">
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-slate-500">How you're protected</div>
            <ul className="space-y-1.5 text-[11px] text-slate-400">
              <li className="flex gap-2"><span className="text-indigo-400">•</span>Your fee is <b className="text-slate-200">escrowed</b>, not paid up front.</li>
              <li className="flex gap-2"><span className="text-indigo-400">•</span>Optional <b className="text-slate-200">guarantee</b> pays coverage from the reserve on fail.</li>
              <li className="flex gap-2"><span className="text-indigo-400">•</span>Agent's <b className="text-slate-200">bond is slashed</b> into the reserve when it fails.</li>
              <li className="flex gap-2"><span className="text-indigo-400">•</span>Reliability is a <b className="text-slate-200">performance record</b> — no market, no DeepBook.</li>
            </ul>
          </div>

          <div className="mt-3 border-t border-slate-800 pt-2">
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">Recent transactions</div>
            <div className="space-y-1">
              {activity.slice(0, 8).map((a, i) => (
                <a key={i} href={a.tx} target="_blank" rel="noreferrer" className="flex items-center justify-between gap-2 text-[11px] text-slate-400 hover:text-slate-200">
                  <span className="truncate"><span className="uppercase text-slate-500">{a.kind}</span> {a.label}</span>
                  <span className="shrink-0 text-indigo-400">↗</span>
                </a>
              ))}
              {!activity.length && <div className="text-[11px] text-slate-600">No transactions yet — hire an agent.</div>}
            </div>
          </div>
        </Panel>
      </main>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return <div className="flex justify-between"><span className="text-slate-500">{k}</span><span className="text-slate-300">{v}</span></div>;
}
function Tile({ k, v, tone }: { k: string; v: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950 py-2">
      <div className={`text-lg font-bold tabular-nums ${tone === "rose" ? "text-rose-400" : "text-slate-200"}`}>{v}</div>
      <div className="text-[10px] uppercase text-slate-500">{k}</div>
    </div>
  );
}
function Ring({ value, label, tone = "indigo" }: { value: number; label: string; tone?: string }) {
  const r = 26, c = 2 * Math.PI * r, pct = Math.max(0, Math.min(100, value));
  const stroke = tone === "slate" ? "#64748b" : tone === "rose" ? "#fb7185" : "#818cf8";
  return (
    <div className="flex flex-col items-center">
      <div className="relative h-16 w-16">
        <svg className="h-16 w-16 -rotate-90">
          <circle cx="32" cy="32" r={r} stroke="#1e293b" strokeWidth="5" fill="none" />
          <circle cx="32" cy="32" r={r} stroke={stroke} strokeWidth="5" fill="none" strokeDasharray={c} strokeDashoffset={c * (1 - pct / 100)} strokeLinecap="round" />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center text-sm font-bold">{Math.round(pct)}</div>
      </div>
      <div className="mt-1 text-[10px] text-slate-400">{label}</div>
    </div>
  );
}
function Panel({ title, right, children, className = "" }: { title: string; right?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <div className={`flex min-h-0 flex-col rounded-xl border border-slate-800 bg-slate-900/60 ${className}`}>
      <div className="flex shrink-0 items-center justify-between border-b border-slate-800 px-4 py-2.5">
        <span className="text-sm font-medium text-slate-200">{title}</span>
        {right}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4">{children}</div>
    </div>
  );
}

function FormattedResult({ taskClass, result }: { taskClass: string; result: any }) {
  if (!result) return <span className="text-slate-500">—</span>;
  const short = (a?: string | null) => (a ? `${a.slice(0, 8)}…${a.slice(-6)}` : "—");

  if (taskClass === "contract-audit") {
    const risky: string[] = result.risky ?? [];
    return risky.length ? (
      <div>
        <div className="mb-1 text-slate-400">{risky.length} dangerous op{risky.length > 1 ? "s" : ""} found:</div>
        <ul className="space-y-0.5">{risky.map((f, i) => <li key={i} className="font-mono text-rose-300">• {f}</li>)}</ul>
      </div>
    ) : <span className="text-slate-200">No dangerous low-level ops (SELFDESTRUCT / DELEGATECALL) found.</span>;
  }
  if (taskClass === "proxy-audit")
    return (
      <div className="space-y-1">
        <div className="flex justify-between"><span className="text-slate-400">Upgradeable proxy?</span><b className={result.isProxy ? "text-amber-300" : "text-emerald-300"}>{result.isProxy ? "Yes ⚠" : "No"}</b></div>
        <div className="flex justify-between"><span className="text-slate-400">Type</span><b className="text-slate-100">{result.kind}</b></div>
        {result.implementation && <div className="flex justify-between"><span className="text-slate-400">Implementation</span><code className="text-slate-200">{short(result.implementation)}</code></div>}
        {result.admin && <div className="flex justify-between"><span className="text-slate-400">Admin (can swap logic)</span><code className="text-amber-300">{short(result.admin)}</code></div>}
      </div>
    );
  if (taskClass === "selector-scan") {
    const sels: string[] = result.selectors ?? [];
    return (
      <div>
        <div className="mb-1 text-slate-400">Recovered {result.count ?? sels.length} function selector(s) from bytecode:</div>
        <div className="flex flex-wrap gap-1">{sels.map((s, i) => <span key={i} className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] text-slate-200">{s}</span>)}</div>
      </div>
    );
  }
  if (taskClass === "honeypot")
    return (
      <div className="space-y-1">
        <div className="flex justify-between"><span className="text-slate-400">Selling restricted?</span><b className={result.honeypot ? "text-rose-300" : "text-emerald-300"}>{result.honeypot ? "Yes — selling is blocked" : "No — freely transferable"}</b></div>
        <div className="text-[11px] text-slate-400">{result.reason}</div>
      </div>
    );
  return <pre className="whitespace-pre-wrap break-words text-slate-200">{JSON.stringify(result, null, 1)}</pre>;
}

function ResultChat({ r }: { r: RunResult }) {
  const fail = !r.verdict.pass;
  const tc = r.agent.before.taskClass;
  return (
    <div className="space-y-2 rounded-xl border border-slate-800 bg-slate-950 p-3 text-xs">
      {!fail ? (
        <>
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Result</span>
            <span className="rounded bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold text-emerald-300">✓ verified by auditor</span>
          </div>
          <div className="rounded-lg bg-slate-900 p-3 text-sm"><FormattedResult taskClass={tc} result={r.worker.result} /></div>
          <div className="text-[11px] text-slate-500">{r.verdict.reason} · agent earned ${r.hire.agentNetUsdc} · reliability {(r.agent.before.reliabilityBps / 100).toFixed(0)}→{(r.agent.after.reliabilityBps / 100).toFixed(0)}%</div>
        </>
      ) : (
        <>
          <div className="rounded-lg bg-rose-500/15 p-3">
            <div className="mb-0.5 font-bold text-rose-300">✗ Auditor rejected this result</div>
            <div className="text-slate-300">{r.verdict.reason}</div>
          </div>
          <div className="rounded-lg border border-rose-500/20 bg-emerald-500/5 p-2 text-[11px] text-slate-300">
            You were protected: <b className="text-slate-100">${r.hire.agentNetUsdc} refunded</b>{r.resolve.payoutUsdc > 0 ? <> + <b className="text-slate-100">${r.resolve.payoutUsdc} insurance paid</b></> : null}, agent earned <b className="text-slate-100">$0</b>, bond slashed <b className="text-slate-100">${r.resolve.slashedUsdc}</b>.
          </div>
          <details className="text-[11px] text-slate-500">
            <summary className="cursor-pointer">show the rejected output</summary>
            <div className="mt-1 rounded bg-slate-900 p-2"><FormattedResult taskClass={tc} result={r.worker.result} /></div>
          </details>
        </>
      )}
      <Proof r={r} />
    </div>
  );
}

// Self-explanatory proof: what the agent said vs what the auditor independently derived,
// the input hash, the evidence bundle, and a plain-English decode of the on-chain tx.
function Proof({ r }: { r: RunResult }) {
  const fail = !r.verdict.pass;
  const evUrl = r.evidence.stored ? evidenceUrl(r.evidence.id) : null;
  const onchain = fail
    ? `Auditor verdict FAIL was recorded on Monad. The contract refunded your $${r.hire.agentNetUsdc} fee${r.resolve.payoutUsdc > 0 ? `, paid $${r.resolve.payoutUsdc} insurance from the reserve` : ""}, and slashed $${r.resolve.slashedUsdc} of the agent's bond into the reserve.`
    : `Auditor verdict PASS was recorded on Monad. The contract released the escrowed $${r.hire.agentNetUsdc} fee to the agent and kept the $${r.hire.premiumUsdc} premium in the reserve.`;
  return (
    <details className="rounded-lg border border-slate-800 bg-slate-950/60" open>
      <summary className="cursor-pointer px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Proof — verified, not trusted</summary>
      <div className="space-y-2 px-3 pb-3 text-[11px]">
        {/* agent vs auditor */}
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded bg-slate-900 p-2">
            <div className="mb-1 text-[10px] uppercase text-slate-500">Agent computed</div>
            <pre className="whitespace-pre-wrap break-words text-slate-300">{JSON.stringify(r.worker.result, null, 1)}</pre>
          </div>
          <div className="rounded bg-slate-900 p-2">
            <div className={`mb-1 text-[10px] uppercase ${fail ? "text-rose-400" : "text-emerald-400"}`}>Auditor re-derived (ground truth)</div>
            <pre className="whitespace-pre-wrap break-words text-slate-300">{JSON.stringify(r.verdict.recomputed, null, 1)}</pre>
          </div>
        </div>

        {/* input hash + evidence bundle */}
        <div className="rounded bg-slate-900 p-2">
          <div className="flex items-center justify-between">
            <span className="text-slate-500">input sha256</span>
            <code className="text-slate-400">{r.evidence.inputHash.slice(0, 24)}…</code>
          </div>
          <div className="mt-1 flex items-center justify-between">
            <span className="text-slate-500">evidence bundle</span>
            {evUrl ? <a href={evUrl} target="_blank" rel="noreferrer" className="text-indigo-400 underline">view full JSON ↗</a> : <span className="text-slate-600">not stored</span>}
          </div>
          <p className="mt-1 text-[10px] leading-relaxed text-slate-500">The bundle (input, output, verdict) is content-addressed by this hash — and the same hash is written into the on-chain settlement, so the proof can't be swapped after the fact.</p>
        </div>

        {/* on-chain settlement, decoded */}
        <div className={`rounded p-2 ${fail ? "bg-rose-500/10" : "bg-emerald-500/10"}`}>
          <div className="mb-1 text-[10px] uppercase text-slate-400">What settled on-chain</div>
          <p className="leading-relaxed text-slate-300">{onchain}</p>
          <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px] text-slate-500">
            <span>verdict <b className={fail ? "text-rose-300" : "text-emerald-300"}>{fail ? "FAIL" : "PASS"}</b></span>
            <span>reliability <b className="text-slate-300">{(r.agent.before.reliabilityBps / 100).toFixed(0)}→{(r.agent.after.reliabilityBps / 100).toFixed(0)}%</b></span>
            <span>fee <b className="text-slate-300">${r.hire.agentNetUsdc}</b></span>
            <span>payout / slash <b className="text-slate-300">${r.resolve.payoutUsdc} / ${r.resolve.slashedUsdc}</b></span>
          </div>
          <div className="mt-2 flex flex-wrap gap-3">
            {r.hire.tx && <a href={r.hire.tx} target="_blank" rel="noreferrer" className="text-indigo-400 underline">hire tx ↗</a>}
            {r.resolve.tx && <a href={r.resolve.tx} target="_blank" rel="noreferrer" className="text-indigo-400 underline">settlement tx ↗</a>}
            <span className="ml-auto text-[10px] text-slate-600">worker: {r.worker.mode}</span>
          </div>
        </div>
      </div>
    </details>
  );
}

function PriceEditor({ agent, feeUsdc, onSaved }: { agent: ApiAgent; feeUsdc: number; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(String(feeUsdc));
  const [busy, setBusy] = useState(false);
  useEffect(() => setVal(String(feeUsdc)), [feeUsdc, agent.id]);
  async function save() {
    setBusy(true);
    try { await api.setPrice(agent.id, Number(val)); onSaved(); setEditing(false); } finally { setBusy(false); }
  }
  return (
    <div className="flex items-center justify-between rounded-xl border border-slate-700 bg-slate-900 px-4 py-2 text-sm">
      <span className="text-slate-400">Task price <span className="text-[11px] text-slate-600">(set by owner)</span></span>
      {editing ? (
        <span className="flex items-center gap-2">
          <span className="text-slate-500">$</span>
          <input type="number" min={0.1} step={0.1} value={val} onChange={(e) => setVal(e.target.value)} className="w-16 rounded border border-slate-700 bg-slate-950 px-2 py-0.5 text-sm" />
          <button disabled={busy} onClick={save} className="rounded bg-indigo-500 px-2 py-0.5 text-xs font-semibold text-white">save</button>
          <button onClick={() => setEditing(false)} className="text-xs text-slate-500">cancel</button>
        </span>
      ) : (
        <span className="flex items-center gap-2">
          <b className="text-slate-200">${feeUsdc.toFixed(2)}</b>
          <button onClick={() => setEditing(true)} className="text-xs text-indigo-400 hover:underline">edit</button>
        </span>
      )}
    </div>
  );
}
