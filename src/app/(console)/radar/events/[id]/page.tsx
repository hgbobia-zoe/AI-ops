// Event Radar — event intelligence detail. The full picture for one detected event: the facts (with
// provenance), WHY it matters (the transparent deterministic score explanation), rental signals,
// organization, planner intelligence, recurrence (incl. any PREDICTED/UNANNOUNCED next), timing, and
// the Sales OS handoff. Nothing is fabricated — unknowns are shown as unknowns.

import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowUpRight, ExternalLink } from "lucide-react";
import { RadarOpportunityButton } from "@/components/RadarOpportunityButton";
import { VerificationBadge, TierBadge, ScorePill, SeedTag } from "@/components/radar-badges";
import { radarEventDetail } from "@/lib/radar/service";
import { CATEGORY_LABEL, ATTRIBUTE_LABEL, type AttributeKey } from "@/lib/radar/types";
import { REGION_LABEL } from "@/lib/radar/geo";
import { todayInOpsTz, formatYmdLong } from "@/lib/dates";

export const dynamic = "force-dynamic";

const PHASE_LABEL: Record<string, string> = {
  TOO_EARLY: "Too early", PLANNING_WINDOW: "Planning window", OUTREACH_WINDOW: "Outreach window",
  ACTIVELY_SHOPPING: "Likely shopping vendors", IMMINENT: "Imminent", PAST: "Event has passed", DATE_UNKNOWN: "Date unknown",
};

function Section({ title, children, note }: { title: string; children: React.ReactNode; note?: string }): React.JSX.Element {
  return (
    <section className="mb-6">
      <h2 className="mb-2 text-[13px] font-medium uppercase tracking-[0.1em] text-tertiary-text">
        {title}{note && <span className="ml-2 text-[11px] normal-case tracking-normal text-meta">{note}</span>}
      </h2>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10.5px] uppercase tracking-[0.08em] text-meta">{label}</span>
      <span className="text-[13.5px] text-foreground">{children}</span>
    </div>
  );
}

function fmtRange(v: { low: number; high: number }): string {
  const f = (n: number) => `$${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return `${f(v.low)}–${f(v.high)}`;
}

export default async function RadarEventDetailPage({ params }: { params: Promise<{ id: string }> }): Promise<React.JSX.Element> {
  const { id } = await params;
  const today = todayInOpsTz();
  const detail = radarEventDetail(id, today);
  if (!detail) notFound();
  const { event: e, qualification: q, timing, organization, planners, recurrence, opportunity } = detail;

  return (
    <main className="p-6 max-w-[1100px]">
      <div className="mb-4 text-[12px] text-meta"><Link href="/radar" className="hover:text-foreground">Opportunity Radar</Link> / Event intelligence / {e.name}</div>

      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="mb-1 flex items-center gap-2">
            <h1 className="text-[22px] font-medium tracking-tight">{e.name}</h1>
            {e.isSeed && <SeedTag />}
          </div>
          <p className="text-[13px] text-meta">{CATEGORY_LABEL[e.category]} · {e.venue ?? "venue TBD"} · {REGION_LABEL[e.region]}</p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="flex items-center gap-4">
            <div className="text-right">
              <div className="flex items-center justify-end gap-1.5"><ScorePill score={q.rentalFitScore} tier={q.tier} /><span className="text-[12px] text-meta">/ 100</span></div>
              <div className="text-[10.5px] uppercase tracking-[0.08em] text-meta">Rental fit</div>
            </div>
            <div className="text-right">
              <div className="text-[15px] font-medium tabular-nums text-foreground">{q.commercialOpportunityScore}</div>
              <div className="text-[10.5px] uppercase tracking-[0.08em] text-meta">Commercial</div>
            </div>
            <div className="text-right"><TierBadge tier={q.tier} /><div className="text-[10.5px] uppercase tracking-[0.08em] text-meta">Priority</div></div>
          </div>
          <RadarOpportunityButton eventId={e.id} salesStatus={e.salesStatus} bookingId={opportunity?.bookingId ?? null} />
        </div>
      </header>

      <div className="grid grid-cols-1 gap-x-8 lg:grid-cols-2">
        <div>
          {/* Event facts */}
          <Section title="Event">
            <div className="grid grid-cols-2 gap-3 rounded border border-border p-3">
              <Field label="Dates">{e.startDate ? formatYmdLong(e.startDate) : "TBD"}{e.endDate && e.endDate !== e.startDate ? ` – ${formatYmdLong(e.endDate)}` : ""}</Field>
              <Field label="Category">{CATEGORY_LABEL[e.category]}</Field>
              <Field label="Venue">{e.venue ?? "—"}</Field>
              <Field label="Location">{[e.city, e.state].filter(Boolean).join(", ") || REGION_LABEL[e.region]}</Field>
              <Field label="Expected attendance">
                {e.expectedAttendance != null ? <>{e.expectedAttendance.toLocaleString()} <span className="text-[11px] text-meta">({e.attendanceConfidence.toLowerCase()})</span></> : <span className="text-meta">Unknown</span>}
              </Field>
              <Field label="Verification"><VerificationBadge status={e.verificationStatus} /></Field>
              <Field label="Source">
                {e.sourceUrl ? <a href={e.sourceUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-tertiary-text hover:text-foreground">{e.sourceName ?? "source"} <ExternalLink className="size-3" /></a> : e.sourceName ?? "—"}
              </Field>
              <Field label="Last verified">{e.lastVerifiedAt ? formatYmdLong(e.lastVerifiedAt.slice(0, 10)) : "—"}</Field>
            </div>
            {e.description && <p className="mt-2 text-[13px] text-secondary-text">{e.description}</p>}
          </Section>

          {/* Why this matters — transparent score explanation */}
          <Section title="Why this matters" note="rules calculate — every point is a documented signal">
            <div className="rounded border border-border p-3 text-[13px]">
              <ul className="space-y-1">
                {q.positives.map((s) => (
                  <li key={s.key} className="flex items-center justify-between">
                    <span><span className="text-positive">+</span> {s.label}</span>
                    <span className="tabular-nums text-meta">+{s.weight}</span>
                  </li>
                ))}
                {q.negatives.map((s) => (
                  <li key={s.key} className="flex items-center justify-between">
                    <span><span className="text-critical">−</span> {s.label}</span>
                    <span className="tabular-nums text-critical">{s.weight}</span>
                  </li>
                ))}
              </ul>
              {q.unknowns.length > 0 && (
                <div className="mt-2 border-t border-[var(--row-rule)] pt-2 text-meta">
                  {q.unknowns.map((s) => <div key={s.key}>? {s.label} <span className="text-[11px]">— unknown, not counted</span></div>)}
                </div>
              )}
              <div className="mt-2 flex items-center justify-between border-t border-[var(--row-rule)] pt-2">
                <span className="font-medium">Rental fit</span>
                <span className="tabular-nums"><ScorePill score={q.rentalFitScore} tier={q.tier} /> <span className="text-meta">/ 100 · {q.tier}</span></span>
              </div>
              <p className="mt-2 text-[12px] text-meta">
                Indicative rental spend: {q.estimatedValue ? <span className="text-tertiary-text">{fmtRange(q.estimatedValue)}</span> : <span>unavailable — attendance not known</span>}. A coarse range from attendance × category, not a revenue prediction.
              </p>
            </div>
          </Section>

          {/* Rental signals */}
          <Section title="Rental signals">
            <div className="grid grid-cols-2 gap-1.5 rounded border border-border p-3 text-[13px]">
              {(Object.keys(ATTRIBUTE_LABEL) as AttributeKey[]).filter((k) => k !== "virtual").map((k) => {
                const st = e.attributes[k] ?? "UNKNOWN";
                const dot = st === "PRESENT" ? "bg-positive" : st === "ABSENT" ? "bg-[var(--bar)]" : "bg-attention/60";
                return (
                  <div key={k} className="flex items-center gap-2">
                    <span className={`size-1.5 rounded-full ${dot}`} />
                    <span className={st === "PRESENT" ? "text-foreground" : "text-meta"}>{ATTRIBUTE_LABEL[k]}</span>
                    <span className="ml-auto text-[11px] uppercase tracking-[0.05em] text-meta">{st === "UNKNOWN" ? "?" : st === "PRESENT" ? "yes" : "no"}</span>
                  </div>
                );
              })}
              {e.attributes.virtual === "PRESENT" && <div className="col-span-2 text-critical">Fully virtual event — negative for rentals</div>}
            </div>
          </Section>
        </div>

        <div>
          {/* Organization */}
          <Section title="Organization">
            <div className="rounded border border-border p-3">
              {organization ? (
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Name">{organization.name}</Field>
                  <Field label="Type">{organization.orgType ?? "—"}</Field>
                  <Field label="Website">{organization.website ? <a href={organization.website} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-tertiary-text hover:text-foreground">Visit <ExternalLink className="size-3" /></a> : "—"}</Field>
                  <Field label="Verified"><VerificationBadge status={organization.verificationStatus} /></Field>
                </div>
              ) : (
                <p className="text-[13px] text-meta">Organization not identified. <span className="text-tertiary-text">Recommended: research organizer.</span></p>
              )}
            </div>
          </Section>

          {/* Planner intelligence */}
          <Section title="Planner intelligence">
            <div className="rounded border border-border p-3">
              {planners.length > 0 ? (
                <ul className="space-y-3">
                  {planners.map((p) => (
                    <li key={p.id} className="text-[13px]">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{p.name}</span>
                        <VerificationBadge status={p.contactStatus} />
                        {p.confidence != null && <span className="text-[11px] text-meta">conf {Math.round(p.confidence * 100)}%</span>}
                      </div>
                      <div className="text-[12.5px] text-meta">{p.role ?? "role unknown"}{p.agency ? ` · ${p.agency}` : ""}</div>
                      <div className="text-[12.5px] text-tertiary-text">{[p.email, p.phone].filter(Boolean).join(" · ") || "no direct contact on file"}</div>
                      {p.evidence && <div className="mt-0.5 text-[11.5px] text-meta">Evidence: {p.evidence}</div>}
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="text-[13px]">
                  <div className="mb-1 flex items-center gap-2"><span className="font-medium text-meta">Planner:</span> <span className="uppercase tracking-[0.06em] text-meta">Unknown</span></div>
                  <div className="text-tertiary-text">Recommended action: <span className="font-medium text-foreground">Research organizer</span> — no planner is invented when none is known.</div>
                </div>
              )}
            </div>
          </Section>

          {/* Recurrence */}
          <Section title="Recurrence">
            <div className="rounded border border-border p-3 text-[13px]">
              {recurrence.recurring ? (
                <>
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <span className="font-medium">{recurrence.seriesName}</span>
                    <span className="rounded border border-border px-1.5 py-0.5 text-[10.5px] uppercase tracking-[0.05em] text-tertiary-text">Recurring · {recurrence.confidence}</span>
                    {recurrence.cadence && <span className="text-[12px] text-meta">{recurrence.cadence}</span>}
                  </div>
                  <div className="text-[12px] text-meta">Known instances:</div>
                  <ul className="mb-2 mt-0.5 space-y-0.5">
                    {recurrence.history.map((h) => (
                      <li key={h.id} className="flex items-center justify-between">
                        <Link href={`/radar/${h.id}`} className={`hover:underline ${h.id === e.id ? "text-foreground" : "text-tertiary-text"}`}>{h.name}</Link>
                        <span className="tabular-nums text-meta">{h.date ? formatYmdLong(h.date) : "—"}</span>
                      </li>
                    ))}
                  </ul>
                  {recurrence.predictedNext ? (
                    <div className="rounded border border-attention/30 bg-attention/[0.05] p-2">
                      <span className="font-medium text-attention">Predicted next: {recurrence.predictedNext.year}</span>
                      <span className="ml-1 text-[10.5px] uppercase tracking-[0.05em] text-attention">Predicted / unannounced</span>
                      <div className="mt-0.5 text-[12px] text-meta">{recurrence.predictedNext.basis}. Not a fabricated event — confirm with the organizer.</div>
                    </div>
                  ) : (
                    <div className="text-[12px] text-meta">Next occurrence: the upcoming instance above is the known one — nothing projected.</div>
                  )}
                </>
              ) : (
                <p className="text-meta">No recurring series identified for this event.</p>
              )}
            </div>
          </Section>

          {/* Sales */}
          <Section title="Sales">
            <div className="rounded border border-border p-3 text-[13px]">
              {opportunity ? (
                <div className="space-y-1">
                  <Field label="Sales opportunity"><span className="text-positive">{opportunity.status === "LINKED" ? "Linked to a Sales OS booking" : "Created — early opportunity"}</span></Field>
                  {opportunity.nextAction && <div className="text-[12.5px] text-tertiary-text">Next action: {opportunity.nextAction}</div>}
                  {opportunity.createdBy && <div className="text-[11.5px] text-meta">By {opportunity.createdBy} · {formatYmdLong(opportunity.createdAt.slice(0, 10))}</div>}
                  <a href={opportunity.bookingId ? `/salesos/${opportunity.bookingId}` : "/salesos"} className="mt-1 inline-flex items-center gap-1 text-[12.5px] text-tertiary-text hover:text-foreground">Open in Sales OS <ArrowUpRight className="size-3.5" /></a>
                </div>
              ) : (
                <p className="text-meta">No Sales OS opportunity yet. Creating one hands this to Sales OS — the event stays the source record (no duplicate).</p>
              )}
            </div>
          </Section>
        </div>
      </div>

      {/* Timing + Timeline (full width) */}
      <Section title="Timing" note={timing.inferredFromDateOnly ? "inferred from the event date — no verified procurement deadline" : undefined}>
        <div className="grid grid-cols-2 gap-3 rounded border border-border p-3 sm:grid-cols-4">
          <Field label="Event date">{e.startDate ? formatYmdLong(e.startDate) : "TBD"}</Field>
          <Field label="Current status">{PHASE_LABEL[timing.phase] ?? timing.phase}</Field>
          <Field label="Recommended action"><span className="text-foreground">{timing.recommendedAction}</span></Field>
          <Field label="Outreach window">{timing.outreachWindow}</Field>
        </div>
      </Section>

      <Section title="Timeline">
        <div className="rounded border border-border p-3 text-[13px]">
          <ol className="space-y-1.5">
            <TimelineRow when={e.discoveredAt} label="Discovered" done />
            <TimelineRow when={e.lastVerifiedAt} label="Verified against source" done={!!e.lastVerifiedAt} />
            <TimelineRow when={null} label="Planner identified" done={e.plannerStatus !== "UNKNOWN"} pending="research organizer" />
            <TimelineRow when={null} label="Outreach recommended" done={timing.phase === "OUTREACH_WINDOW" || timing.phase === "ACTIVELY_SHOPPING"} pending={PHASE_LABEL[timing.phase]} />
            <TimelineRow when={opportunity?.createdAt ?? null} label="Sales opportunity created" done={!!opportunity} pending="not yet handed off" />
          </ol>
        </div>
      </Section>
    </main>
  );
}

function TimelineRow({ when, label, done, pending }: { when: string | null; label: string; done?: boolean; pending?: string }): React.JSX.Element {
  return (
    <li className="flex items-center gap-2.5">
      <span className={`size-1.5 shrink-0 rounded-full ${done ? "bg-positive" : "bg-[var(--bar)]"}`} />
      <span className={done ? "text-foreground" : "text-meta"}>{label}</span>
      <span className="ml-auto text-[12px] tabular-nums text-meta">{when ? formatYmdLong(when.slice(0, 10)) : done ? "" : (pending ?? "pending")}</span>
    </li>
  );
}
