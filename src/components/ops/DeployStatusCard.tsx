"use client";

// In-app DEPLOY STATUS card. After any merge/push to main a deploy follows; this card reflects it without
// leaving the app or opening GitHub. Fetches /api/ops/deploy-status on mount and auto-refreshes every ~20s
// so "deploying → deployed" moves on its own. Compact: a status pill with the right tone, the live
// short-commit + when it deployed, region, and a line for the last Deploy run with an external link.
// No secrets ever reach the client — the endpoint returns only build identity + status.

import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw, ExternalLink, Rocket, CheckCircle2, Clock, AlertTriangle, HelpCircle } from "lucide-react";

type Phase = "deploying" | "deployed" | "behind" | "failed" | "unknown";

interface DeployStatus {
  configured: boolean;
  live: { commit: string; deployedAt: string | null; startedAt: string; region: string | null };
  latestMainCommit: string | null;
  upToDate: boolean | null;
  lastDeploy: { status: string | null; conclusion: string | null; headSha: string | null; createdAt: string | null; htmlUrl: string | null } | null;
  phase: Phase;
  checkedAt: string;
}

const PHASE_META: Record<Phase, { label: string; cls: string; Icon: typeof Rocket; spin?: boolean }> = {
  deploying: { label: "Deploying", cls: "text-attention bg-attention/10", Icon: Loader2, spin: true },
  deployed: { label: "Deployed & healthy", cls: "text-positive bg-positive/10", Icon: CheckCircle2 },
  behind: { label: "Behind", cls: "text-attention bg-attention/10", Icon: Clock },
  failed: { label: "Deploy failed", cls: "text-critical bg-critical/10", Icon: AlertTriangle },
  unknown: { label: "Unknown", cls: "text-tertiary-text bg-[var(--row-hover)]", Icon: HelpCircle },
};

function shortSha(sha: string | null | undefined): string {
  const s = (sha || "").trim();
  if (!s || s === "unknown") return "unknown";
  return s.slice(0, 7);
}

function relTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const diff = Date.now() - t;
  const past = diff >= 0;
  const s = Math.abs(diff) / 1000;
  const fmt = (n: number, unit: string) => `${Math.round(n)}${unit} ${past ? "ago" : "from now"}`;
  if (s < 60) return "just now";
  if (s < 3600) return fmt(s / 60, "m");
  if (s < 86400) return fmt(s / 3600, "h");
  return fmt(s / 86400, "d");
}

export function DeployStatusCard(): React.JSX.Element {
  const [status, setStatus] = useState<DeployStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/ops/deploy-status", { cache: "no-store" });
      if (!r.ok) { setErr(true); return; }
      const j = (await r.json()) as DeployStatus;
      setStatus(j);
      setErr(false);
    } catch {
      setErr(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 20_000);
    return () => clearInterval(id);
  }, [load]);

  const phase = status?.phase ?? "unknown";
  const meta = PHASE_META[phase];
  const Icon = meta.Icon;

  return (
    <section className="surface border">
      <div className="flex items-center gap-2 px-3 py-2.5">
        <h2 className="flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-[0.06em] text-tertiary-text">
          <Rocket className="size-4 text-meta" /> Deploy status
        </h2>
        <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${meta.cls}`}>
          <Icon className={`size-3 ${meta.spin ? "animate-spin" : ""}`} /> {meta.label}
        </span>
        <button onClick={() => void load()} disabled={loading} className="ml-auto inline-flex items-center gap-1 text-[11px] text-meta transition-colors hover:text-foreground disabled:opacity-50">
          {loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />} refresh
        </button>
      </div>

      <div className="border-t border-border p-3">
        {status === null ? (
          err ? (
            <p className="flex items-center gap-1 text-[12px] text-critical"><AlertTriangle className="size-3.5" /> Could not load deploy status.</p>
          ) : (
            <p className="text-[12px] text-meta">Loading…</p>
          )
        ) : (
          <div className="space-y-2.5 text-[12.5px]">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="text-meta">Live build</span>
              <span className="font-mono text-foreground">{shortSha(status.live.commit)}</span>
              <span className="text-meta">
                {status.live.deployedAt ? `deployed ${relTime(status.live.deployedAt)}` : "deploy time unknown"}
              </span>
              {status.live.region && <span className="text-meta">· {status.live.region}</span>}
            </div>

            {status.configured ? (
              <>
                {status.upToDate === false && status.latestMainCommit && (
                  <p className="text-[12px] text-attention">
                    main is at <span className="font-mono">{shortSha(status.latestMainCommit)}</span> — not live yet.
                  </p>
                )}
                {status.lastDeploy ? (
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-border pt-2 text-[12px] text-meta">
                    <span>Last Deploy run:</span>
                    <span className="text-secondary-text">
                      {status.lastDeploy.status === "completed"
                        ? (status.lastDeploy.conclusion ?? "completed")
                        : (status.lastDeploy.status ?? "unknown")}
                    </span>
                    <span>· {relTime(status.lastDeploy.createdAt)}</span>
                    {status.lastDeploy.htmlUrl && (
                      <a href={status.lastDeploy.htmlUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-meta transition-colors hover:text-foreground">
                        view run <ExternalLink className="size-3" />
                      </a>
                    )}
                  </div>
                ) : (
                  <p className="border-t border-border pt-2 text-[12px] text-meta">No Deploy workflow runs found yet.</p>
                )}
              </>
            ) : (
              <p className="border-t border-border pt-2 text-[12px] text-meta">
                Connect GitHub (in Pull requests) to also show whether this build is current and how the last deploy went.
              </p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
