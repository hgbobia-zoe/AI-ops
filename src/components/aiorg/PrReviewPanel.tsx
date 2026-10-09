"use client";

// In-app Pull Requests — review and MERGE PRs without leaving the app. Owner/admin only. A human clicks
// Merge; the server does it via the GitHub API. Shows CI/mergeability at a glance so you know what's safe.

import { useCallback, useEffect, useState } from "react";
import { GitPullRequest, Loader2, Check, AlertTriangle, RefreshCw, ExternalLink } from "lucide-react";

interface Pr {
  number: number;
  title: string;
  url: string;
  draft: boolean;
  author: string | null;
  checks: "passing" | "failing" | "pending" | "none";
  mergeableState: string;
}

const CHECK_META: Record<Pr["checks"], { label: string; cls: string }> = {
  passing: { label: "checks passing", cls: "text-positive bg-positive/10" },
  failing: { label: "checks failing", cls: "text-critical bg-critical/10" },
  pending: { label: "needs review / update", cls: "text-attention bg-attention/10" },
  none: { label: "no checks", cls: "text-tertiary-text bg-[var(--row-hover)]" },
};

export function PrReviewPanel(): React.JSX.Element {
  const [prs, setPrs] = useState<Pr[] | null>(null);
  const [configured, setConfigured] = useState(true);
  const [repo, setRepo] = useState("");
  const [busy, setBusy] = useState<number | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [tokenInput, setTokenInput] = useState("");
  const [connecting, setConnecting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/ai/github/prs");
      const j = await r.json();
      setConfigured(j.configured !== false);
      setRepo(j.repo ?? "");
      setPrs(Array.isArray(j.prs) ? j.prs : []);
    } catch {
      setMsg({ kind: "err", text: "Could not load pull requests." });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const merge = useCallback(async (number: number) => {
    setBusy(number); setMsg(null);
    try {
      const r = await fetch("/api/ai/github/merge", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ number }) });
      const j = await r.json().catch(() => ({}));
      if (r.ok) { setMsg({ kind: "ok", text: `Merged PR #${number}.` }); await load(); }
      else setMsg({ kind: "err", text: j.error ? `Could not merge #${number}: ${j.error}` : `Could not merge #${number}.` });
    } catch {
      setMsg({ kind: "err", text: "Could not reach the server." });
    } finally {
      setBusy(null);
    }
  }, [load]);

  const connect = useCallback(async () => {
    const token = tokenInput.trim();
    if (token.length < 20) { setMsg({ kind: "err", text: "That doesn't look like a valid token." }); return; }
    setConnecting(true); setMsg(null);
    try {
      const r = await fetch("/api/ai/github/token", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
      if (r.ok) { setTokenInput(""); setMsg({ kind: "ok", text: "Connected. Loading pull requests…" }); await load(); }
      else { const j = await r.json().catch(() => ({})); setMsg({ kind: "err", text: j.error ? `Could not connect: ${j.error}` : "Could not connect." }); }
    } catch {
      setMsg({ kind: "err", text: "Could not reach the server." });
    } finally {
      setConnecting(false);
    }
  }, [tokenInput, load]);

  return (
    <section className="surface border">
      <div className="flex items-center gap-2 px-3 py-2.5">
        <h2 className="flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-[0.06em] text-tertiary-text">
          <GitPullRequest className="size-4 text-meta" /> Pull requests
        </h2>
        {repo && <span className="font-mono text-[10.5px] text-meta">{repo}</span>}
        <button onClick={() => void load()} disabled={loading} className="ml-auto inline-flex items-center gap-1 text-[11px] text-meta transition-colors hover:text-foreground disabled:opacity-50">
          {loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />} refresh
        </button>
      </div>

      <div className="border-t border-border p-3">
        {!configured ? (
          <div className="space-y-2">
            <p className="text-[12px] text-meta">
              Connect GitHub to review and merge here. Paste a token — ideally a <strong className="text-secondary-text">fine-grained PAT</strong> scoped to this repo with <strong className="text-secondary-text">Pull requests: read/write</strong> only (so it can&apos;t touch branch protection even if leaked). It&apos;s stored write-only in the app.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="password"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                placeholder="github_pat_… or ghp_…"
                autoComplete="off"
                className="min-w-0 flex-1 rounded border border-border bg-[var(--panel)] px-2.5 py-1.5 font-mono text-[12px] text-foreground placeholder:text-meta focus:border-foreground/30 focus:outline-none"
              />
              <button onClick={connect} disabled={connecting || tokenInput.trim().length < 20} className="inline-flex items-center gap-1 rounded border border-[var(--gold)]/50 px-3 py-1.5 text-[12px] font-medium text-[var(--gold)] transition-colors hover:bg-[var(--gold)]/10 disabled:opacity-50">
                {connecting ? <Loader2 className="size-3.5 animate-spin" /> : null} Connect
              </button>
            </div>
          </div>
        ) : prs === null ? (
          <p className="text-[12px] text-meta">Loading…</p>
        ) : prs.length === 0 ? (
          <p className="text-[12px] text-meta">No open pull requests.</p>
        ) : (
          <ul className="space-y-2">
            {prs.map((p) => {
              const cm = CHECK_META[p.checks];
              return (
                <li key={p.number} className="flex items-start gap-2.5 rounded border border-border px-2.5 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[11px] text-meta">#{p.number}</span>
                      <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${cm.cls}`}>{cm.label}</span>
                      {p.draft && <span className="rounded bg-[var(--row-hover)] px-1.5 py-0.5 text-[10px] uppercase text-tertiary-text">draft</span>}
                      <a href={p.url} target="_blank" rel="noopener noreferrer" className="ml-auto inline-flex items-center gap-0.5 text-[11px] text-meta transition-colors hover:text-foreground">
                        GitHub <ExternalLink className="size-3" />
                      </a>
                    </div>
                    <p className="mt-0.5 truncate text-[12.5px] text-foreground">{p.title}</p>
                    {p.author && <p className="text-[11px] text-meta">by {p.author}</p>}
                  </div>
                  <button
                    onClick={() => merge(p.number)}
                    disabled={busy !== null || p.draft}
                    className="inline-flex shrink-0 items-center gap-1 self-center rounded border border-positive/50 px-2.5 py-1 text-[12px] font-medium text-positive transition-colors hover:bg-positive/10 disabled:opacity-50"
                  >
                    {busy === p.number ? <Loader2 className="size-3.5 animate-spin" /> : <GitPullRequest className="size-3.5" />} Merge
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {msg && (
          <p className={`mt-2.5 flex items-center gap-1 text-[12px] ${msg.kind === "ok" ? "text-positive" : "text-critical"}`}>
            {msg.kind === "ok" ? <Check className="size-3.5" /> : <AlertTriangle className="size-3.5" />} {msg.text}
          </p>
        )}
      </div>
    </section>
  );
}
