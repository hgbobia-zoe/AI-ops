// Event Portfolio — /events. "Where are we with every event." Owner/admin only; $ gated by role.
//
// Governing law: RULES CALCULATE, AI INTERPRETS, the UI RENDERS. Every lifecycle + condition shown here
// comes STRAIGHT from the engine (deriveLifecycle / computeEventReadiness via getEventReadiness); this page
// computes no state. The read is BOUNDED exactly like eventPortfolioSignal: enumerate the active pipeline
// with listEventRefs over a short window, CAP it, and resolve each event behind a per-event try/catch — so
// one unreadable event degrades a single row, never the page. Weather is resolved with a no-network stub
// (scoring many events must never fan out to Open-Meteo; weather is non-blocking, so BLOCKED/AT_RISK counts
// stay exact). Filtering + grouping are deterministic and server-side (searchParams), over the fetched set.

import Link from "next/link";
import { redirect } from "next/navigation";
import { CalendarCheck, ArrowRight } from "lucide-react";
import { viewerRole } from "@/lib/auth/getSession";
import { canManageSettings, canSeeFinancials } from "@/lib/auth/roles";
import { todayInOpsTz, shiftYmd, formatYmdLong } from "@/lib/dates";
import { listEventRefs } from "@/lib/event/adapter";
import { getEventReadiness } from "@/lib/event/resolvers";
import type { WeatherResult } from "@/lib/weather/types";
import {
  summarizePortfolio,
  filterPortfolio,
  sortPortfolio,
  groupPortfolio,
  daysUntil,
  type PortfolioRow,
  type PortfolioFilter,
  type GroupKey,
  type WindowFilter,
} from "@/lib/event/portfolio";
import type { EventCondition } from "@/lib/event/types";
import { LIFECYCLE_ORDER, type LifecycleState } from "@/lib/event/machine";
import { FigureStrip, tableCls, theadCls, thCls, type Figure } from "@/components/console-primitives";
import { LifecycleChip, ConditionChip } from "@/components/event/EventChips";

export const dynamic = "force-dynamic";

// Weather resolver that makes NO network call — portfolio scoring never fans out to Open-Meteo (mirrors
// manager.ts noNetworkWeather). Weather is a non-blocking requirement, so at most a WATCH is suppressed.
const noNetworkWeather = async (): Promise<WeatherResult> => ({ status: "UNAVAILABLE" });

const WINDOW_DAYS = 45;
const LOOKBACK_DAYS = 3; // catch very-recent, still-in-motion events
const CAP = 60;

function money(n: number | null): string {
  return n == null ? "—" : "$" + Math.round(n).toLocaleString("en-US");
}
function dayLabel(date: string | null, today: string): string {
  const d = daysUntil(date, today);
  if (d === null) return "—";
  if (d < 0) return `${-d}d ago`;
  if (d === 0) return "today";
  if (d === 1) return "tomorrow";
  return `in ${d}d`;
}

export default async function EventsPortfolioPage({
  searchParams,
}: {
  searchParams: Promise<{ group?: string; lifecycle?: string; condition?: string; window?: string }>;
}): Promise<React.JSX.Element> {
  const role = await viewerRole();
  if (!canManageSettings(role)) redirect("/dashboard");
  const canSee$ = canSeeFinancials(role);

  const sp = await searchParams;
  const today = todayInOpsTz();
  const window = { start: shiftYmd(today, -LOOKBACK_DAYS), end: shiftYmd(today, WINDOW_DAYS) };

  // ── BOUNDED + GUARDED resolve: enumerate the active pipeline, cap, resolve each behind try/catch ──
  const rows: PortfolioRow[] = [];
  let refsTotal = 0;
  try {
    const refs = listEventRefs({ window });
    refsTotal = refs.length;
    for (const ref of refs.slice(0, CAP)) {
      try {
        const bundle = await getEventReadiness(ref.id, { weather: noNetworkWeather });
        if (!bundle) continue;
        const value = canSee$ ? bundle.view.financials.revenue ?? bundle.view.commercial.grandTotal : null;
        rows.push({ ref: bundle.view.ref, lifecycle: bundle.lifecycleState, condition: bundle.readiness.condition, value });
      } catch {
        // one unreadable event never blanks the page
      }
    }
  } catch {
    // enumeration failed — render the empty state honestly
  }

  const summary = summarizePortfolio(rows, today);
  const figures: Figure[] = [
    { label: "Today", value: summary.today },
    { label: "Next 7 days", value: summary.next7 },
    { label: "At risk", value: summary.atRisk, tone: summary.atRisk ? "attention" : "default", sep: true },
    { label: "Blocked", value: summary.blocked, tone: summary.blocked ? "critical" : "default" },
    { label: "Ready", value: summary.ready, tone: summary.ready ? "positive" : "default" },
  ];

  // ── Deterministic, server-side filter + group over the fetched set ──
  const group = (["none", "lifecycle", "condition", "window"].includes(sp.group ?? "") ? sp.group : "window") as GroupKey;
  const filter: PortfolioFilter = {
    lifecycle: (sp.lifecycle as LifecycleState) || "all",
    condition: (sp.condition as EventCondition) || "all",
    window: (sp.window as WindowFilter) || "all",
  };
  const filtered = sortPortfolio(filterPortfolio(rows, filter, today), today);
  const groups = groupPortfolio(filtered, group, today);

  const hrefWith = (patch: Partial<Record<string, string>>): string => {
    const params = new URLSearchParams();
    const merged = { group, lifecycle: filter.lifecycle, condition: filter.condition, window: filter.window, ...patch };
    for (const [k, v] of Object.entries(merged)) if (v && v !== "all" && !(k === "group" && v === "window")) params.set(k, v as string);
    const qs = params.toString();
    return qs ? `/events?${qs}` : "/events";
  };

  const capped = refsTotal > CAP;

  return (
    <main className="p-6">
      <header className="mb-4 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-[22px] font-medium tracking-tight">
            <CalendarCheck className="size-5 text-meta" /> Event Portfolio
          </h1>
          <p className="text-[12.5px] text-meta">
            Where we are with every active event. {summary.total} event{summary.total === 1 ? "" : "s"} in the next {WINDOW_DAYS} days
            {capped ? ` (showing the first ${CAP} of ${refsTotal})` : ""}.
          </p>
        </div>
        <FigureStrip figures={figures} />
      </header>

      {/* Filter + group controls (deterministic, server-side via searchParams) */}
      <div className="mb-4 flex flex-col gap-2 text-[12px]">
        <FilterRow
          label="Group"
          options={[["window", "Date"], ["lifecycle", "Lifecycle"], ["condition", "Readiness"], ["none", "None"]]}
          current={group}
          hrefFor={(v) => hrefWith({ group: v })}
        />
        <FilterRow
          label="Window"
          options={[["all", "All"], ["overdue", "Overdue"], ["today", "Today"], ["next7", "Next 7"], ["next30", "Next 30"]]}
          current={filter.window ?? "all"}
          hrefFor={(v) => hrefWith({ window: v })}
        />
        <FilterRow
          label="Lifecycle"
          options={[["all", "All"], ...LIFECYCLE_ORDER.map((s) => [s, titleCase(s)] as [string, string])]}
          current={filter.lifecycle ?? "all"}
          hrefFor={(v) => hrefWith({ lifecycle: v })}
        />
        <FilterRow
          label="Readiness"
          options={[["all", "All"], ["ESCALATED", "Escalated"], ["BLOCKED", "Blocked"], ["AT_RISK", "At risk"], ["WATCH", "Watch"], ["NORMAL", "On track"]]}
          current={filter.condition ?? "all"}
          hrefFor={(v) => hrefWith({ condition: v })}
        />
      </div>

      {rows.length === 0 ? (
        <p className="text-[13px] text-meta">
          No active events resolved in this window. Events are reconstructed from Goodshuffle bookings — run an Auto-Pull if this looks wrong.
        </p>
      ) : filtered.length === 0 ? (
        <p className="text-[13px] text-meta">No events match the current filters.</p>
      ) : (
        <div className="flex flex-col gap-6">
          {groups.map((g) => (
            <section key={g.key}>
              {group !== "none" && (
                <h2 className="mb-1.5 text-[13px] font-medium uppercase tracking-[0.1em] text-tertiary-text">
                  {g.label} <span className="text-meta">· {g.rows.length}</span>
                </h2>
              )}
              <div className="overflow-x-auto border border-border">
                <table className={tableCls}>
                  <colgroup>
                    <col />
                    <col style={{ width: "120px" }} />
                    <col style={{ width: "150px" }} />
                    <col style={{ width: "140px" }} />
                    {canSee$ && <col style={{ width: "110px" }} />}
                    <col style={{ width: "44px" }} />
                  </colgroup>
                  <thead className={theadCls}>
                    <tr>
                      <th className={thCls}>Event</th>
                      <th className={thCls}>Date</th>
                      <th className={thCls}>Lifecycle</th>
                      <th className={thCls}>Readiness</th>
                      {canSee$ && <th className={`${thCls} text-right`}>Value</th>}
                      <th className={thCls}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.rows.map((r) => (
                      <tr key={String(r.ref.id)} className="border-t border-[var(--row-rule)] transition-colors hover:bg-[var(--row-hover)]">
                        <td className="px-2.5 py-2.5">
                          <Link href={`/events/${r.ref.id}`} className="block min-w-0">
                            <div className="truncate font-medium text-foreground">{r.ref.displayName || `Event ${r.ref.id}`}</div>
                            <div className="truncate text-[12px] text-meta">
                              {r.ref.customer || "—"}
                              {r.ref.venue ? ` · ${r.ref.venue}` : ""}
                            </div>
                          </Link>
                        </td>
                        <td className="px-2.5 py-2.5 align-top text-[13px] tabular-nums text-tertiary-text">
                          {r.ref.date ? (
                            <>
                              {formatYmdLong(r.ref.date)}
                              <div className="text-[12px] text-meta">{dayLabel(r.ref.date, today)}</div>
                            </>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="px-2.5 py-2.5 align-top">
                          <LifecycleChip state={r.lifecycle} />
                        </td>
                        <td className="px-2.5 py-2.5 align-top">
                          <ConditionChip condition={r.condition} />
                        </td>
                        {canSee$ && <td className="px-2.5 py-2.5 align-top text-right tabular-nums text-tertiary-text">{money(r.value)}</td>}
                        <td className="px-2.5 py-2.5 align-top">
                          <Link href={`/events/${r.ref.id}`} className="text-meta transition-colors hover:text-foreground" aria-label="Open event">
                            <ArrowRight className="size-4" />
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ))}
        </div>
      )}
    </main>
  );
}

function FilterRow({
  label,
  options,
  current,
  hrefFor,
}: {
  label: string;
  options: [string, string][];
  current: string;
  hrefFor: (value: string) => string;
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="w-[72px] shrink-0 text-[11px] uppercase tracking-[0.08em] text-meta">{label}</span>
      {options.map(([value, text]) => {
        const active = current === value;
        return (
          <Link
            key={value}
            href={hrefFor(value)}
            className={`rounded border px-2 py-0.5 text-[12px] transition-colors ${
              active ? "border-foreground/40 bg-foreground/[0.08] text-foreground" : "border-border text-tertiary-text hover:bg-[var(--row-hover)] hover:text-foreground"
            }`}
          >
            {text}
          </Link>
        );
      })}
    </div>
  );
}

function titleCase(s: string): string {
  return s.charAt(0) + s.slice(1).toLowerCase();
}
