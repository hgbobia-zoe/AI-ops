// Opportunity Radar — the workspace. Two views over the same real records (no demo data):
//   • Board (Kanban, default): one column per pipeline step, so you see at a glance where every
//     opportunity stands: New → Researching → Outreach ready → Contacted → In Goodshuffle → Won / Lost.
//   • Table: one row per opportunity, sortable by score, value, event date, deadline, discovered, name.
// Filters (search, type, stage, timing, area, past events) and sort are plain GET params, so the page stays
// a server component and every view is linkable. Dollar values are only what a source stated (never
// estimated) and are shown to owners and admins only.

import Link from "next/link";
import { Radar } from "lucide-react";
import { AutoRefresh } from "@/components/AutoRefresh";
import { PageHeader, Toolbar } from "@/components/ui/page-header";
import { BladeMain } from "@/components/ui/layouts";
import { FigureStrip, type Figure, StatusMark, tableCls, theadCls, thCls } from "@/components/console-primitives";
import { ScorePill, VerificationBadge } from "@/components/radar-badges";
import { opportunityBoard, laneOf, type OpportunityView, type Lane } from "@/lib/opportunity/service";
import { seedOpportunitiesIfEmpty, refreshOpportunities } from "@/lib/opportunity/seed";
import { KIND_LABEL, JURISDICTION_LABEL, MATURITY_LABEL, STAGE_LABEL, type Jurisdiction, type LifecycleStage, type OpportunityKind, type SignalMaturity } from "@/lib/opportunity/types";
import { viewerRole } from "@/lib/auth/getSession";
import { canSeeFinancials } from "@/lib/auth/roles";
import { todayInOpsTz } from "@/lib/dates";
import { BladeAgents } from "@/components/aiorg/BladeAgents";

export const dynamic = "force-dynamic";

// Pipeline columns (Kanban) — each groups lifecycle stages into one readable step.
const COLUMNS: { key: string; label: string; stages: LifecycleStage[] }[] = [
  { key: "new", label: "New", stages: ["DISCOVERED", "VALIDATED", "RELEVANT"] },
  { key: "research", label: "Researching", stages: ["RESEARCHING", "TARGET_IDENTIFIED"] },
  { key: "ready", label: "Outreach ready", stages: ["OUTREACH_READY"] },
  { key: "contacted", label: "Contacted", stages: ["CONTACTED", "ENGAGED"] },
  { key: "goodshuffle", label: "In Goodshuffle", stages: ["OPPORTUNITY", "QUOTED"] },
  { key: "won", label: "Won", stages: ["WON"] },
  { key: "lost", label: "Lost / archived", stages: ["LOST", "ARCHIVED"] },
];
const columnOf = (stage: LifecycleStage) => COLUMNS.find((c) => c.stages.includes(stage))?.key ?? "new";

const LANE_LABEL: Record<Lane, string> = {
  OUTREACH_READY: "Act now",
  NEW_SIGNALS: "New signal",
  EARLY_SIGNALS: "Early (build relationship)",
  ACTIVE: "In sales process",
};

const MATURITY_MARK: Record<SignalMaturity, "critical" | "attention" | "idle"> = {
  IMMEDIATE: "critical",
  OPERATIONALLY_ACTIVE: "attention",
  PROCUREMENT_WINDOW: "attention",
  PLANNING: "idle",
  EARLY_SIGNAL: "idle",
  PAST: "idle",
  DATE_UNKNOWN: "idle",
};

type SortKey = "score" | "value" | "date" | "deadline" | "discovered" | "name";
const SORTS: { key: SortKey; label: string; defaultDir: "asc" | "desc" }[] = [
  { key: "score", label: "Score", defaultDir: "desc" },
  { key: "value", label: "Value (stated)", defaultDir: "desc" },
  { key: "date", label: "Event date", defaultDir: "asc" },
  { key: "deadline", label: "Deadline", defaultDir: "asc" },
  { key: "discovered", label: "Newest found", defaultDir: "desc" },
  { key: "name", label: "Name", defaultDir: "asc" },
];

interface SP { view?: string; kind?: string; jurisdiction?: string; q?: string; stage?: string; lane?: string; past?: string; sort?: string; dir?: string }

function fmtMoney(v: { low: number; high: number } | null): string | null {
  if (!v) return null;
  const f = (n: number) => (n >= 1000 ? `$${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : `$${Math.round(n)}`);
  return v.low === v.high ? f(v.high) : `${f(v.low)} to ${f(v.high)}`;
}

function fmtDate(ymd: string | null): string | null {
  if (!ymd) return null;
  const [y, m, d] = ymd.split("-").map(Number);
  if (!y || !m || !d) return ymd;
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d)));
}

function matches(v: OpportunityView, sp: SP): boolean {
  if (!sp.past && v.maturity.maturity === "PAST" && !["OPPORTUNITY", "QUOTED", "WON"].includes(v.stage)) return false;
  if (sp.kind && v.opp.kind !== sp.kind) return false;
  if (sp.jurisdiction && v.opp.jurisdiction !== sp.jurisdiction) return false;
  if (sp.stage && columnOf(v.stage) !== sp.stage) return false;
  if (sp.lane && laneOf(v) !== sp.lane) return false;
  if (sp.q) {
    const hay = `${v.opp.name} ${v.opp.organization ?? ""} ${v.opp.city ?? ""} ${v.primaryTarget?.edge.entity.name ?? ""}`.toLowerCase();
    if (!hay.includes(sp.q.toLowerCase())) return false;
  }
  return true;
}

/** PURE. Sort with nulls always last, whatever the direction. */
function sortRows(rows: OpportunityView[], key: SortKey, dir: "asc" | "desc"): OpportunityView[] {
  const val = (v: OpportunityView): string | number | null => {
    switch (key) {
      case "score": return v.score.opportunityScore;
      case "value": return v.value?.high ?? null;
      case "date": return v.opp.estimatedDate;
      case "deadline": return v.opp.deadline;
      case "discovered": return v.opp.discoveredAt;
      case "name": return v.opp.name.toLowerCase();
    }
  };
  const sign = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = val(a);
    const y = val(b);
    if (x == null && y == null) return b.score.opportunityScore - a.score.opportunityScore;
    if (x == null) return 1;
    if (y == null) return -1;
    if (x < y) return -1 * sign;
    if (x > y) return 1 * sign;
    return b.score.opportunityScore - a.score.opportunityScore;
  });
}

function Card({ v, money }: { v: OpportunityView; money: boolean }): React.JSX.Element {
  const e = v.opp;
  const when = e.estimatedDate ? fmtDate(e.estimatedDate) : e.deadline ? `due ${fmtDate(e.deadline)}` : "date unknown";
  const value = money ? fmtMoney(v.value) : null;
  return (
    <Link href={`/radar/${e.id}`} className="block rounded border border-border bg-background p-2.5 transition-colors hover:bg-row-hover">
      <div className="flex items-start gap-2">
        <ScorePill score={v.score.opportunityScore} tier={v.score.tier} />
        <span className="min-w-0 flex-1 text-[12.5px] font-medium leading-snug text-foreground">{e.name}</span>
      </div>
      <div className="mt-1 truncate text-[11.5px] text-secondary-text">{e.organization ?? "organizer unknown"}</div>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-meta">
        <span className="rounded border border-border px-1 py-px text-[10px] uppercase tracking-[0.04em]">{KIND_LABEL[e.kind]}</span>
        <span>{when}</span>
        {money && <span className={value ? "text-foreground" : ""}>{value ?? "No value data"}</span>}
      </div>
      <div className="mt-1.5"><StatusMark tone={MATURITY_MARK[v.maturity.maturity]} label={MATURITY_LABEL[v.maturity.maturity]} /></div>
    </Link>
  );
}

export default async function OpportunityRadarPage({ searchParams }: { searchParams: Promise<SP> }): Promise<React.JSX.Element> {
  try { await seedOpportunitiesIfEmpty(); } catch (e) { console.error("[opportunity] prepare:", e); }
  try { await refreshOpportunities(); } catch (e) { console.error("[opportunity] refresh:", e); }

  const sp = await searchParams;
  const view = sp.view === "table" ? "table" : "board";
  const sortKey: SortKey = (SORTS.find((s) => s.key === sp.sort)?.key ?? "score") as SortKey;
  const dir: "asc" | "desc" = sp.dir === "asc" || sp.dir === "desc" ? sp.dir : SORTS.find((s) => s.key === sortKey)!.defaultDir;
  const today = todayInOpsTz();
  const board = opportunityBoard(today);
  const money = canSeeFinancials(await viewerRole());

  const rows = sortRows(board.all.filter((v) => matches(v, sp)), sortKey, dir);
  const hiddenPast = sp.past ? 0 : board.all.filter((v) => v.maturity.maturity === "PAST" && !["OPPORTUNITY", "QUOTED", "WON"].includes(v.stage)).length;

  const figures: Figure[] = [
    { label: "Showing", value: rows.length },
    { label: "Act now", value: rows.filter((v) => laneOf(v) === "OUTREACH_READY").length, tone: "attention" },
    { label: "In Goodshuffle", value: rows.filter((v) => ["OPPORTUNITY", "QUOTED"].includes(v.stage)).length, sep: true },
    { label: "Won", value: rows.filter((v) => v.stage === "WON").length, tone: "positive" },
  ];

  const href = (patch: Partial<SP>) => {
    const p = new URLSearchParams();
    const merged = { ...sp, ...patch };
    for (const [k, val] of Object.entries(merged)) if (val) p.set(k, String(val));
    const s = p.toString();
    return s ? `/radar?${s}` : "/radar";
  };
  const sortHref = (key: SortKey) => {
    const def = SORTS.find((s) => s.key === key)!.defaultDir;
    const nextDir = sortKey === key ? (dir === "asc" ? "desc" : "asc") : def;
    return href({ sort: key, dir: nextDir });
  };
  const arrow = (key: SortKey) => (sortKey === key ? (dir === "asc" ? " ▲" : " ▼") : "");
  const selectCls = "rounded border border-input bg-transparent px-2 py-1 text-[12.5px] text-foreground";

  return (
    <BladeMain>
      <AutoRefresh seconds={180} />
      <PageHeader
        icon={<Radar className="size-5" />}
        title="Opportunity Radar"
        subtitle="Events, government bids and facility signals across the DMV: who is behind them and which ones to act on now. Real records only."
        actions={<FigureStrip figures={figures} />}
      />

      <BladeAgents blade="radar" className="mb-5" />

      <Toolbar className="mb-3">
        <div className="flex items-center gap-1 rounded border border-border p-0.5" role="group" aria-label="View">
          {(["board", "table"] as const).map((k) => (
            <Link key={k} href={href({ view: k === "board" ? undefined : k })} aria-current={view === k ? "true" : undefined} className={`rounded px-2.5 py-0.5 text-[12px] font-medium transition-colors ${view === k ? "bg-foreground/[0.1] text-foreground" : "text-meta hover:text-foreground"}`}>
              {k === "board" ? "Board" : "Table"}
            </Link>
          ))}
        </div>
        <span className="text-[11.5px] text-meta">{view === "board" ? "Columns = where each opportunity stands" : "Click a column header to sort"}</span>
      </Toolbar>

      <form method="GET" className="mb-4 flex flex-wrap items-center gap-2">
          {view === "table" && <input type="hidden" name="view" value="table" />}
          <input name="q" defaultValue={sp.q ?? ""} placeholder="Search name, org, contact" className="w-full rounded border border-input bg-transparent px-2.5 py-1 text-[12.5px] text-foreground placeholder:text-meta focus:border-ring focus:outline-none sm:w-52" />
          <select name="kind" defaultValue={sp.kind ?? ""} className={selectCls} aria-label="Type">
            <option value="">All types</option>
            {(Object.keys(KIND_LABEL) as OpportunityKind[]).map((k) => <option key={k} value={k} className="bg-background">{KIND_LABEL[k]}</option>)}
          </select>
          <select name="stage" defaultValue={sp.stage ?? ""} className={selectCls} aria-label="Stage">
            <option value="">All stages</option>
            {COLUMNS.map((c) => <option key={c.key} value={c.key} className="bg-background">{c.label}</option>)}
          </select>
          <select name="lane" defaultValue={sp.lane ?? ""} className={selectCls} aria-label="Timing">
            <option value="">Any timing</option>
            {(Object.keys(LANE_LABEL) as Lane[]).map((l) => <option key={l} value={l} className="bg-background">{LANE_LABEL[l]}</option>)}
          </select>
          <select name="jurisdiction" defaultValue={sp.jurisdiction ?? ""} className={selectCls} aria-label="Area">
            <option value="">All areas</option>
            {(Object.keys(JURISDICTION_LABEL) as Jurisdiction[]).map((j) => <option key={j} value={j} className="bg-background">{JURISDICTION_LABEL[j]}</option>)}
          </select>
          <select name="sort" defaultValue={sortKey} className={selectCls} aria-label="Sort by">
            {SORTS.map((s) => <option key={s.key} value={s.key} className="bg-background">Sort: {s.label}</option>)}
          </select>
          <select name="dir" defaultValue={dir} className={selectCls} aria-label="Order">
            <option value="desc" className="bg-background">High to low / newest</option>
            <option value="asc" className="bg-background">Low to high / soonest</option>
          </select>
          <label className="flex items-center gap-1 text-[12px] text-meta"><input type="checkbox" name="past" value="1" defaultChecked={!!sp.past} /> Past events</label>
          <button type="submit" className="rounded border border-border px-2.5 py-1 text-[12px] text-tertiary-text transition-colors hover:bg-row-hover hover:text-foreground">Apply</button>
          <Link href={view === "table" ? "/radar?view=table" : "/radar"} className="text-[12px] text-meta hover:text-foreground">Clear</Link>
      </form>

      {hiddenPast > 0 && <p className="mb-3 text-[11.5px] text-meta">{hiddenPast} past event{hiddenPast === 1 ? "" : "s"} hidden. Tick &quot;Past events&quot; to include them.</p>}

      {board.all.length === 0 ? (
        <p className="surface border border-border px-3 py-6 text-center text-[13px] text-meta">
          No opportunities yet. They arrive from SAM.gov once SAM_API_KEY is set, from event calendars (RADAR_ICS_FEEDS), or from <Link href="/radar/import" className="text-tertiary-text underline">an import</Link>.
        </p>
      ) : rows.length === 0 ? (
        <p className="surface border border-border px-3 py-6 text-center text-[13px] text-meta">Nothing matches these filters. <Link href="/radar" className="text-tertiary-text underline">Clear filters</Link></p>
      ) : view === "board" ? (
        <div className="overflow-x-auto pb-2">
          <div className="flex min-w-max gap-3">
            {COLUMNS.filter((c) => !sp.stage || sp.stage === c.key).map((c) => {
              const items = rows.filter((v) => columnOf(v.stage) === c.key);
              return (
                <section key={c.key} className="w-[260px] shrink-0 rounded border border-border bg-[var(--surface,transparent)] p-2" aria-label={c.label}>
                  <h2 className="mb-2 flex items-center justify-between px-0.5 text-[12px] font-medium uppercase tracking-[0.08em] text-tertiary-text">
                    <span>{c.label}</span><span className="tabular-nums text-meta">{items.length}</span>
                  </h2>
                  <div className="flex flex-col gap-2">
                    {items.length === 0 ? <p className="px-1 py-2 text-[11.5px] text-meta">None</p> : items.map((v) => <Card key={v.opp.id} v={v} money={money} />)}
                  </div>
                </section>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="surface overflow-x-auto border border-border">
          <table className={`${tableCls} min-w-[920px]`}>
            <thead className={theadCls}>
              <tr>
                <th className={thCls}><Link href={sortHref("score")} className="hover:text-foreground">Score{arrow("score")}</Link></th>
                <th className={thCls}><Link href={sortHref("name")} className="hover:text-foreground">Opportunity{arrow("name")}</Link></th>
                <th className={thCls}>Type</th>
                <th className={thCls}>Stage</th>
                <th className={thCls}>Timing</th>
                <th className={thCls}><Link href={sortHref("date")} className="hover:text-foreground">Event date{arrow("date")}</Link></th>
                <th className={thCls}><Link href={sortHref("deadline")} className="hover:text-foreground">Deadline{arrow("deadline")}</Link></th>
                {money && <th className={`${thCls} text-right`}><Link href={sortHref("value")} className="hover:text-foreground">Value{arrow("value")}</Link></th>}
                <th className={thCls}>Area</th>
                <th className={thCls}><Link href={sortHref("discovered")} className="hover:text-foreground">Source{arrow("discovered")}</Link></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((v) => (
                <tr key={v.opp.id} className="border-t border-[var(--row-rule)] hover:bg-row-hover">
                  <td className="px-2.5 py-2"><ScorePill score={v.score.opportunityScore} tier={v.score.tier} /></td>
                  <td className="max-w-[300px] px-2.5 py-2">
                    <Link href={`/radar/${v.opp.id}`} className="font-medium text-foreground hover:underline">{v.opp.name}</Link>
                    <div className="flex items-center gap-1.5 truncate text-[11.5px] text-meta">{v.opp.organization ?? "organizer unknown"} <VerificationBadge status={v.opp.verificationStatus} size="sm" /></div>
                  </td>
                  <td className="px-2.5 py-2 text-[12px] text-tertiary-text">{KIND_LABEL[v.opp.kind]}</td>
                  <td className="px-2.5 py-2 text-[12px] text-foreground">{STAGE_LABEL[v.stage]}</td>
                  <td className="px-2.5 py-2"><StatusMark tone={MATURITY_MARK[v.maturity.maturity]} label={MATURITY_LABEL[v.maturity.maturity]} /></td>
                  <td className="px-2.5 py-2 text-[12px] tabular-nums">{fmtDate(v.opp.estimatedDate) ?? <span className="text-meta">unknown</span>}</td>
                  <td className="px-2.5 py-2 text-[12px] tabular-nums">{fmtDate(v.opp.deadline) ?? <span className="text-meta">none</span>}</td>
                  {money && <td className="px-2.5 py-2 text-right text-[12px] tabular-nums">{fmtMoney(v.value) ?? <span className="text-meta">No value data</span>}</td>}
                  <td className="px-2.5 py-2 text-[12px] text-tertiary-text">{JURISDICTION_LABEL[v.opp.jurisdiction]}</td>
                  <td className="max-w-[160px] truncate px-2.5 py-2 text-[11.5px] text-meta" title={v.opp.sourceName ?? undefined}>{v.opp.sourceName ?? v.opp.sourceId ?? "unknown"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[11.5px] text-meta">
        <span>Scores and timing are rule based. Values appear only when a source states one; otherwise &quot;No value data&quot;.</span>
        <Link href="/radar/sources" className="text-tertiary-text hover:text-foreground">Manage sources →</Link>
      </div>
    </BladeMain>
  );
}
