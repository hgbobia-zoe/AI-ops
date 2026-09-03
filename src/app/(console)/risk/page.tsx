// Event Risk Engine (MVP2) — the actionable management queue. On load it runs a (throttled)
// scan: assess the horizon → persist risks with lifecycle → recompute readiness → Slack only
// what changed. Then it renders a daily report + the CRITICAL/HIGH/MEDIUM/READY queue. A
// manager should grasp "what's at risk, why, who, and how urgent" in under 30 seconds.

import Link from "next/link";
import { ShieldAlert, ShieldCheck, AlertTriangle, RotateCcw, Clock, CircleDot, Check } from "lucide-react";
import { AutoRefresh } from "@/components/AutoRefresh";
import { RiskActions } from "@/components/RiskActions";
import { runScan } from "@/lib/risk/scan";
import { getRiskQueue, type StoredRisk } from "@/lib/risk/store";
import { getEventReadiness, getUnfinishedStops, getUpcomingCapacity, getUpcomingItemStops, type ReadinessView } from "@/lib/db/repo";
import { peakItemDemand } from "@/lib/inventory/inventory";
import { getEventTimeline } from "@/lib/history/store";
import { SEVERITY_RANK, type RiskSeverity } from "@/lib/risk/types";
import { todayInOpsTz, formatYmdLong } from "@/lib/dates";

export const dynamic = "force-dynamic";

// A CRITICAL/HIGH event never shows a "green" score — severity dominates the number so a
// high readiness value can't imply "good to go" over an operational failure.
function scoreColor(score: number, riskLevel: string): string {
  if (riskLevel === "CRITICAL") return "text-red-300";
  if (riskLevel === "HIGH") return "text-amber-300";
  return score >= 85 ? "text-emerald-300" : score >= 60 ? "text-amber-300" : "text-red-300";
}

function daysUntilLabel(date: string, today: string): string {
  const a = Date.parse(`${date}T00:00:00Z`);
  const b = Date.parse(`${today}T00:00:00Z`);
  const d = Math.round((a - b) / 86_400_000);
  if (Number.isNaN(d)) return "";
  if (d < 0) return `${-d}d ago`;
  if (d === 0) return "today";
  if (d === 1) return "tomorrow";
  return `in ${d}d`;
}

const SEV_STYLE: Record<RiskSeverity, string> = {
  CRITICAL: "bg-red-500/90 text-white",
  HIGH: "bg-amber-400 text-black",
  MEDIUM: "border border-amber-400/60 text-amber-300",
  LOW: "border border-white/20 text-muted-foreground",
};

export default async function EventRiskPage(): Promise<React.JSX.Element> {
  // Refresh the persisted queue (throttled). Never let a scan hiccup break the page — fall
  // back to the last-known queue from the DB.
  try {
    await runScan();
  } catch (e) {
    console.error("[risk] scan failed:", e);
  }
  const today = todayInOpsTz();
  const queue = getRiskQueue();
  const readiness = getEventReadiness();
  const unfinished = getUnfinishedStops();
  const capacity = getUpcomingCapacity(today).filter((v) => v.verdict !== "AVAILABLE");
  const itemDemand = peakItemDemand(getUpcomingItemStops(today)).slice(0, 8);

  const counts = {
    CRITICAL: queue.filter((r) => r.severity === "CRITICAL").length,
    HIGH: queue.filter((r) => r.severity === "HIGH").length,
    MEDIUM: queue.filter((r) => r.severity === "MEDIUM").length + queue.filter((r) => r.severity === "LOW").length,
    READY: readiness.filter((r) => r.riskLevel === "READY").length,
  };
  const top = queue.slice(0, 5);
  const bySev = (sev: RiskSeverity) => queue.filter((r) => r.severity === sev);

  return (
    <main className="mx-auto max-w-4xl p-5 pb-16 md:p-8">
      <AutoRefresh seconds={60} />

      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-3xl font-bold tracking-tight">
            <ShieldAlert className="size-7" /> Event Risk
          </h1>
          <p className="text-sm text-muted-foreground">
            Are we operationally ready for the next 14 days? {queue.length} open risk{queue.length === 1 ? "" : "s"}.
          </p>
        </div>
      </header>

      {queue.some((r) => r.riskType === "staffing_unverified") && (
        <div className="mb-6 flex items-start gap-2.5 border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-200">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>
            <strong>Staffing data is unavailable</strong> (Connecteam) for one or more days — those staffing checks are
            marked <em>unverified</em>, not confirmed clear. Reconnect Connecteam and re-scan for a complete picture.
          </span>
        </div>
      )}

      {/* Daily report — the 30-second read */}
      <section className="mb-8 grid grid-cols-4 gap-2">
        <Tally label="Critical" value={counts.CRITICAL} className="border-red-500/40 bg-red-500/10 text-red-200" />
        <Tally label="High" value={counts.HIGH} className="border-amber-400/40 bg-amber-400/10 text-amber-200" />
        <Tally label="Medium" value={counts.MEDIUM} className="border-white/15 bg-white/[0.04]" />
        <Tally label="Ready" value={counts.READY} className="border-emerald-500/30 bg-emerald-500/10 text-emerald-200" />
      </section>

      {top.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">Top priorities</h2>
          <ol className="space-y-1.5">
            {top.map((r, i) => (
              <li key={r.id} className="flex items-center gap-3 border border-white/5 bg-white/[0.02] p-2.5 text-sm">
                <span className="w-4 text-center font-bold text-muted-foreground">{i + 1}</span>
                <SevChip sev={r.severity} />
                <span className="flex-1 truncate">{r.title}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {r.date ? `${formatYmdLong(r.date)} · ${daysUntilLabel(r.date, today)}` : "—"}
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}

      {queue.length === 0 && (
        <div className="mb-8 flex items-center gap-2 border border-emerald-500/30 bg-emerald-500/10 p-4 text-sm text-emerald-200">
          <ShieldCheck className="size-5 shrink-0" /> No open risks in the next 14 days.
        </div>
      )}

      {(["CRITICAL", "HIGH", "MEDIUM", "LOW"] as RiskSeverity[])
        .filter((sev) => bySev(sev).length > 0)
        .map((sev) => (
          <RiskGroup key={sev} sev={sev} risks={bySev(sev)} today={today} />
        ))}

      {/* Capacity — can we physically execute each upcoming day? (surface-only) */}
      {capacity.length > 0 && (
        <section className="mb-8 space-y-2">
          <h2 className="text-lg font-semibold">Capacity outlook</h2>
          <div className="flex flex-wrap gap-2">
            {capacity.map((c) => {
              const cls =
                c.verdict === "CONSTRAINED"
                  ? "border-red-500/40 text-red-300"
                  : c.verdict === "TIGHT"
                    ? "border-amber-500/40 text-amber-300"
                    : "border-white/15 text-muted-foreground";
              return (
                <div key={c.date} className={`border px-2.5 py-1.5 text-xs ${cls}`} title={c.reasons.join("; ")}>
                  <span className="font-semibold">{c.date}</span> · {c.verdict}
                  {c.reasons.length ? <span className="text-muted-foreground"> — {c.reasons[0]}</span> : null}
                </div>
              );
            })}
          </div>
          <p className="text-[11px] text-muted-foreground">Derived from fleet, routes, windows &amp; crew. UNVERIFIED = Connecteam couldn&apos;t be checked; never blocks sales.</p>
        </section>
      )}

      {/* Inventory demand — concurrent booked quantity per item. Over-booking UNVERIFIED (no owned master). */}
      {itemDemand.length > 0 && (
        <section className="mb-8 space-y-2">
          <h2 className="text-lg font-semibold">Inventory demand · <span className="text-xs font-normal uppercase tracking-wide text-muted-foreground">capacity unverified</span></h2>
          <div className="overflow-x-auto border border-white/10">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="p-2.5">Item</th>
                  <th className="p-2.5 text-right">Peak booked / day</th>
                  <th className="p-2.5">Peak date</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {itemDemand.map((it) => (
                  <tr key={it.name}>
                    <td className="p-2.5">{it.name}</td>
                    <td className="p-2.5 text-right font-semibold tabular-nums">{it.peakQty}</td>
                    <td className="p-2.5 text-muted-foreground">{it.peakDate}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-muted-foreground">Concurrent quantity booked out per day from Goodshuffle line items. We can&apos;t flag over-booking without a verified owned-inventory count — this is demand, not a shortage.</p>
        </section>
      )}

      {/* Needs rescheduling — closed routes left with an unfinished stop (operational exception) */}
      {unfinished.length > 0 && (
        <section className="mb-8 space-y-2">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <RotateCcw className="size-4" /> Needs rescheduling
            <span className="bg-red-500/80 px-1.5 py-0.5 text-[10px] font-bold text-white">{unfinished.length}</span>
          </h2>
          <div className="space-y-1.5">
            {unfinished.map((s) => (
              <div key={s.stopId} className="flex flex-wrap items-center justify-between gap-2 border border-red-500/25 bg-red-500/[0.07] p-3 text-sm">
                <div>
                  <div className="font-medium">Stop #{s.sequence} · {s.custName || "—"}</div>
                  <div className="text-xs text-muted-foreground">{s.truckId} · {formatYmdLong(s.date)} · {s.state}</div>
                </div>
                <Link href="/dispatch" className="border border-white/15 px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground">
                  Open dispatch
                </Link>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Readiness by event — expand any row to see WHY (the operational checklist behind the score) */}
      {readiness.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold">Event readiness</h2>
          <div className="space-y-1.5">
            {readiness.map((e) => (
              <details key={e.eventId} className="border border-white/5 bg-white/[0.02] [&_summary]:list-none">
                <summary className="flex cursor-pointer items-center justify-between gap-3 p-2.5 text-sm hover:bg-white/[0.03]">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{e.label || `Event ${e.eventId}`}</div>
                    <div className="text-xs text-muted-foreground">{e.date ? formatYmdLong(e.date) : "—"} · why ▾</div>
                  </div>
                  <div className="flex items-center gap-2">
                    {e.riskLevel !== "READY" && <SevChip sev={e.riskLevel as RiskSeverity} />}
                    <span className={`font-bold tabular-nums ${scoreColor(e.score, e.riskLevel)}`}>{e.score}</span>
                  </div>
                </summary>
                <div className="border-t border-white/5 p-2.5">
                  <ReadinessChecklist event={e} queue={queue} />
                  <HistoryTrend eventId={e.eventId} />
                </div>
              </details>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}

// The operational checklist behind a readiness score — each area is ✓ unless an active risk
// affecting the event maps to it. This is the "why" the score is what it is.
const CHECK_AREAS: { label: string; types: Set<string> }[] = [
  {
    label: "Driver & helper (event day)",
    types: new Set(["route_no_driver", "driver_not_scheduled", "driver_shift_gap", "driver_double_booked", "driver_tight_buffer", "driver_shortage"]),
  },
  { label: "Prep & load crew (day before)", types: new Set(["warehouse_shortage"]) },
  { label: "Setup / install crew", types: new Set(["setup_crew_shortage"]) },
  { label: "Unload & clean (after pickup)", types: new Set(["unload_shortage"]) },
  { label: "Schedule & info", types: new Set(["route_schedule_unverified", "staffing_unverified"]) },
];

function ReadinessChecklist({ event, queue }: { event: ReadinessView; queue: StoredRisk[] }): React.JSX.Element {
  const affecting = queue.filter((r) => r.date === event.date && (!r.routeId || r.routeId === event.routeId));
  return (
    <ul className="space-y-1.5 text-sm">
      {CHECK_AREAS.map((area) => {
        const hits = affecting
          .filter((r) => area.types.has(r.riskType))
          .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
        const worst = hits[0];
        return (
          <li key={area.label} className="flex items-start gap-2">
            {worst ? (
              <span className={`mt-0.5 size-3.5 shrink-0 rounded-full ${worst.severity === "CRITICAL" ? "bg-red-500" : worst.severity === "HIGH" ? "bg-amber-400" : "bg-amber-400/60"}`} />
            ) : (
              <Check className="mt-0.5 size-3.5 shrink-0 text-emerald-400" />
            )}
            <span className={worst ? "" : "text-muted-foreground"}>
              {area.label}
              {worst ? (
                <span className="text-muted-foreground">
                  {" — "}
                  {worst.title}
                  {hits.length > 1 ? ` (+${hits.length - 1})` : ""}
                </span>
              ) : (
                <span className="text-emerald-300/70"> — OK</span>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

// Operational History (MVP4) — how this event's readiness/risk trended as it approached, from
// the deduped snapshot series. Only shows once there's more than one distinct snapshot.
function HistoryTrend({ eventId }: { eventId: string }): React.JSX.Element | null {
  const { snapshots } = getEventTimeline(eventId);
  if (snapshots.length < 2) return null;
  return (
    <div className="mt-2 border-t border-white/5 pt-2 text-xs text-muted-foreground">
      <span className="font-medium text-foreground/80">Trend:</span>{" "}
      {snapshots.map((sn, i) => (
        <span key={sn.id}>
          {i > 0 && " → "}
          {sn.daysOut >= 0 ? `${sn.daysOut}d out` : "event day"}: {sn.riskLevel}
          {sn.readinessScore != null ? ` (${sn.readinessScore})` : ""}
        </span>
      ))}
    </div>
  );
}

function Tally({ label, value, className }: { label: string; value: number; className: string }): React.JSX.Element {
  return (
    <div className={`border p-3 text-center ${className}`}>
      <div className="text-2xl font-bold tabular-nums">{value}</div>
      <div className="text-[11px] uppercase tracking-wide">{label}</div>
    </div>
  );
}

function SevChip({ sev }: { sev: RiskSeverity }): React.JSX.Element {
  return <span className={`shrink-0 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${SEV_STYLE[sev]}`}>{sev}</span>;
}

function RiskGroup({ sev, risks, today }: { sev: RiskSeverity; risks: StoredRisk[]; today: string }): React.JSX.Element {
  return (
    <section className="mb-6 space-y-2">
      <h2 className="flex items-center gap-2 text-lg font-semibold">
        {sev === "CRITICAL" ? <AlertTriangle className="size-4 text-red-400" /> : <CircleDot className="size-4 text-muted-foreground" />}
        {sev[0] + sev.slice(1).toLowerCase()} <span className="text-sm font-normal text-muted-foreground">({risks.length})</span>
      </h2>
      <div className="space-y-2">
        {risks.map((r) => (
          <div key={r.id} className="surface space-y-2 border border-white/5 p-3.5">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="flex items-center gap-2">
                <SevChip sev={r.severity} />
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{r.category}</span>
                {r.status !== "OPEN" && (
                  <span className="border border-white/15 px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">{r.status}</span>
                )}
              </div>
              <span className="text-xs text-muted-foreground">
                {r.date ? `${formatYmdLong(r.date)} · ${daysUntilLabel(r.date, today)}` : "—"}
              </span>
            </div>
            <div className="font-medium">{r.title}</div>
            <p className="text-sm text-muted-foreground">{r.description}</p>
            {r.recommendedAction && (
              <p className="text-sm">
                <span className="text-muted-foreground">→ </span>
                {r.recommendedAction}
              </p>
            )}
            <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
              <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                <Clock className="size-3" /> first seen {new Date(r.firstDetectedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
              </span>
              <RiskActions id={r.id} status={r.status} actionTarget={r.actionTarget} />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
