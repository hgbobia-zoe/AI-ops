// Runs — execution history + freshness, backed by the real runtime-jobs / import-ledger pattern
// (computeJobStatus-style derivation). An employee wired to a RUNTIME_JOBS entry shows its real
// last-run / state; browser-bucket dependence (Goodshuffle) stays honestly browser_pending. Owner/admin only.

import { redirect } from "next/navigation";
import { viewerRole } from "@/lib/auth/getSession";
import { canManageSettings } from "@/lib/auth/roles";
import { runtimeStatus, type JobState } from "@/lib/runtime/jobs";
import { OrgTabs } from "@/components/aiorg/AiOrgBits";
import { tableCls, theadCls, thCls } from "@/components/console-primitives";

export const dynamic = "force-dynamic";

const STATE_LABEL: Record<JobState, string> = {
  ok: "OK",
  stale: "Stale",
  error: "Error",
  not_configured: "Not configured",
  browser_pending: "Browser pending",
  never: "Never run",
};
const STATE_TONE: Record<JobState, string> = {
  ok: "text-positive",
  stale: "text-attention",
  error: "text-critical",
  not_configured: "text-meta",
  browser_pending: "text-tertiary-text",
  never: "text-meta",
};

function ago(ts: string | null): string {
  if (!ts) return "—";
  const min = Math.max(0, Math.round((Date.now() - Date.parse(ts)) / 60_000));
  if (!Number.isFinite(min)) return "—";
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

export default async function AiOrgRunsPage(): Promise<React.JSX.Element> {
  const role = await viewerRole();
  if (!canManageSettings(role)) redirect("/dashboard");

  let runs: ReturnType<typeof runtimeStatus> = [];
  try {
    runs = runtimeStatus();
  } catch {
    runs = [];
  }

  return (
    <main className="max-w-[1000px] p-6">
      <header className="mb-4">
        <h1 className="text-[22px] font-medium tracking-tight">Runs</h1>
        <p className="text-[12.5px] text-meta">Integration-job freshness from the import ledger. Server jobs run unattended; browser jobs (Goodshuffle) need a logged-in session.</p>
      </header>

      <OrgTabs active="/ai-org/runs" />

      {runs.length === 0 ? (
        <p className="border border-border px-3 py-3 text-[13px] text-muted-foreground">No runtime jobs reporting yet.</p>
      ) : (
        <div className="overflow-x-auto border border-border">
          <table className={tableCls}>
            <colgroup>
              <col style={{ width: "220px" }} />
              <col style={{ width: "100px" }} />
              <col style={{ width: "150px" }} />
              <col style={{ width: "120px" }} />
              <col />
            </colgroup>
            <thead className={theadCls}>
              <tr>
                <th className={thCls}>Job</th>
                <th className={thCls}>Bucket</th>
                <th className={thCls}>State</th>
                <th className={thCls}>Last run</th>
                <th className={thCls}>Detail</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.key} className="border-t border-[var(--row-rule)] hover:bg-[var(--row-hover)]">
                  <td className="px-2.5 py-2.5 text-[13px] font-medium">{r.label}</td>
                  <td className="px-2.5 py-2.5 text-[12px] uppercase tracking-[0.06em] text-meta">{r.bucket}</td>
                  <td className={`px-2.5 py-2.5 text-[12px] font-semibold uppercase tracking-[0.06em] ${STATE_TONE[r.state]}`}>{STATE_LABEL[r.state]}</td>
                  <td className="px-2.5 py-2.5 text-[12.5px] tabular-nums text-tertiary-text">{ago(r.lastRunAt)}</td>
                  <td className="px-2.5 py-2.5 text-[12.5px] text-meta">{r.lastDetail || r.note || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
