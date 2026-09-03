// Data Health — management's "can I trust these numbers?" view. Per-source state + the recent
// import ledger. Admin/Owner (under /admin, gated by the proxy).

import { HeartPulse, RefreshCw } from "lucide-react";
import { computeDataHealth, type HealthState } from "@/lib/health/health";
import { getRecentImports } from "@/lib/pull/state";

export const dynamic = "force-dynamic";

const STATE_STYLE: Record<HealthState, { label: string; cls: string }> = {
  FRESH: { label: "Fresh", cls: "border-emerald-500/40 text-emerald-300" },
  STALE: { label: "Stale", cls: "border-amber-500/40 text-amber-300" },
  INCOMPLETE: { label: "Incomplete", cls: "border-amber-500/40 text-amber-300" },
  RETRIEVAL_FAILED: { label: "Retrieval failed", cls: "border-red-500/50 text-red-300" },
  UNVERIFIED: { label: "Unverified", cls: "border-white/20 text-muted-foreground" },
  NEVER: { label: "No data", cls: "border-white/20 text-muted-foreground" },
};

const when = (iso: string): string => {
  try {
    return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  } catch {
    return iso;
  }
};

export default async function HealthPage(): Promise<React.JSX.Element> {
  const sources = computeDataHealth();
  const imports = getRecentImports(30);

  return (
    <main className="mx-auto max-w-3xl p-5 pb-16 md:p-8">
      <header className="mb-5">
        <h1 className="flex items-center gap-2 text-3xl font-bold tracking-tight">
          <HeartPulse className="size-7" /> Data Health
        </h1>
        <p className="text-sm text-muted-foreground">Can you trust these numbers? Freshness + errors per source.</p>
      </header>

      <section className="mb-8 space-y-2">
        {sources.map((s) => {
          const st = STATE_STYLE[s.state];
          return (
            <div key={s.key} className="flex items-start gap-3 border border-white/10 bg-white/[0.02] p-3.5">
              <span className={`shrink-0 border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${st.cls}`}>{st.label}</span>
              <div className="min-w-0 flex-1">
                <div className="font-medium">{s.label}</div>
                <div className="text-[12px] text-muted-foreground">
                  {s.detail}
                  {s.rows != null ? ` · ${s.rows} rows` : ""}
                </div>
              </div>
              <div className="shrink-0 text-right text-[11px] text-muted-foreground">
                {s.lastAt ? when(s.lastAt) : "—"}
                {s.ageH != null ? <div>{s.ageH}h ago</div> : null}
              </div>
            </div>
          );
        })}
      </section>

      <section className="space-y-2">
        <h2 className="flex items-center gap-2 text-lg font-semibold"><RefreshCw className="size-4" /> Recent imports</h2>
        {imports.length === 0 ? (
          <p className="text-sm text-muted-foreground">No imports recorded yet.</p>
        ) : (
          <div className="overflow-x-auto border border-white/10">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="p-2.5">When</th>
                  <th className="p-2.5">Source</th>
                  <th className="p-2.5">Result</th>
                  <th className="p-2.5 text-right">In / Written / Skipped</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {imports.map((r) => (
                  <tr key={r.id}>
                    <td className="p-2.5 text-muted-foreground">{when(r.ts)}</td>
                    <td className="p-2.5">{r.source}</td>
                    <td className="p-2.5">
                      <span className={r.ok ? "text-emerald-300" : "text-red-300"}>{r.ok ? "ok" : "failed/partial"}</span>
                      {r.detail ? <span className="text-muted-foreground"> · {r.detail}</span> : null}
                    </td>
                    <td className="p-2.5 text-right tabular-nums text-muted-foreground">
                      {r.rowsIn ?? "—"} / {r.rowsWritten ?? "—"} / {r.rowsSkipped ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
