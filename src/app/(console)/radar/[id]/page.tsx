// Opportunity Radar — opportunity intelligence detail. The full picture for one opportunity (event,
// procurement or facility signal): WHY it matters (transparent score), WHO to contact (relationship
// graph + primary target + relationship memory), WHEN (maturity/timing), the lifecycle stage, the
// change history, and the Sales OS handoff. Everything derived deterministically; unknowns shown.

import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowUpRight, ExternalLink } from "lucide-react";
import { OpportunityActions } from "@/components/OpportunityActions";
import { OpportunityInterpret } from "@/components/OpportunityInterpret";
import { OpportunityOutreach } from "@/components/OpportunityOutreach";
import { VerificationBadge, TierBadge, ScorePill, SeedTag } from "@/components/radar-badges";
import { opportunityDetail } from "@/lib/opportunity/service";
import { getOpportunityChanges } from "@/lib/opportunity/store";
import { getCachedInterpretation } from "@/lib/opportunity/interpret";
import { getOutreachForOpportunity } from "@/lib/opportunity/outreachStore";
import { findRelated } from "@/lib/opportunity/fusion";
import { KIND_LABEL, JURISDICTION_LABEL, MATURITY_LABEL, STAGE_LABEL, STAGE_ORDER, RELATIONSHIP_LABEL, ENTITY_KIND_LABEL, ZOE_CATEGORY_LABEL } from "@/lib/opportunity/types";
import { stageProgress } from "@/lib/opportunity/lifecycle";
import { todayInOpsTz, formatYmdLong } from "@/lib/dates";

export const dynamic = "force-dynamic";

function Section({ title, children, note }: { title: string; children: React.ReactNode; note?: string }): React.JSX.Element {
  return (
    <section className="mb-6">
      <h2 className="mb-2 text-[13px] font-medium uppercase tracking-[0.1em] text-tertiary-text">{title}{note && <span className="ml-2 text-[11px] normal-case tracking-normal text-meta">{note}</span>}</h2>
      {children}
    </section>
  );
}
function Field({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return <div className="flex flex-col gap-0.5"><span className="text-[10.5px] uppercase tracking-[0.08em] text-meta">{label}</span><span className="text-[13.5px] text-foreground">{children}</span></div>;
}
function fmtRange(v: { low: number; high: number } | null): string {
  if (!v) return "unavailable";
  const f = (n: number) => (n >= 1000 ? `$${Math.round(n / 1000)}k` : `$${n}`);
  return v.low === v.high ? f(v.high) : `${f(v.low)}–${f(v.high)}`;
}

export default async function OpportunityDetailPage({ params }: { params: Promise<{ id: string }> }): Promise<React.JSX.Element> {
  const { id } = await params;
  const today = todayInOpsTz();
  const d = opportunityDetail(id, today);
  if (!d) notFound();
  const { opp: e, score: q, maturity, stage, entityMemos, value, procurement, awarded, awardee } = d;
  const changes = getOpportunityChanges(e.dedupeKey);
  const progress = stageProgress(stage);
  const interpretation = getCachedInterpretation(id);
  const outreach = getOutreachForOpportunity(id);
  const related = findRelated(id);
  const buyer = entityMemos.find((m) => m.edge.relationship === "DIRECT_BUYER" || m.edge.relationship === "PROCUREMENT_CONTACT")?.edge.entity.name ?? e.organization ?? null;
  const fmtMoney = (n: number | null) => (n == null ? null : `$${n.toLocaleString()}`);

  return (
    <main className="max-w-[1100px] p-6">
      <div className="mb-4 text-[12px] text-meta"><Link href="/radar" className="hover:text-foreground">Opportunity Radar</Link> / {e.name}</div>

      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="mb-1 flex items-center gap-2">
            <h1 className="text-[22px] font-medium tracking-tight">{e.name}</h1>
            {e.isSeed && <SeedTag />}
          </div>
          <p className="text-[13px] text-meta">{KIND_LABEL[e.kind]} · {JURISDICTION_LABEL[e.jurisdiction]} · {e.organization ?? "organizer unknown"}</p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="flex items-center gap-4">
            <div className="text-right"><div className="flex items-center justify-end gap-1.5"><ScorePill score={q.opportunityScore} tier={q.tier} /><span className="text-[12px] text-meta">/ 100</span></div><div className="text-[10.5px] uppercase tracking-[0.08em] text-meta">Opportunity</div></div>
            <div className="text-right"><div className="text-[15px] font-medium tabular-nums text-foreground">{q.relevanceScore}</div><div className="text-[10.5px] uppercase tracking-[0.08em] text-meta">Relevance</div></div>
            <div className="text-right"><TierBadge tier={q.tier} /><div className="text-[10.5px] uppercase tracking-[0.08em] text-meta">Tier</div></div>
          </div>
          <OpportunityActions id={e.id} stage={stage} salesStatus={e.salesStatus} bookingId={e.bookingId} />
        </div>
      </header>

      {/* Lifecycle progress */}
      <div className="mb-6">
        <div className="mb-1 flex items-center justify-between text-[11.5px] text-meta">
          <span>Lifecycle: <span className="font-medium text-foreground">{STAGE_LABEL[stage]}</span>{e.stageSource === "manual" ? " (set by a person)" : " (auto)"}</span>
          <span>{STAGE_ORDER.indexOf(stage) >= 0 ? `${STAGE_ORDER.indexOf(stage) + 1}/${STAGE_ORDER.length}` : stage}</span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded bg-[var(--bar)]"><div className="h-full bg-positive" style={{ width: `${Math.round(progress * 100)}%` }} /></div>
      </div>

      {/* Lead intelligence — source, awarding office, award status, procurement facts */}
      <Section title="Lead intelligence" note="where it came from, who's behind it, and where it stands">
        <div className="rounded border border-border p-3">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            {awarded ? (
              <span className="inline-flex items-center rounded border border-attention/40 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-attention">Awarded{awardee ? ` · ${awardee}` : ""}</span>
            ) : (
              <span className="inline-flex items-center rounded border border-positive/40 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-positive">Open{e.deadline ? "" : " · no deadline on file"}</span>
            )}
            {procurement?.noticeType && <span className="rounded border border-border px-2 py-0.5 text-[11px] uppercase tracking-[0.05em] text-tertiary-text">{procurement.noticeType.replace(/_/g, " ")}</span>}
            <span className="ml-auto">
              {e.sourceUrl ? (
                <a href={e.sourceUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 rounded border border-border px-2.5 py-1 text-[12px] text-tertiary-text transition-colors hover:bg-[var(--row-hover)] hover:text-foreground">Open original <ExternalLink className="size-3.5" /></a>
              ) : <span className="text-[12px] text-meta">no source link on file</span>}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Field label="Source">{e.sourceName ?? e.sourceId ?? "—"}</Field>
            <Field label="Awarding office / buyer">{buyer ?? <span className="text-meta">unknown</span>}</Field>
            <Field label="Award status">{awarded ? <span className="text-attention">Awarded{awardee ? ` to ${awardee}` : ""}</span> : <span className="text-positive">Open / not awarded</span>}</Field>
            {procurement && <Field label="Solicitation #">{procurement.solicitationNumber ?? "—"}</Field>}
            {procurement && <Field label="Response deadline">{procurement.responseDeadline ? formatYmdLong(procurement.responseDeadline) : e.deadline ? formatYmdLong(e.deadline) : "—"}</Field>}
            {procurement && <Field label="Posted">{procurement.postedDate ? formatYmdLong(procurement.postedDate) : "—"}</Field>}
            {procurement?.awardAmount != null && <Field label="Award amount">{fmtMoney(procurement.awardAmount)}</Field>}
            {procurement?.awardDate && <Field label="Award date">{formatYmdLong(procurement.awardDate)}</Field>}
            {procurement?.naics && <Field label="NAICS">{procurement.naics}</Field>}
            {procurement?.psc && <Field label="PSC / class">{procurement.psc}</Field>}
            {procurement?.setAside && <Field label="Set-aside">{procurement.setAside}</Field>}
          </div>
          {awarded && awardee && (
            <p className="mt-2 border-t border-[var(--row-rule)] pt-2 text-[12.5px] text-tertiary-text">This was awarded to <span className="font-medium text-foreground">{awardee}</span> — they may now be the right Zoe partner/customer to approach (a rental subcontract sits under the awarded event manager, not the government buyer).</p>
          )}
        </div>
      </Section>

      {/* AI interpretation */}
      <Section title="Interpretation" note="AI interprets; rules calculate — never fabricates a fact">
        <OpportunityInterpret id={id} initial={interpretation} />
      </Section>

      <div className="grid grid-cols-1 gap-x-8 lg:grid-cols-2">
        <div>
          {/* Why this matters */}
          <Section title="Why this matters" note="rules calculate — every point is a documented signal">
            <div className="rounded border border-border p-3 text-[13px]">
              <ul className="space-y-1">
                {q.positives.map((s) => <li key={s.key} className="flex items-center justify-between"><span><span className="text-positive">+</span> {s.label}</span><span className="tabular-nums text-meta">+{s.weight}</span></li>)}
                {q.negatives.map((s) => <li key={s.key} className="flex items-center justify-between"><span><span className="text-critical">−</span> {s.label}</span><span className="tabular-nums text-critical">{s.weight}</span></li>)}
              </ul>
              {q.unknowns.length > 0 && <div className="mt-2 border-t border-[var(--row-rule)] pt-2 text-meta">{q.unknowns.map((s) => <div key={s.key}>? {s.label} <span className="text-[11px]">— unknown, not counted</span></div>)}</div>}
              <div className="mt-2 flex items-center justify-between border-t border-[var(--row-rule)] pt-2"><span className="font-medium">Relevance</span><span><ScorePill score={q.relevanceScore} tier={q.tier} /> <span className="text-meta">/ 100 · {q.tier}</span></span></div>
              <p className="mt-2 text-[12px] text-meta">Estimated value: <span className="text-tertiary-text">{fmtRange(value)}</span>{value?.indicative ? " (indicative range, not a prediction)" : value ? " (from the source)" : " — need attendance or scope"}.</p>
            </div>
          </Section>

          {/* Facts */}
          <Section title="Opportunity">
            <div className="grid grid-cols-2 gap-3 rounded border border-border p-3">
              <Field label="Type">{KIND_LABEL[e.kind]}</Field>
              <Field label="Jurisdiction">{JURISDICTION_LABEL[e.jurisdiction]}</Field>
              <Field label="Event / project date">{e.estimatedDate ? formatYmdLong(e.estimatedDate) : "TBD"}</Field>
              <Field label="Deadline">{e.deadline ? formatYmdLong(e.deadline) : "—"}</Field>
              <Field label="Location">{[e.city, e.state].filter(Boolean).join(", ") || "—"}</Field>
              <Field label="Verification"><VerificationBadge status={e.verificationStatus} /></Field>
              <Field label="Zoe categories">{e.zoeCategories.length ? e.zoeCategories.map((c) => ZOE_CATEGORY_LABEL[c]).join(", ") : <span className="text-meta">not yet identified</span>}</Field>
              <Field label="Source">{e.sourceUrl ? <a href={e.sourceUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-tertiary-text hover:text-foreground">{e.sourceName ?? "source"} <ExternalLink className="size-3" /></a> : e.sourceName ?? "—"}</Field>
            </div>
            {e.description && <p className="mt-2 text-[13px] text-secondary-text">{e.description}</p>}
            {e.kind === "EVENT" && e.eventId && <Link href={`/radar/events/${e.eventId}`} className="mt-2 inline-flex items-center gap-1 text-[12.5px] text-tertiary-text hover:text-foreground">Full event intelligence (recurrence, planners) <ArrowUpRight className="size-3.5" /></Link>}
          </Section>
        </div>

        <div>
          {/* Who to contact */}
          <Section title="Who to contact" note="the recommended commercial path — publicly-available business info only">
            <div className="rounded border border-border p-3">
              {entityMemos.length === 0 ? (
                <p className="text-[13px]"><span className="font-medium text-meta">Target:</span> <span className="uppercase tracking-[0.06em] text-meta">Unknown.</span> <span className="text-tertiary-text">Recommended: research the organizer / prime to identify a contact.</span></p>
              ) : (
                <ul className="space-y-3">
                  {entityMemos.map(({ edge, memo }) => (
                    <li key={edge.id} className={`text-[13px] ${edge.isPrimaryTarget ? "border-l-2 border-positive pl-2.5" : "pl-[10px]"}`}>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{edge.entity.name}</span>
                        <span className="rounded border border-border px-1.5 py-px text-[10.5px] uppercase tracking-[0.04em] text-tertiary-text">{RELATIONSHIP_LABEL[edge.relationship]}</span>
                        {edge.isPrimaryTarget && <span className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-positive">Primary target</span>}
                        <VerificationBadge status={edge.entity.verificationStatus} />
                      </div>
                      <div className="text-[12.5px] text-meta">{ENTITY_KIND_LABEL[edge.entity.kind]}{edge.entity.email ? ` · ${edge.entity.email}` : ""}{edge.entity.phone ? ` · ${edge.entity.phone}` : ""}</div>
                      {edge.evidence && <div className="text-[11.5px] text-meta">Evidence: {edge.evidence}</div>}
                      {memo.matched && memo.customer && (
                        <div className="mt-1 rounded border border-attention/30 bg-attention/[0.05] px-2 py-1.5 text-[12px]">
                          <span className="font-medium text-attention">Existing Zoe relationship.</span>{" "}
                          {memo.customer.bookings} booking{memo.customer.bookings === 1 ? "" : "s"}
                          {memo.customer.totalRevenue != null ? `, $${memo.customer.totalRevenue.toLocaleString()} won` : ""}
                          {memo.customer.hasLostQuote ? ", has a lost quote" : ""}
                          {memo.customer.daysSinceLast != null ? `, last event ${memo.customer.daysSinceLast < 0 ? "upcoming" : `${memo.customer.daysSinceLast}d ago`}` : ""}.
                          <span className="text-tertiary-text"> {memo.recommendedAction}.</span>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-2 border-t border-[var(--row-rule)] pt-2 text-[12.5px]"><span className="text-meta">Recommended action:</span> <span className="font-medium text-foreground">{d.recommendedAction}</span></div>
            </div>
          </Section>

          {/* Timing */}
          <Section title="Timing" note={maturity.inferredFromDateOnly ? "from the date only — no verified procurement deadline" : undefined}>
            <div className="grid grid-cols-2 gap-3 rounded border border-border p-3">
              <Field label="Signal maturity">{MATURITY_LABEL[maturity.maturity]}</Field>
              <Field label="Status">{maturity.headline}</Field>
              <Field label="To event">{maturity.daysToEvent != null ? `${maturity.daysToEvent}d` : "—"}</Field>
              <Field label="To deadline">{maturity.daysToDeadline != null ? `${maturity.daysToDeadline}d` : "—"}</Field>
            </div>
          </Section>

          {/* Change history */}
          <Section title="Change history" note="§16 — new deadlines, awards, status changes">
            <div className="rounded border border-border p-3 text-[13px]">
              {changes.length === 0 ? (
                <p className="text-meta">No changes detected yet. A re-pull that alters the deadline, status, or awardee is logged here.</p>
              ) : (
                <ul className="space-y-1">
                  {changes.map((c, i) => (
                    <li key={i} className="flex items-center justify-between">
                      <span>{c.kind === "opportunity_awarded" ? <><span className="text-attention">Awarded</span> to {c.to}</> : <>{c.field}: <span className="text-meta">{c.from ?? "—"}</span> → <span className="text-foreground">{c.to ?? "—"}</span></>}</span>
                      <span className="tabular-nums text-meta">{formatYmdLong(c.ts.slice(0, 10))}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Section>
        </div>
      </div>

      {/* Outreach */}
      <Section title="Outreach" note="detect → draft → approve → send → track — nothing sends automatically">
        <OpportunityOutreach id={id} drafts={outreach} hasTarget={!!d.primaryTarget} />
      </Section>

      {/* Related opportunities (signal fusion) */}
      {related.length > 0 && (
        <Section title="Related signals" note="§9 — likely the same opportunity seen through different sources">
          <div className="border border-border">
            {related.map((r) => (
              <Link key={r.opportunity.id} href={`/radar/${r.opportunity.id}`} className="flex items-center gap-3 border-t border-[var(--row-rule)] px-3 py-2 text-[13px] transition-colors first:border-t-0 hover:bg-[var(--row-hover)]">
                <span className={`rounded border px-1.5 py-px text-[10px] uppercase tracking-[0.05em] ${r.confidence === "HIGH" ? "border-positive/40 text-positive" : r.confidence === "MEDIUM" ? "border-attention/40 text-attention" : "border-border text-meta"}`}>{r.confidence}</span>
                <span className="min-w-0 flex-1 truncate text-foreground">{r.opportunity.name}</span>
                <span className="hidden shrink-0 text-[12px] text-meta sm:block">{r.reason}</span>
                <ArrowUpRight className="size-3.5 shrink-0 text-meta" />
              </Link>
            ))}
          </div>
        </Section>
      )}
    </main>
  );
}
