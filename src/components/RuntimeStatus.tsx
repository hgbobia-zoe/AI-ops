"use client";

// Cloud runtime status — a read-only view of the unattended job runtime: each integration, whether it
// runs server-side or still needs a browser, and when it last ran. Client component (the /admin page is
// client) — fetches /api/runtime/status. Honest: "not configured" / "needs browser" shown as such.

import { useEffect, useState } from "react";
import type { JobState, JobStatus } from "@/lib/runtime/jobs";

const STATE_META: Record<JobState, { label: string; dot: string; text: string }> = {
  ok: { label: "OK", dot: "bg-positive", text: "text-positive" },
  stale: { label: "Stale", dot: "bg-attention", text: "text-attention" },
  error: { label: "Error", dot: "bg-critical", text: "text-critical" },
  not_configured: { label: "Not configured", dot: "bg-white/30", text: "text-meta" },
  never: { label: "Not run yet", dot: "bg-white/30", text: "text-meta" },
  browser_pending: { label: "Needs browser", dot: "bg-attention", text: "text-attention" },
};

function ago(iso: string | null): string {
  if (!iso) return "—";
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (mins < 60) return `${mins}m ago`;
  const h = Math.round(mins / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

export function RuntimeStatus(): React.JSX.Element {
  const [jobs, setJobs] = useState<JobStatus[] | null>(null);

  useEffect(() => {
    fetch("/api/runtime/status")
      .then((r) => r.json())
      .then((d: { jobs?: JobStatus[] }) => setJobs(d.jobs ?? []))
      .catch(() => setJobs([]));
  }, []);

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        The cloud runtime runs each server-side integration unattended on a schedule (GitHub Actions → Fly), so nothing
        depends on the office machine. Browser-only integrations (Goodshuffle) still need a logged-in browser until the
        cloud-browser path exists. Set <code>RUNTIME_TOKEN</code> (Fly secret + GitHub Actions secret) to start the clock.
      </p>
      <div className="overflow-hidden rounded-xl border border-white/10">
        <table className="w-full text-sm">
          <thead className="bg-white/[0.03] text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Integration</th>
              <th className="px-3 py-2 font-medium">Runtime</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Last run</th>
            </tr>
          </thead>
          <tbody>
            {jobs == null ? (
              <tr>
                <td className="px-3 py-3 text-muted-foreground" colSpan={4}>
                  Loading…
                </td>
              </tr>
            ) : (
              jobs.map((j) => {
                const m = STATE_META[j.state];
                return (
                  <tr key={j.key} className="border-t border-white/5 align-top">
                    <td className="px-3 py-2">
                      <div className="font-medium">{j.label}</div>
                      {j.note && <div className="mt-0.5 text-xs text-muted-foreground">{j.note}</div>}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">{j.bucket === "server" ? "Server" : "Browser"}</td>
                    <td className="px-3 py-2">
                      <span className={`inline-flex items-center gap-1.5 ${m.text}`}>
                        <span className={`size-1.5 rounded-full ${m.dot}`} /> {m.label}
                      </span>
                      {j.lastDetail && <div className="mt-0.5 text-xs text-muted-foreground">{j.lastDetail}</div>}
                    </td>
                    <td className="px-3 py-2 tabular-nums text-muted-foreground">{ago(j.lastRunAt)}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
