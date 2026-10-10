"use client";

// Route Staffing Pre-Check panel — the compact, honest view of which PRESENT routes are under-assigned and
// therefore have their debrief on HOLD. Per the design (doc §2.2) a Connecteam work shift is NOT coverage:
// a route staffed only the old way (scheduled in Connecteam, never assigned in the app) shows here as a gap,
// and the Connecteam people are surfaced as the CANDIDATES to assign — never as coverage.
//
// Two ways to clear a gap: ASSIGN crew on the route board below (closes it automatically — no action here),
// or "Mark done" (an owner/admin ack for routes handled the old way / intentionally solo). All-clear shows
// an explicit OK state so the panel is honest when nothing is wrong.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, Loader2, Users } from "lucide-react";
import type { RoutePreCheck } from "@/lib/scheduling/preCheck";

const BTN =
  "inline-flex items-center gap-1.5 rounded border border-border px-2.5 py-1 text-[12px] text-tertiary-text transition-colors hover:bg-[var(--row-hover)] hover:text-foreground disabled:opacity-50 disabled:pointer-events-none";

export function StaffingPreCheck({
  routes,
  canManage,
}: {
  routes: RoutePreCheck[];
  canManage: boolean;
}): React.JSX.Element | null {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);

  if (routes.length === 0) return null; // no present routes → nothing to pre-check (page gates this too)

  const gaps = routes.filter((r) => r.status === "gap");
  const resolved = routes.filter((r) => r.status === "resolved");
  const okCount = routes.filter((r) => r.status === "ok").length;

  async function act(r: RoutePreCheck, action: "mark_done" | "reopen"): Promise<void> {
    setBusy(`${r.routeId}:${action}`);
    try {
      const res = await fetch("/api/scheduling/precheck", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ date: r.date, routeId: r.routeId, truckId: r.truckId, action }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      toast.success(action === "mark_done" ? `${r.truckName} marked done` : `${r.truckName} reopened`);
      router.refresh();
    } catch (e) {
      toast.error(`Could not update: ${e instanceof Error ? e.message : "error"}`);
    } finally {
      setBusy(null);
    }
  }

  function scrollToBoard(): void {
    document.getElementById("staffing-board")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <section className="mb-6 rounded-lg border border-border">
      <header className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <Users className="size-4 text-meta" />
        <h2 className="text-[13px] font-medium">Staffing pre-check</h2>
        <span className="text-[12px] text-meta">
          {gaps.length === 0
            ? `${routes.length} route${routes.length === 1 ? "" : "s"} checked`
            : `${gaps.length} route${gaps.length === 1 ? "" : "s"} on hold`}
        </span>
      </header>

      {gaps.length === 0 && resolved.length === 0 ? (
        <div className="flex items-center gap-2 px-4 py-3 text-[12.5px] text-meta">
          <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-400" />
          All {okCount} present route{okCount === 1 ? "" : "s"} have their crew assigned. Debriefs will send
          normally.
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {gaps.map((r) => (
            <li key={r.routeId} className="px-4 py-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <AlertTriangle className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
                    <span className="text-[13px] font-medium">{r.truckName}</span>
                    <span className="text-[12px] text-meta">
                      {r.stopCount} stop{r.stopCount === 1 ? "" : "s"} · {r.customerCount} customer
                      {r.customerCount === 1 ? "" : "s"}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[12.5px] text-foreground">{r.reason} — debrief held</p>
                  <p className="mt-0.5 text-[12px] text-meta">{candidateLine(r)}</p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <button type="button" className={BTN} onClick={scrollToBoard}>
                    Assign
                  </button>
                  {canManage && (
                    <button
                      type="button"
                      className={BTN}
                      disabled={busy != null}
                      onClick={() => void act(r, "mark_done")}
                    >
                      {busy === `${r.routeId}:mark_done` ? <Loader2 className="size-3.5 animate-spin" /> : null}
                      Mark done
                    </button>
                  )}
                </div>
              </div>
            </li>
          ))}
          {resolved.map((r) => (
            <li key={r.routeId} className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="size-4 text-meta" />
                <span className="text-[12.5px]">{r.truckName}</span>
                <span className="text-[12px] text-meta">marked done ({r.reason})</span>
              </div>
              {canManage && (
                <button
                  type="button"
                  className={BTN}
                  disabled={busy != null}
                  onClick={() => void act(r, "reopen")}
                >
                  {busy === `${r.routeId}:reopen` ? <Loader2 className="size-3.5 animate-spin" /> : null}
                  Reopen
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The honest candidate line: real names when Connecteam answered, a clear "unreachable" note when it did
 *  not (never "nobody could help"), and an Instawork hint when the schedule is reachable but nobody is free. */
function candidateLine(r: RoutePreCheck): string {
  if (!r.connecteamReachable) return "Connecteam unreachable — candidate list unknown.";
  if (r.connecteamCandidates.length === 0) return "No scheduled Connecteam crew free to assign (post a gig, or mark done).";
  const names = r.connecteamCandidates.slice(0, 6).map((c) => `${c.name} (${c.role})`).join(", ");
  const more = r.connecteamCandidates.length > 6 ? ` +${r.connecteamCandidates.length - 6} more` : "";
  return `Could assign: ${names}${more}`;
}
