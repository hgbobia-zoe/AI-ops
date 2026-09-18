// Event Radar — dashboard. On load it seeds the DEMO dataset if empty, then renders the operational
// figures + a ranked table of detected events with their derived intelligence (fit, planner, timing,
// next action). Filters are plain GET params so the page stays a server component. "Event Radar detects
// future demand; Sales OS converts it." Everything shown is derived deterministically from stored facts.

import Link from "next/link";
import { AutoRefresh } from "@/components/AutoRefresh";
import { RadarSeedButton } from "@/components/RadarSeedButton";
import { FigureStrip, tableCls, theadCls, thCls, type Figure } from "@/components/console-primitives";
import { SeedTag, ScorePill, TierBadge } from "@/components/radar-badges";
import { radarBoard, type RadarEventView } from "@/lib/radar/service";
import { seedRadarIfEmpty } from "@/lib/radar/seed";
import { CATEGORY_LABEL, type EventCategory, type OpportunityTier } from "@/lib/radar/types";
import { REGION_LABEL, type Region } from "@/lib/radar/geo";
import { viewerRole } from "@/lib/auth/getSession";
import { canManageSettings } from "@/lib/auth/roles";
import { todayInOpsTz, formatYmdLong } from "@/lib/dates";

export const dynamic = "force-dynamic";

const PHASE_LABEL: Record<string, string> = {
  TOO_EARLY: "Too early", PLANNING_WINDOW: "Planning window", OUTREACH_WINDOW: "Outreach window",
  ACTIVELY_SHOPPING: "Shopping vendors", IMMINENT: "Imminent", PAST: "Past", DATE_UNKNOWN: "Date TBD",
};
const PHASE_TONE: Record<string, string> = {
  OUTREACH_WINDOW: "text-positive", ACTIVELY_SHOPPING: "text-attention", IMMINENT: "text-critical",
  PLANNING_WINDOW: "text-tertiary-text", TOO_EARLY: "text-meta", PAST: "text-meta", DATE_UNKNOWN: "text-meta",
};
const PLANNER_TONE: Record<string, string> = { VERIFIED: "text-positive", INFERRED: "text-attention", UNKNOWN: "text-meta" };

function daysUntilLabel(date: string | null, today: string): string {
  if (!date) return "";
  const d = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  if (Number.isNaN(d)) return "";
  if (d < 0) return `${-d}d ago`;
  if (d === 0) return "today";
  return `in ${d}d`;
}

interface SP { tier?: string; category?: string; region?: string; verification?: string; q?: string }

function matches(r: RadarEventView, sp: SP): boolean {
  if (sp.tier && r.qualification.tier !== sp.tier) return false;
  if (sp.category && r.event.category !== sp.category) return false;
  if (sp.region && r.event.region !== sp.region) return false;
  if (sp.verification && r.event.verificationStatus !== sp.verification) return false;
  if (sp.q) {
    const hay = `${r.event.name} ${r.event.venue ?? ""} ${r.event.city ?? ""}`.toLowerCase();
    if (!hay.includes(sp.q.toLowerCase())) return false;
  }
  return true;
}

const TIER_CHIPS: (OpportunityTier | "ALL")[] = ["ALL", "HIGH", "MEDIUM", "LOW", "UNQUALIFIED"];

export default async function EventRadarPage({ searchParams }: { searchParams: Promise<SP> }): Promise<React.JSX.Element> {
  try {
    await seedRadarIfEmpty();
  } catch (e) {
    console.error("[radar] seed failed:", e);
  }
  const sp = await searchParams;
  const today = todayInOpsTz();
  const board = radarBoard(today);
  const rows = board.rows.filter((r) => matches(r, sp));
  const canManage = canManageSettings(await viewerRole());

  const m = board.metrics;
  const figures: Figure[] = [
    { label: "New (7d)", value: m.newlyDetected },
    { label: "High-fit", value: m.highFit, tone: m.highFit ? "positive" : "default" },
    { label: "Planners ID'd", value: m.plannersIdentified },
    { label: "Entering outreach", value: m.enteringOutreach, tone: m.enteringOutreach ? "attention" : "default", sep: true },
    { label: "Recurring", value: m.recurring },
    { label: "Opportunities", value: m.potentialOpportunities },
  ];

  // Build a query-string preserving the other active filters, for the tier chips.
  const chipHref = (tier: string) => {
    const p = new URLSearchParams();
    if (tier !== "ALL") p.set("tier", tier);
    if (sp.category) p.set("category", sp.category);
    if (sp.region) p.set("region", sp.region);
    if (sp.verification) p.set("verification", sp.verification);
    if (sp.q) p.set("q", sp.q);
    const s = p.toString();
    return s ? `/radar?${s}` : "/radar";
  };

  return (
    <main className="p-6">
      <AutoRefresh seconds={120} />
      <header className="mb-4 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[22px] font-medium tracking-tight">Event Radar</h1>
          <p className="text-[12.5px] text-meta">
            Early-demand intelligence for the DMV — detects future events, who&apos;s behind them, and which ones sales should act on now. Detects demand; Sales OS converts it.
          </p>
        </div>
        <FigureStrip figures={figures} />
      </header>

      {board.hasSeedData && (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded border border-border bg-foreground/[0.03] px-3 py-2 text-[12px] text-meta">
          <SeedTag />
          <span>Showing demo / seed data so the workflow can be evaluated — no live source is connected yet. Scores, tiers and timing are computed deterministically from these facts.</span>
          {canManage && <span className="ml-auto"><RadarSeedButton /></span>}
        </div>
      )}

      {/* Filters */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {TIER_CHIPS.map((t) => {
          const active = (t === "ALL" && !sp.tier) || sp.tier === t;
          return (
            <Link
              key={t}
              href={chipHref(t)}
              className={`rounded border px-2.5 py-1 text-[11.5px] font-medium uppercase tracking-[0.05em] transition-colors ${
                active ? "border-foreground bg-foreground/[0.08] text-foreground" : "border-border text-meta hover:bg-[var(--row-hover)] hover:text-foreground"
              }`}
            >
              {t === "ALL" ? "All tiers" : t}
            </Link>
          );
        })}
        <form method="GET" className="ml-auto flex flex-wrap items-center gap-2">
          {sp.tier && <input type="hidden" name="tier" value={sp.tier} />}
          <input
            name="q"
            defaultValue={sp.q ?? ""}
            placeholder="Search event / venue / city"
            className="w-52 rounded border border-border bg-transparent px-2.5 py-1 text-[12.5px] text-foreground placeholder:text-meta focus:border-foreground/40 focus:outline-none"
          />
          <select name="category" defaultValue={sp.category ?? ""} className="rounded border border-border bg-transparent px-2 py-1 text-[12.5px] text-foreground">
            <option value="">All types</option>
            {(Object.keys(CATEGORY_LABEL) as EventCategory[]).map((c) => (
              <option key={c} value={c} className="bg-background">{CATEGORY_LABEL[c]}</option>
            ))}
          </select>
          <select name="region" defaultValue={sp.region ?? ""} className="rounded border border-border bg-transparent px-2 py-1 text-[12.5px] text-foreground">
            <option value="">All areas</option>
            {(Object.keys(REGION_LABEL) as Region[]).map((rg) => (
              <option key={rg} value={rg} className="bg-background">{REGION_LABEL[rg]}</option>
            ))}
          </select>
          <select name="verification" defaultValue={sp.verification ?? ""} className="rounded border border-border bg-transparent px-2 py-1 text-[12.5px] text-foreground">
            <option value="">Any status</option>
            <option value="VERIFIED" className="bg-background">Verified</option>
            <option value="INFERRED" className="bg-background">Inferred</option>
            <option value="NOT_YET_VERIFIED" className="bg-background">Not yet verified</option>
            <option value="UNKNOWN" className="bg-background">Unknown</option>
          </select>
          <button type="submit" className="rounded border border-border px-2.5 py-1 text-[12px] text-tertiary-text transition-colors hover:bg-[var(--row-hover)] hover:text-foreground">Apply</button>
          <Link href="/radar" className="text-[12px] text-meta hover:text-foreground">Clear</Link>
        </form>
      </div>

      {/* Events table */}
      {rows.length === 0 ? (
        <p className="text-[13px] text-meta">No events match these filters.</p>
      ) : (
        <div className="overflow-x-auto border border-border">
          <table className={tableCls}>
            <colgroup>
              <col /><col style={{ width: "128px" }} /><col style={{ width: "150px" }} /><col style={{ width: "72px" }} />
              <col style={{ width: "96px" }} /><col style={{ width: "150px" }} /><col style={{ width: "170px" }} />
            </colgroup>
            <thead className={theadCls}>
              <tr>
                <th className={thCls}>Event</th>
                <th className={thCls}>Date</th>
                <th className={thCls}>Venue</th>
                <th className={`${thCls} text-right`}>Fit</th>
                <th className={thCls}>Planner</th>
                <th className={thCls}>Timing</th>
                <th className={thCls}>Next action</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const e = r.event;
                return (
                  <tr key={e.id} className="border-t border-[var(--row-rule)] transition-colors hover:bg-[var(--row-hover)]">
                    <td className="px-2.5 py-2.5">
                      <Link href={`/radar/${e.id}`} className="block">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-foreground hover:underline">{e.name}</span>
                          {e.isSeed && <SeedTag />}
                        </div>
                        <div className="truncate text-[12px] text-meta">{CATEGORY_LABEL[e.category]} · {e.sourceName ?? "—"}</div>
                      </Link>
                    </td>
                    <td className="px-2.5 py-2.5 text-[13px] tabular-nums text-tertiary-text">
                      {e.startDate ? <>{formatYmdLong(e.startDate)}<div className="text-[12px] text-meta">{daysUntilLabel(e.startDate, today)}</div></> : <span className="text-meta">TBD</span>}
                    </td>
                    <td className="px-2.5 py-2.5 text-[13px]">
                      <div className="truncate" title={e.venue ?? ""}>{e.venue ?? "—"}</div>
                      <div className="text-[12px] text-meta">{REGION_LABEL[e.region]}</div>
                    </td>
                    <td className="px-2.5 py-2.5 text-right">
                      <ScorePill score={r.qualification.rentalFitScore} tier={r.qualification.tier} />
                      <div className="text-[10.5px] uppercase"><TierBadge tier={r.qualification.tier} /></div>
                    </td>
                    <td className="px-2.5 py-2.5 text-[12.5px]">
                      <span className={PLANNER_TONE[e.plannerStatus]}>{e.plannerStatus === "UNKNOWN" ? "Unknown" : e.plannerStatus === "VERIFIED" ? "Verified" : "Inferred"}</span>
                    </td>
                    <td className="px-2.5 py-2.5 text-[12.5px]">
                      <span className={PHASE_TONE[r.timing.phase] ?? "text-meta"}>{PHASE_LABEL[r.timing.phase] ?? r.timing.phase}</span>
                    </td>
                    <td className="px-2.5 py-2.5 text-[12.5px] text-tertiary-text">
                      {e.salesStatus !== "NONE" ? <span className="text-positive">In Sales OS</span> : e.plannerStatus === "UNKNOWN" ? "Research organizer" : r.timing.recommendedAction}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-4 text-[11.5px] text-meta">
        {rows.length} of {board.rows.length} detected events. Fit &amp; tier are deterministic (rules calculate); provenance is shown on every fact. Planners, attendance and dates are never fabricated — unknown is shown as unknown.
      </p>
    </main>
  );
}
