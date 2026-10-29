// Opportunity Radar — the opportunity WORKSPACE. On load it seeds the demo dataset if empty, bridges
// Event Radar events into the unified layer, and pulls any configured live connector (SAM.gov). Then it
// renders a concise header + scoped figures, a clear demo/source scope line, a lane/filter toolbar, and
// the prioritised opportunity list across the four signal lanes (§13): Outreach ready / New / Early /
// Active. Each opportunity shows WHO/WHAT/WHEN, the qualification basis, the next action and its source —
// all derived deterministically (rules calculate; AI interprets). Destination nav is the vertical
// sidebar (shell); only LOCAL view/filter controls live on the page. Filters are plain GET params so the
// page stays a server component.

import Link from "next/link";
import { Radar } from "lucide-react";
import { AutoRefresh } from "@/components/AutoRefresh";
import { OpportunitySeedButton } from "@/components/OpportunitySeedButton";
import { PageHeader, Toolbar } from "@/components/ui/page-header";
import { BladeMain } from "@/components/ui/layouts";
import { FigureStrip, type Figure, StatusMark } from "@/components/console-primitives";
import { SeedTag, ScorePill, TierBadge, VerificationBadge } from "@/components/radar-badges";
import { opportunityBoard, pastEventRationale, type OpportunityView, type Lane } from "@/lib/opportunity/service";
import { seedOpportunitiesIfEmpty, refreshOpportunities } from "@/lib/opportunity/seed";
import { seedRadarIfEmpty } from "@/lib/radar/seed";
import { KIND_LABEL, JURISDICTION_LABEL, MATURITY_LABEL, type Jurisdiction, type OpportunityKind, type SignalMaturity } from "@/lib/opportunity/types";
import { viewerRole } from "@/lib/auth/getSession";
import { canManageSettings } from "@/lib/auth/roles";
import { todayInOpsTz } from "@/lib/dates";
import { BladeAgents } from "@/components/aiorg/BladeAgents";

export const dynamic = "force-dynamic";

const LANES: { key: Lane; label: string; sub: string }[] = [
  { key: "OUTREACH_READY", label: "Outreach ready", sub: "a target is identified and the timing is right — act now" },
  { key: "NEW_SIGNALS", label: "New signals", sub: "freshly detected — triage and qualify" },
  { key: "EARLY_SIGNALS", label: "Early signals", sub: "long lead time or a repeat relationship — build early" },
  { key: "ACTIVE", label: "Active opportunities", sub: "in the sales process" },
];

// Timing status → shared status tone. Colour rides on the indicator; the label stays crisp.
const MATURITY_MARK: Record<SignalMaturity, "critical" | "attention" | "idle"> = {
  IMMEDIATE: "critical",
  OPERATIONALLY_ACTIVE: "attention",
  PROCUREMENT_WINDOW: "attention",
  PLANNING: "idle",
  EARLY_SIGNAL: "idle",
  PAST: "idle",
  DATE_UNKNOWN: "idle",
};

// Explanation of what the estimate amount means, so it is never read as total event spend / Zoe revenue.
const ESTIMATE_HELP =
  "Indicative Zoe-addressable rental value (what Zoe could rent into this), not the total event budget or contract value.";

function fmtRange(v: { low: number; high: number } | null): string {
  if (!v) return "—";
  const f = (n: number) => (n >= 1000 ? `$${Math.round(n / 1000)}k` : `$${n}`);
  return v.low === v.high ? f(v.high) : `${f(v.low)}–${f(v.high)}`;
}

/** Compact date WITH the year (the shared long format omits it); honest "date unknown" otherwise. */
function fmtDateYear(ymd: string | null): string | null {
  if (!ymd) return null;
  const [y, m, d] = ymd.split("-").map(Number);
  if (!y || !m || !d) return ymd;
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d)));
}

type DemoScope = "all" | "prod" | "demo";
function parseScope(v: string | undefined): DemoScope {
  return v === "prod" || v === "demo" ? v : "all";
}
function inScope(v: OpportunityView, scope: DemoScope): boolean {
  if (scope === "prod") return !v.opp.isSeed;
  if (scope === "demo") return v.opp.isSeed;
  return true;
}

interface SP { lane?: string; kind?: string; jurisdiction?: string; q?: string; min?: string; demo?: string }

function matches(v: OpportunityView, sp: SP): boolean {
  if (!inScope(v, parseScope(sp.demo))) return false;
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
  const why = v.score.positives[0]?.label ?? null;
  const dateYear = fmtDateYear(e.estimatedDate);
  const deadlineYear = fmtDateYear(e.deadline);
  const pastNote = pastEventRationale(v);

  return (
    <Link
      href={`/radar/${e.id}`}
      className="flex items-start gap-3 border-t border-rule px-3 py-3 transition-colors first:border-t-0 hover:bg-row-hover"
    >
      {/* Score + tier — the ranking number stays a white value; tier colour is on its dot. */}
      <div className="flex w-12 shrink-0 flex-col items-center gap-1 pt-0.5 text-center">
        <ScorePill score={v.score.opportunityScore} tier={v.score.tier} />
        <TierBadge tier={v.score.tier} />
      </div>

      <div className="min-w-0 flex-1">
        {/* Identity */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate font-medium text-foreground">{e.name}</span>
          {e.isSeed && <SeedTag />}
          <VerificationBadge status={e.verificationStatus} size="sm" />
        </div>

        {/* Facts: type · organization · jurisdiction · date (with year) · deadline */}
        <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[12px] text-meta">
          <span className="rounded border border-border px-1.5 py-px text-[10.5px] uppercase tracking-[0.04em] text-tertiary-text">{KIND_LABEL[e.kind]}</span>
          <span className="truncate text-secondary-text">{e.organization ?? "organizer unknown"}</span>
          <span aria-hidden>·</span>
          <span>{JURISDICTION_LABEL[e.jurisdiction]}</span>
          <span aria-hidden>·</span>
          <span>{dateYear ? `Event ${dateYear}` : "date unknown"}</span>
          {deadlineYear && (<><span aria-hidden>·</span><span className="text-status-label">due {deadlineYear}</span></>)}
        </div>

        {/* Timing status + qualification basis */}
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
          <StatusMark tone={MATURITY_MARK[v.maturity.maturity]} label={MATURITY_LABEL[v.maturity.maturity]} />
          {why && <span className="text-meta">Qualifies: <span className="text-secondary-text">{why}</span></span>}
        </div>

        {pastNote && <div className="mt-1 text-[11.5px] text-meta">{pastNote}</div>}

        {/* Next action */}
        <div className="mt-1.5 text-[12.5px] text-tertiary-text">→ {v.recommendedAction}</div>
      </div>

      {/* Estimate + target + source */}
      <div className="hidden w-44 shrink-0 text-right sm:block">
        <div className="text-[13px] tabular-nums text-foreground" title={v.value ? ESTIMATE_HELP : undefined}>
          {v.value?.indicative ? "~" : ""}{fmtRange(v.value)}
        </div>
        <div className="text-[10px] uppercase tracking-[0.05em] text-meta">
          {v.value ? "Est. Zoe rental" : "estimate pending"}
        </div>
        <div className="mt-1.5 truncate text-[12px] text-secondary-text" title={v.primaryTarget?.edge.entity.name}>
          {v.primaryTarget ? v.primaryTarget.edge.entity.name : "no target yet"}
        </div>
        <div className="truncate text-[11px] text-meta" title={e.sourceName ?? e.sourceId ?? undefined}>
          {e.sourceName ?? e.sourceId ?? "source unknown"}
        </div>
      </div>
    </Link>
  );
}

export default async function OpportunityRadarPage({ searchParams }: { searchParams: Promise<SP> }): Promise<React.JSX.Element> {
  try { await seedRadarIfEmpty(); } catch (e) { console.error("[radar] event seed:", e); }
  try { await seedOpportunitiesIfEmpty(); } catch (e) { console.error("[opportunity] seed:", e); }
  try { await refreshOpportunities(); } catch (e) { console.error("[opportunity] refresh:", e); }

  const sp = await searchParams;
  const scope = parseScope(sp.demo);
  const today = todayInOpsTz();
  const board = opportunityBoard(today);
  const canManage = canManageSettings(await viewerRole());

  // Demo vs production split — headline counts must state whether demo records are included.
  const demoTotal = board.all.filter((v) => v.opp.isSeed).length;
  const prodTotal = board.all.length - demoTotal;

  // Figures reflect the ACTIVE demo scope so the pipeline size is honest for the chosen scope.
  const scoped = board.all.filter((v) => inScope(v, scope));
  const qualified = scoped.filter((v) => v.score.tier !== "UNQUALIFIED").length;
  const outreachReady = scoped.filter((v) => board.lanes.OUTREACH_READY.includes(v)).length;
  const highValue = scoped.filter((v) => (v.value?.high ?? 0) >= 25000).length;
  const figures: Figure[] = [
    { label: "Discovered", value: scoped.length },
    { label: "Qualified", value: qualified, tone: qualified ? "positive" : "default" },
    { label: "Outreach ready", value: outreachReady, tone: outreachReady ? "attention" : "default", sep: true },
    { label: "$25k+ est.", value: highValue },
  ];

  const scopeNote =
    scope === "prod" ? "Production records only — demo excluded."
      : scope === "demo" ? "Demo / seed records only."
        : demoTotal > 0 ? `Includes ${demoTotal} demo record${demoTotal === 1 ? "" : "s"} alongside ${prodTotal} production.`
          : "Production records only — no demo data present.";

  const laneRows = (lane: Lane) => board.lanes[lane].filter((v) => matches(v, sp));
  const activeLaneFilter = sp.lane;

  const chipHref = (patch: Partial<SP>) => {
    const p = new URLSearchParams();
    const merged = { ...sp, ...patch };
    for (const [k, val] of Object.entries(merged)) if (val) p.set(k, String(val));
    const s = p.toString();
    return s ? `/radar?${s}` : "/radar";
  };

  const SCOPES: { key: DemoScope; label: string; count: number }[] = [
    { key: "all", label: "All", count: board.all.length },
    { key: "prod", label: "Production", count: prodTotal },
    { key: "demo", label: "Demo", count: demoTotal },
  ];

  return (
    <BladeMain>
      <AutoRefresh seconds={180} />
      <PageHeader
        icon={<Radar className="size-5" />}
        title="Opportunity Radar"
        subtitle="Events, procurement and facility signals across the DMV — who's behind them and which ones Sales should act on now. Detects demand; Sales OS converts it."
        actions={<FigureStrip figures={figures} />}
      />

      {/* Scope / provenance — concise and unmistakable; the seed warning is preserved, not hidden. */}
      <div className="surface mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 border border-border p-3 text-[12px]">
        {demoTotal > 0 && <SeedTag />}
        <span className="text-secondary-text">{scopeNote}</span>
        <span className="text-meta">Scores, tiers, timing and targets are computed deterministically; unknown is shown as unknown. SAM.gov is dormant until a key is set; browser-agent connectors feed in via the local extension.</span>
        {canManage && <span className="ml-auto"><OpportunitySeedButton /></span>}
      </div>

      <BladeAgents blade="radar" className="mb-5" />

      {/* Lane + scope + filter toolbar — LOCAL view controls only (destinations live in the sidebar). */}
      <Toolbar className="mb-3">
        <div className="flex flex-wrap items-center gap-2">
          {LANES.map((l) => {
            const active = sp.lane === l.key;
            return (
              <Link
                key={l.key}
                href={chipHref({ lane: active ? undefined : l.key })}
                className={`rounded border px-2.5 py-1 text-[11.5px] font-medium uppercase tracking-[0.05em] transition-colors ${active ? "border-foreground bg-foreground/[0.08] text-foreground" : "border-border text-meta hover:bg-row-hover hover:text-foreground"}`}
              >
                {l.label} · {laneRows(l.key).length}
              </Link>
            );
          })}
        </div>
      </Toolbar>

      <Toolbar className="mb-4">
        {/* Demo scope — the explicit filter that separates demo from production records. */}
        <div className="flex items-center gap-1 rounded border border-border p-0.5" role="group" aria-label="Record scope">
          {SCOPES.map((s) => {
            const active = scope === s.key;
            return (
              <Link
                key={s.key}
                href={chipHref({ demo: s.key === "all" ? undefined : s.key })}
                aria-current={active ? "true" : undefined}
                className={`rounded px-2 py-0.5 text-[11.5px] font-medium transition-colors ${active ? "bg-foreground/[0.1] text-foreground" : "text-meta hover:text-foreground"}`}
              >
                {s.label} · {s.count}
              </Link>
            );
          })}
        </div>
        <form method="GET" className="ml-auto flex flex-wrap items-center gap-2">
          {sp.lane && <input type="hidden" name="lane" value={sp.lane} />}
          {scope !== "all" && <input type="hidden" name="demo" value={scope} />}
          <input name="q" defaultValue={sp.q ?? ""} placeholder="Search name / org / target" className="w-52 rounded border border-input bg-transparent px-2.5 py-1 text-[12.5px] text-foreground placeholder:text-meta focus:border-ring focus:outline-none" />
          <select name="kind" defaultValue={sp.kind ?? ""} className="rounded border border-input bg-transparent px-2 py-1 text-[12.5px] text-foreground">
            <option value="">All types</option>
            {(Object.keys(KIND_LABEL) as OpportunityKind[]).map((k) => <option key={k} value={k} className="bg-background">{KIND_LABEL[k]}</option>)}
          </select>
          <select name="jurisdiction" defaultValue={sp.jurisdiction ?? ""} className="rounded border border-input bg-transparent px-2 py-1 text-[12.5px] text-foreground">
            <option value="">All jurisdictions</option>
            {(Object.keys(JURISDICTION_LABEL) as Jurisdiction[]).map((j) => <option key={j} value={j} className="bg-background">{JURISDICTION_LABEL[j]}</option>)}
          </select>
          <button type="submit" className="rounded border border-border px-2.5 py-1 text-[12px] text-tertiary-text transition-colors hover:bg-row-hover hover:text-foreground">Apply</button>
          <Link href="/radar" className="text-[12px] text-meta hover:text-foreground">Clear</Link>
        </form>
      </Toolbar>

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
              <p className="surface border border-border px-3 py-3 text-[12.5px] text-meta">Nothing here right now.</p>
            ) : (
              <div className="surface border border-border">
                {rows.map((v) => <OppRow key={v.opp.id} v={v} />)}
              </div>
            )}
          </section>
        );
      })}

      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[11.5px] text-meta">
        <span>Scores &amp; timing are deterministic (rules calculate); provenance is on every fact. Nothing is fabricated — unknown is shown as unknown.</span>
        <Link href="/radar/sources" className="text-tertiary-text hover:text-foreground">Manage sources →</Link>
      </div>
    </BladeMain>
  );
}
