// Prospecting worklist — "the 5 things to do today". Tiered cold-outreach tasks (call-first Tier A,
// email-sequence Tier B) with the script/copy inline and one-click outcome logging. Goodshuffle is not
// touched here; a reply moves the opportunity to ENGAGED for a human to convert.

import Link from "next/link";
import { RadarTabs } from "@/components/RadarTabs";
import { ProspectTaskActions } from "@/components/ProspectTaskActions";
import { ProspectExportButton } from "@/components/ProspectExportButton";
import { FigureStrip, type Figure } from "@/components/console-primitives";
import { ScorePill } from "@/components/radar-badges";
import { worklist, type WorklistCard } from "@/lib/prospecting/service";
import { seedOpportunitiesIfEmpty, refreshOpportunities } from "@/lib/opportunity/seed";
import { seedRadarIfEmpty } from "@/lib/radar/seed";
import { JURISDICTION_LABEL } from "@/lib/opportunity/types";
import { sequencerConfigured } from "@/lib/prospecting/sequencer";
import { apifyConfigured } from "@/lib/prospecting/enrich";
import { todayInOpsTz } from "@/lib/dates";

export const dynamic = "force-dynamic";

const CHANNEL_LABEL: Record<string, string> = { call: "Call", email: "Email", linkedin: "LinkedIn", task: "Task" };
const CHANNEL_TONE: Record<string, string> = { call: "text-positive", email: "text-attention", linkedin: "text-tertiary-text", task: "text-meta" };

function Card({ c }: { c: WorklistCard }): React.JSX.Element {
  const t = c.task;
  return (
    <div className={`border-t border-[var(--row-rule)] px-3 py-3 first:border-t-0 ${c.overdue ? "bg-[#251b22]" : ""}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className={`text-[11px] font-semibold uppercase tracking-[0.06em] ${CHANNEL_TONE[t.channel]}`}>{CHANNEL_LABEL[t.channel] ?? t.channel}</span>
        <span className="rounded border border-border px-1.5 py-px text-[10.5px] uppercase tracking-[0.05em] text-tertiary-text">Tier {c.tier}</span>
        <ScorePill score={c.opportunityScore} tier={c.opportunityScore >= 70 ? "HIGH" : c.opportunityScore >= 45 ? "MEDIUM" : "LOW"} />
        <Link href={`/radar/${c.opportunity.id}`} className="min-w-0 truncate font-medium text-foreground hover:underline">{c.opportunity.name}</Link>
        <span className="text-[12px] text-meta">{JURISDICTION_LABEL[c.opportunity.jurisdiction]}</span>
        {c.overdue && <span className="text-[11px] font-medium uppercase tracking-[0.05em] text-critical">overdue</span>}
        <span className="ml-auto text-[12px] tabular-nums text-meta">{t.dueAt}</span>
      </div>
      <div className="mt-1 text-[12.5px] text-tertiary-text">
        {c.entity ? <>Target: <span className="text-foreground">{c.entity.name}</span>{c.entity.email ? ` · ${c.entity.email}` : " · no email yet"}</> : "No target contact yet — research the organizer / prime"}
      </div>
      {t.script && <details className="mt-1 text-[12px] text-meta"><summary className="cursor-pointer text-tertiary-text">Call script</summary><p className="mt-1 whitespace-pre-wrap text-tertiary-text">{t.script}</p></details>}
      {t.subject && <details className="mt-1 text-[12px] text-meta"><summary className="cursor-pointer text-tertiary-text">Email · {t.subject}</summary><p className="mt-1 whitespace-pre-wrap text-tertiary-text">{t.body}</p></details>}
      <div className="mt-2"><ProspectTaskActions taskId={t.id} channel={t.channel as "call" | "email" | "linkedin" | "task"} /></div>
    </div>
  );
}

export default async function OutreachWorklistPage(): Promise<React.JSX.Element> {
  try { await seedRadarIfEmpty(); } catch { /* ignore */ }
  try { await seedOpportunitiesIfEmpty(); } catch { /* ignore */ }
  try { await refreshOpportunities(); } catch { /* ignore */ }

  const wl = worklist();
  const figures: Figure[] = [
    { label: "To do today", value: wl.counts.total, tone: wl.counts.total ? "attention" : "default" },
    { label: "Calls", value: wl.counts.call },
    { label: "Emails", value: wl.counts.email },
    { label: "Overdue", value: wl.overdue.length, tone: wl.overdue.length ? "critical" : "default", sep: true },
  ];

  return (
    <main className="p-6">
      <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div><h1 className="text-[22px] font-medium tracking-tight">Opportunity Radar</h1><p className="text-[12.5px] text-meta">Prospecting worklist — cold outreach before Goodshuffle. Tier A = call first, Tier B = email sequence.</p></div>
        <div className="flex items-center gap-3"><FigureStrip figures={figures} /><ProspectExportButton /></div>
      </header>
      <RadarTabs />

      <div className="mb-4 flex flex-wrap gap-3 text-[11.5px] text-meta">
        <span>Contact enrichment (Apify): <span className={apifyConfigured() ? "text-positive" : "text-meta"}>{apifyConfigured() ? "connected" : "off"}</span></span>
        <span>Email sequencer: <span className={sequencerConfigured() ? "text-positive" : "text-meta"}>{sequencerConfigured() ? "connected" : "CSV export only"}</span></span>
        <span className="text-meta">Today: {todayInOpsTz()}</span>
      </div>

      {wl.counts.total === 0 ? (
        <p className="text-[13px] text-meta">Nothing due. Route qualified opportunities from the dashboard into prospecting to build the worklist.</p>
      ) : (
        <>
          {wl.overdue.length > 0 && (
            <section className="mb-6">
              <h2 className="mb-1.5 text-[13px] font-medium uppercase tracking-[0.1em] text-critical">Overdue · {wl.overdue.length}</h2>
              <div className="border border-critical/25">{wl.overdue.map((c) => <Card key={c.task.id} c={c} />)}</div>
            </section>
          )}
          <section>
            <h2 className="mb-1.5 text-[13px] font-medium uppercase tracking-[0.1em] text-tertiary-text">Due today · {wl.due.length}</h2>
            {wl.due.length === 0 ? <p className="text-[13px] text-meta">Nothing else due today.</p> : <div className="border border-border">{wl.due.map((c) => <Card key={c.task.id} c={c} />)}</div>}
          </section>
        </>
      )}
    </main>
  );
}
