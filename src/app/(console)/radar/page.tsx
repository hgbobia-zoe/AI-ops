// Opportunity Radar — dashboard. On load it seeds the demo dataset if empty, bridges Event Radar events
// into the unified layer, and pulls any configured live connector (SAM.gov). Then it renders the
// operational figures + the four signal lanes (§13): New Signals / Early Signals / Outreach Ready /
// Active. Each opportunity shows WHY it matters, WHO to contact, and the next action — deterministically
// derived. Filters are plain GET params so the page stays a server component.

import Link from "next/link";
import { AutoRefresh } from "@/components/AutoRefresh";
import { RadarTabs } from "@/components/RadarTabs";
import { OpportunitySeedButton } from "@/components/OpportunitySeedButton";
import { FigureStrip, type Figure } from "@/components/console-primitives";
import { SeedTag, ScorePill, TierBadge } from "@/components/radar-badges";
import { opportunityBoard, type OpportunityView, type Lane } from "@/lib/opportunity/service";
import { seedOpportunitiesIfEmpty, refreshOpportunities } from "@/lib/opportunity/seed";
import { seedRadarIfEmpty } from "@/lib/radar/seed";
import { KIND_LABEL, JURISDICTION_LABEL, MATURITY_LABEL, type Jurisdiction, type OpportunityKind } from "@/lib/opportunity/types";
import { viewerRole } from "@/lib/auth/getSession";
import { canManageSettings } from "@/lib/auth/roles";
import { todayInOpsTz, formatYmdLong } from "@/lib/dates";

export const dynamic = "force-dynamic";

const LANES: { key: Lane; label: string; sub: string }[] = [
  { key: "OUTREACH_READY", label: "Outreach ready", sub: "a target is identified and the timing is right — act now" },
  { key: "NEW_SIGNALS", label: "New signals", sub: "freshly detected — triage and qualify" },
  { key: "EARLY_SIGNALS", label: "Early signals", sub: "long lead time — build the relationship early" },
  { key: "ACTIVE", label: "Active opportunities", sub: "in the sales process" },
];

const MATURITY_TONE: Record<string, string> = {
  IMMEDIATE: "text-critical", OPERATIONALLY_ACTIVE: "text-attention", PROCUREMENT_WINDOW: "text-attention",
  PLANNING: "text-tertiary-text", EARLY_SIGNAL: "text-meta", PAST: "text-meta", DATE_UNKNOWN: "text-meta",
};

function fmtRange(v: { low: number; high: number } | null): string {
  if (!v) return "—";
  const f = (n: number) => (n >= 1000 ? `$${Math.round(n / 1000)}k` : `$${n}`);
  return v.low === v.high ? f(v.high) : `${f(v.low)}–${f(v.high)}`;
}

interface SP { lane?: string; kind?: string; jurisdiction?: string; q?: string; min?: string }

function matches(v: OpportunityView, sp: SP): boolean {
  if (sp.kind && v.opp.kind !== sp.kind) return false;
  if (sp.jurisdiction && v.opp.jurisdiction !== sp.jurisdiction) return false;
  if (sp.min && v.score.opportunityScore < Number(sp.min)) return false;
  if (sp.q) {
    const hay = `${v.opp.name} ${v.opp.organization ?? ""} ${v.opp.city ?? ""} ${v.primaryTarget?.edge.entity.name ?? ""}`.toLowerCase();
    if (!hay.includes(sp.q.toLowerCase())) return false;
  }
  return true;
}

function OppRow({ v }: { v: OpportunityView }): React.JSX.Element {
  const e = v.opp;
  return (
    <Link href={`/radar/${e.id}`} className="flex items-start gap-3 border-t border-[var(--row-rule)] px-3 py-2.5 transition-colors first:border-t-0 hover:bg-[var(--row-hover)]">
      <div className="w-10 shrink-0 text-center">
        <ScorePill score={v.score.opportunityScore} tier={v.score.tier} />
        <div className="text-[9.5px] uppercase tracking-[0.06em]"><TierBadge tier={v.score.tier} /></div>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium text-foreground">{e.name}</span>
          {e.isSeed && <SeedTag />}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[12px] text-meta">
          <span className="rounded border border-border px-1.5 py-px text-[10.5px] uppercase tracking-[0.04em] text-tertiary-text">{KIND_LABEL[e.kind]}</span>
          <span>{JURISDICTION_LABEL[e.jurisdiction]}</span>
          <span className={MATURITY_TONE[v.maturity.maturity] ?? "text-meta"}>{MATURITY_LABEL[v.maturity.maturity]}</span>
          {e.estimatedDate && <span>{formatYmdLong(e.estimatedDate)}</span>}
          {e.deadline && <span className="text-attention">due {formatYmdLong(e.deadline)}</span>}
        </div>
        <div className="mt-1 text-[12.5px] text-tertiary-text">→ {v.recommendedAction}</div>
      </div>
      <div className="hidden w-40 shrink-0 text-right sm:block">
        <div className="text-[13px] tabular-nums text-foreground">{fmtRange(v.value)}{v.value?.indicative ? <span className="text-[10px] text-meta"> ind.</span> : ""}</div>
        <div className="truncate text-[12px] text-meta" title={v.primaryTarget?.edge.entity.name}>{v.primaryTarget ? v.primaryTarget.edge.entity.name : "no target yet"}</div>
      </div>
    </Link>
  );
}

export default async function OpportunityRadarPage({ searchParams }: { searchParams: Promise<SP> }): Promise<React.JSX.Element> {
  try { await seedRadarIfEmpty(); } catch (e) { console.error("[radar] event seed:", e); }
  try { await seedOpportunitiesIfEmpty(); } catch (e) { console.error("[opportunity] seed:", e); }
  try { await refreshOpportunities(); } catch (e) { console.error("[opportunity] refresh:", e); }

  const sp = await searchParams;
  const today = todayInOpsTz();
  const board = opportunityBoard(today);
  const canManage = canManageSettings(await viewerRole());

  const m = board.metrics;
  const figures: Figure[] = [
    { label: "Discovered", value: m.discovered },
    { label: "Qualified", value: m.qualified, tone: m.qualified ? "positive" : "default" },
    { label: "Companies", value: m.companiesIdentified },
    { label: "Contacts", value: m.contactsIdentified, sep: true },
    { label: "Entering outreach", value: m.enteringOutreach, tone: m.enteringOutreach ? "attention" : "default" },
    { label: "$25k+", value: m.highValue },
  ];

  const laneRows = (lane: Lane) => board.lanes[lane].filter((v) => matches(v, sp));
  const activeLaneFilter = sp.lane;

  const chipHref = (patch: Partial<SP>) => {
    const p = new URLSearchParams();
    const merged = { ...sp, ...patch };
    for (const [k, val] of Object.entries(merged)) if (val) p.set(k, String(val));
    const s = p.toString();
    return s ? `/radar?${s}` : "/radar";
  };

  return (
    <main className="p-6">
      <AutoRefresh seconds={180} />
      <header className="mb-4 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[22px] font-medium tracking-tight">Opportunity Radar</h1>
          <p className="text-[12.5px] text-meta">Events, procurement and facility signals across the DMV — who&apos;s behind them, and which ones sales should act on now. Detects demand; Sales OS converts it.</p>
        </div>
        <FigureStrip figures={figures} />
      </header>

      <RadarTabs />

      {board.hasSeedData && (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded border border-border bg-foreground/[0.03] px-3 py-2 text-[12px] text-meta">
          <SeedTag />
          <span>Includes demo / seed data so the workflow is evaluable — SAM.gov is dormant until a key is set, and the browser-agent connectors feed in via the local extension. Scores, tiers, timing and targets are computed deterministically.</span>
          {canManage && <span className="ml-auto"><OpportunitySeedButton /></span>}
        </div>
      )}

      {/* Filters */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {LANES.map((l) => {
          const active = sp.lane === l.key;
          return (
            <Link key={l.key} href={chipHref({ lane: active ? undefined : l.key })} className={`rounded border px-2.5 py-1 text-[11.5px] font-medium uppercase tracking-[0.05em] transition-colors ${active ? "border-foreground bg-foreground/[0.08] text-foreground" : "border-border text-meta hover:bg-[var(--row-hover)] hover:text-foreground"}`}>
              {l.label} · {board.lanes[l.key].length}
            </Link>
          );
        })}
        <form method="GET" className="ml-auto flex flex-wrap items-center gap-2">
          {sp.lane && <input type="hidden" name="lane" value={sp.lane} />}
          <input name="q" defaultValue={sp.q ?? ""} placeholder="Search name / org / target" className="w-52 rounded border border-border bg-transparent px-2.5 py-1 text-[12.5px] text-foreground placeholder:text-meta focus:border-foreground/40 focus:outline-none" />
          <select name="kind" defaultValue={sp.kind ?? ""} className="rounded border border-border bg-transparent px-2 py-1 text-[12.5px] text-foreground">
            <option value="">All types</option>
            {(Object.keys(KIND_LABEL) as OpportunityKind[]).map((k) => <option key={k} value={k} className="bg-background">{KIND_LABEL[k]}</option>)}
          </select>
          <select name="jurisdiction" defaultValue={sp.jurisdiction ?? ""} className="rounded border border-border bg-transparent px-2 py-1 text-[12.5px] text-foreground">
            <option value="">All jurisdictions</option>
            {(Object.keys(JURISDICTION_LABEL) as Jurisdiction[]).map((j) => <option key={j} value={j} className="bg-background">{JURISDICTION_LABEL[j]}</option>)}
          </select>
          <button type="submit" className="rounded border border-border px-2.5 py-1 text-[12px] text-tertiary-text transition-colors hover:bg-[var(--row-hover)] hover:text-foreground">Apply</button>
          <Link href="/radar" className="text-[12px] text-meta hover:text-foreground">Clear</Link>
        </form>
      </div>

      {/* Lanes */}
      {LANES.filter((l) => !activeLaneFilter || activeLaneFilter === l.key).map((l) => {
        const rows = laneRows(l.key);
        return (
          <section key={l.key} className="mb-6">
            <h2 className="mb-1.5 flex items-baseline gap-2">
              <span className="text-[13px] font-medium uppercase tracking-[0.1em] text-tertiary-text">{l.label}</span>
              <span className="text-[11.5px] text-meta">· {l.sub}</span>
              <span className="ml-auto text-[12px] tabular-nums text-meta">{rows.length}</span>
            </h2>
            {rows.length === 0 ? (
              <p className="border border-border px-3 py-3 text-[12.5px] text-meta">Nothing here right now.</p>
            ) : (
              <div className="border border-border">
                {rows.map((v) => <OppRow key={v.opp.id} v={v} />)}
              </div>
            )}
          </section>
        );
      })}

      <div className="mt-2 flex items-center justify-between text-[11.5px] text-meta">
        <span>Scores &amp; timing are deterministic (rules calculate); provenance is on every fact. Nothing is fabricated — unknown is shown as unknown.</span>
        <Link href="/radar/sources" className="text-tertiary-text hover:text-foreground">Manage sources →</Link>
      </div>
    </main>
  );
}
