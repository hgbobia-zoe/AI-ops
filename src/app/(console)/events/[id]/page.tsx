// Event Command Center — /events/[id]. "Understand an event in under 30 seconds." Owner/admin only;
// $ gated by role.
//
// Governing law: RULES CALCULATE, AI INTERPRETS, the UI RENDERS. Every section is fed by the engine and
// cites nothing this page computes itself:
//   • lifecycle            ← getEventReadiness → deriveLifecycle
//   • readiness condition  ← computeEventReadiness
//   • requirements         ← generateRequirements (+ withDeadlines from the timeline)
//   • timeline             ← generateTimeline + withDeadlines
//   • operations/staffing/inventory/customer/financial ← the EventView slices + the requirement set
//   • AI recommendations   ← buildBriefing (the AI Event Manager's deterministic interpretation core:
//     summary, whyAtRisk, primaryBlocker, recommendedActions — each a RECOMMENDATION, never an action taken)
// An UNVERIFIED / null / unbacked fact renders honestly ("Unverified" / "—" / an empty-state line), never a
// fabricated pass. We resolve the event ONCE (real weather) and hand that single bundle to buildBriefing,
// so the page makes no duplicate network call.

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import {
  ArrowLeft,
  Truck,
  AlertTriangle,
  CalendarClock,
  ListChecks,
  Users,
  Boxes,
  Contact,
  DollarSign,
  Sparkles,
  Radio,
  ExternalLink,
} from "lucide-react";
import { viewerRole } from "@/lib/auth/getSession";
import { canManageSettings, canSeeFinancials } from "@/lib/auth/roles";
import { todayInOpsTz, formatYmdLong, formatClockTime } from "@/lib/dates";
import { getEventRef } from "@/lib/event/adapter";
import { getEventReadiness } from "@/lib/event/resolvers";
import { buildBriefing } from "@/lib/event/manager";
import { generateTimeline, withDeadlines } from "@/lib/event/timeline";
import { daysUntil } from "@/lib/event/portfolio";
import type { EventView, Requirement } from "@/lib/event/types";
import type { LifecycleState } from "@/lib/event/machine";
import type { StopState } from "@/lib/types";
import { LifecycleChip, ConditionChip, RequirementChip, MilestoneMark, milestoneDot } from "@/components/event/EventChips";

export const dynamic = "force-dynamic";

const LIVE_STATES = new Set<LifecycleState>(["DISPATCHED", "SETUP", "LIVE", "PICKUP"]);
const IN_MOTION = new Set<StopState>(["EnRoute", "Arrived", "HeadingBack"]);
const DONE_STOP = new Set<StopState>(["Completed", "Returned"]);

function money(n: number | null | undefined): string {
  return n == null ? "—" : "$" + Math.round(n).toLocaleString("en-US");
}
function dayLabel(date: string | null, today: string): string {
  const d = daysUntil(date, today);
  if (d === null) return "";
  if (d < 0) return `${-d}d ago`;
  if (d === 0) return "today";
  if (d === 1) return "tomorrow";
  return `in ${d}d`;
}

export default async function EventCommandCenterPage({ params }: { params: Promise<{ id: string }> }): Promise<React.JSX.Element> {
  const role = await viewerRole();
  if (!canManageSettings(role)) redirect("/dashboard");
  const canSee$ = canSeeFinancials(role);

  const { id } = await params;
  if (!getEventRef(id)) notFound();
  const bundle = await getEventReadiness(id);
  if (!bundle) notFound();

  const today = todayInOpsTz();
  const { view, requirements, readiness } = bundle;
  const lifecycle = bundle.lifecycleState;
  const ref = view.ref;

  const timeline = generateTimeline(view, { requirements, today });
  const datedReqs = withDeadlines(requirements, timeline);
  const briefing = buildBriefing(bundle, { today });

  const isLive = LIVE_STATES.has(lifecycle) || daysUntil(ref.date, today) === 0;

  return (
    <main className="mx-auto max-w-[1100px] p-6">
      <Link href="/events" className="mb-3 inline-flex items-center gap-1.5 text-[12.5px] text-meta transition-colors hover:text-foreground">
        <ArrowLeft className="size-3.5" /> All events
      </Link>

      {/* Header */}
      <header className="mb-5 border-b border-border pb-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-[22px] font-medium leading-tight tracking-tight">{ref.displayName || `Event ${ref.id}`}</h1>
            <p className="mt-1 text-[13px] text-meta">
              {ref.date ? (
                <>
                  {formatYmdLong(ref.date)} <span className="text-tertiary-text">({dayLabel(ref.date, today)})</span>
                  {ref.dateSource === "logistics" && <span className="text-attention"> · date from logistics (no booking date)</span>}
                </>
              ) : (
                "No date on record"
              )}
              {ref.venue ? ` · ${ref.venue}` : ""}
              {ref.customer ? ` · ${ref.customer}` : ""}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <LifecycleChip state={lifecycle} />
            <ConditionChip condition={readiness.condition} />
            {readiness.score != null && (
              <span className="rounded border border-border px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-tertiary-text" title="Event Risk Engine readiness score (0-100)">
                {readiness.score}
              </span>
            )}
          </div>
        </div>
      </header>

      {isLive && <LivePanel view={view} briefing={briefing} timeline={timeline} today={today} />}

      <div className="flex flex-col gap-7">
        {/* Timeline */}
        <Section icon={CalendarClock} title="Timeline" subtitle="generateTimeline + withDeadlines">
          {timeline.length === 0 ? (
            <Empty>No timeline — the event has no attributes to generate milestones from.</Empty>
          ) : (
            <ol className="border border-border">
              {timeline.map((m) => (
                <li key={m.id} className="flex items-start gap-3 border-t border-[var(--row-rule)] px-3 py-2.5 first:border-t-0">
                  <span className={`mt-1.5 size-2 shrink-0 rounded-full ${milestoneDot(m.status)}`} aria-hidden />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[13.5px] font-medium">{m.label}</span>
                      <MilestoneMark status={m.status} />
                    </div>
                    <div className="text-[12px] text-meta">
                      {m.date ? `${formatYmdLong(m.date)} · ${dayLabel(m.date, today)}` : "undated"}
                      {m.requirementIds.length > 0 ? ` · ${m.requirementIds.join(", ")}` : ""}
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </Section>

        {/* Readiness */}
        <Section
          icon={ListChecks}
          title="Readiness"
          subtitle="generateRequirements + computeEventReadiness"
          link={{ href: "/risk", label: "Event Risk" }}
        >
          {readiness.blockers.length > 0 && (
            <p className="mb-2 text-[12.5px] text-critical">
              Blocking: {readiness.blockers.join(", ")}
            </p>
          )}
          {datedReqs.length === 0 ? (
            <Empty>No data-backed requirements for this event yet.</Empty>
          ) : (
            <div className="border border-border">
              {datedReqs.map((r) => (
                <RequirementItem key={r.id} req={r} today={today} />
              ))}
            </div>
          )}
        </Section>

        {/* Operations */}
        <Section icon={Truck} title="Operations" subtitle="routes / stops (primary route)" link={{ href: "/dispatch", label: "Dispatch" }}>
          {!view.logistics.present || view.logistics.stops.length === 0 ? (
            <Empty>No route planned yet. Build or import a route in Dispatch.</Empty>
          ) : (
            <>
              <div className="overflow-x-auto border border-border">
                <table className="w-full border-collapse text-[13px]">
                  <thead>
                    <tr className="text-left text-[11px] uppercase tracking-[0.08em] text-meta">
                      <th className="px-2.5 py-2">#</th>
                      <th className="px-2.5 py-2">Kind</th>
                      <th className="px-2.5 py-2">State</th>
                      <th className="px-2.5 py-2">Window</th>
                      <th className="px-2.5 py-2">ETA</th>
                      <th className="px-2.5 py-2">Truck</th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.logistics.stops.map((s) => (
                      <tr key={s.stopId} className="border-t border-[var(--row-rule)]">
                        <td className="px-2.5 py-2 tabular-nums text-meta">{s.sequence}</td>
                        <td className="px-2.5 py-2 capitalize">{s.kind ?? "—"}</td>
                        <td className="px-2.5 py-2">{s.state}</td>
                        <td className="px-2.5 py-2 text-tertiary-text">{s.plannedWindow ?? "—"}</td>
                        <td className="px-2.5 py-2 text-tertiary-text">{formatClockTime(s.eta) || "—"}</td>
                        <td className="px-2.5 py-2 text-tertiary-text">{s.truckId || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {view.logistics.primaryRouteOnly && (
                <p className="mt-1.5 text-[11.5px] text-meta">Primary route only — a multi-route event may have additional routes (not aggregated here).</p>
              )}
            </>
          )}
        </Section>

        {/* Staffing */}
        <Section icon={Users} title="Staffing" subtitle="crewRules + scheduling / Connecteam" link={{ href: "/scheduling", label: "Scheduling" }}>
          <SliceRequirements reqs={datedReqs} ids={["driver_assigned", "crew_sufficient", "tent_crew"]} today={today} empty="No route to staff yet — staffing requirements appear once a route exists." />
        </Section>

        {/* Inventory */}
        <Section icon={Boxes} title="Inventory" subtitle="peakItemDemand (concurrency signal)">
          <SliceRequirements reqs={datedReqs} ids={["inventory_concurrency"]} today={today} empty="No dated items to check for concurrency. Owned-inventory capacity is unverified by design (no owned master)." />
        </Section>

        {/* Customer */}
        <Section icon={Contact} title="Customer" subtitle="bookings client + stop contact id">
          {ref.customer || ref.contactId || ref.venue ? (
            <dl className="grid grid-cols-[120px_1fr] gap-x-4 gap-y-1.5 text-[13px]">
              <dt className="text-meta">Customer</dt>
              <dd>{ref.customer || "—"}</dd>
              <dt className="text-meta">Venue</dt>
              <dd>{ref.venue || "—"}</dd>
              <dt className="text-meta">GS contact id</dt>
              <dd className="tabular-nums text-tertiary-text">{ref.contactId || "—"}</dd>
            </dl>
          ) : (
            <Empty>No customer or venue on record.</Empty>
          )}
        </Section>

        {/* Financial ($-gated) */}
        <Section icon={DollarSign} title="Financial" subtitle="bookings + event_financials + cost_entries">
          {!canSee$ ? (
            <Empty>Financial figures are hidden for your role.</Empty>
          ) : !view.commercial.present && !view.financials.present && !view.labor.present ? (
            <Empty>No commercial or financial record for this event.</Empty>
          ) : (
            <dl className="grid grid-cols-[150px_1fr] gap-x-4 gap-y-1.5 text-[13px] tabular-nums">
              <dt className="text-meta">Grand total</dt>
              <dd>{money(view.commercial.grandTotal)}</dd>
              <dt className="text-meta">Paid</dt>
              <dd>{money(view.commercial.amountPaid)}</dd>
              <dt className="text-meta">Due</dt>
              <dd>{money(view.commercial.amountDue)}</dd>
              <dt className="text-meta">Projected revenue</dt>
              <dd>
                {money(view.financials.revenue)} <span className="text-[11px] uppercase text-meta">· {view.financials.revenueStatus}</span>
              </dd>
              <dt className="text-meta">Attributed labor</dt>
              <dd>
                {money(view.labor.totalCost)} {view.labor.present ? <span className="text-[11px] text-meta">({view.labor.entryCount} entr{view.labor.entryCount === 1 ? "y" : "ies"})</span> : null}
              </dd>
            </dl>
          )}
        </Section>

        {/* AI recommendations */}
        <Section icon={Sparkles} title="AI recommendations" subtitle="eventBriefing — interpretation, not actions">
          <p className="mb-3 rounded border border-border bg-foreground/[0.03] px-3 py-2 text-[12px] text-meta">
            These are recommendations from the AI Event Manager interpreting the engine. Nothing here has been done — every item is a suggestion for a human to act on.
          </p>
          <p className="mb-3 text-[13.5px] leading-relaxed text-secondary-text">
            {briefing.summary}
            <span className="ml-1 text-[11px] uppercase tracking-[0.06em] text-meta">· {briefing.summarySource}</span>
          </p>

          {briefing.primaryBlocker && (
            <p className="mb-3 text-[13px]">
              <span className="font-medium text-attention">Primary blocker:</span> {briefing.primaryBlocker.label}{" "}
              <span className="text-[11.5px] text-meta">({briefing.primaryBlocker.source})</span>
            </p>
          )}

          {briefing.whyAtRisk.length > 0 && (
            <div className="mb-3">
              <h3 className="mb-1 text-[12px] font-medium uppercase tracking-[0.08em] text-tertiary-text">Why at risk</h3>
              <ul className="space-y-1 text-[13px] text-secondary-text">
                {briefing.whyAtRisk.map((w, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-attention" aria-hidden /> {w}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {briefing.recommendedActions.length === 0 ? (
            <p className="text-[13px] text-positive">No actions recommended right now.</p>
          ) : (
            <div className="border border-border">
              {briefing.recommendedActions.map((a) => (
                <div key={a.id} className="border-t border-[var(--row-rule)] px-3 py-2.5 first:border-t-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[13.5px] font-medium">{a.label}</span>
                    <span className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] ${a.priority === "blocking" ? "border-critical/40 text-critical" : "border-border text-meta"}`}>
                      {a.priority}
                    </span>
                    {a.deadline && <span className="text-[11.5px] text-meta">by {a.deadline}</span>}
                  </div>
                  <div className="mt-0.5 text-[12.5px] text-meta">
                    {a.reason} · owner: {a.owner} · {a.source}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Section>
      </div>
    </main>
  );
}

// ── LIVE panel — leads the page in the operational window. Deterministic + honest (no fabricated progress). ─
function LivePanel({
  view,
  briefing,
  timeline,
  today,
}: {
  view: EventView;
  briefing: ReturnType<typeof buildBriefing>;
  timeline: ReturnType<typeof generateTimeline>;
  today: string;
}): React.JSX.Element {
  const stops = view.logistics.stops;
  const complete = stops.filter((s) => DONE_STOP.has(s.state));
  const nowStops = stops.filter((s) => IN_MOTION.has(s.state));
  const exceptions = stops.filter((s) => s.state === "Exception");
  const overdue = timeline.filter((m) => m.status === "overdue");
  const nextAction = briefing.primaryBlocker?.label ?? briefing.recommendedActions[0]?.label ?? null;
  const doneMilestones = timeline.filter((m) => m.status === "done").length;

  return (
    <section className="mb-6 rounded border border-attention/40 bg-attention/[0.06] p-4">
      <div className="mb-3 flex items-center gap-2">
        <Radio className="size-4 text-attention" />
        <h2 className="text-[13px] font-semibold uppercase tracking-[0.1em] text-attention">Live · event day / in motion</h2>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <LiveCell label="Status">
          {briefing.lifecycle} · {briefing.condition}
        </LiveCell>
        <LiveCell label="Complete">
          {view.logistics.present ? `${complete.length}/${stops.length} stops` : "—"}
          {doneMilestones > 0 ? ` · ${doneMilestones} milestones` : ""}
        </LiveCell>
        <LiveCell label="Happening now">
          {nowStops.length > 0 ? nowStops.map((s) => `#${s.sequence} ${s.state}`).join(", ") : "Nothing in motion"}
        </LiveCell>
        <LiveCell label="Late / overdue" tone={overdue.length || exceptions.length ? "critical" : undefined}>
          {overdue.length === 0 && exceptions.length === 0
            ? "Nothing overdue"
            : [...overdue.map((m) => m.label), ...exceptions.map((s) => `Stop #${s.sequence} exception`)].join(", ")}
        </LiveCell>
        <LiveCell label="At risk" tone={briefing.whyAtRisk.length ? "attention" : undefined}>
          {briefing.whyAtRisk.length === 0 ? "On track" : briefing.whyAtRisk[0]}
        </LiveCell>
        <LiveCell label="Next action">{nextAction ?? "Nothing recommended"}</LiveCell>
      </div>
    </section>
  );
}

function LiveCell({ label, tone, children }: { label: string; tone?: "attention" | "critical"; children: React.ReactNode }): React.JSX.Element {
  const toneCls = tone === "critical" ? "text-critical" : tone === "attention" ? "text-attention" : "text-secondary-text";
  return (
    <div>
      <div className="mb-0.5 text-[10.5px] font-medium uppercase tracking-[0.08em] text-meta">{label}</div>
      <div className={`text-[13px] leading-snug ${toneCls}`}>{children}</div>
    </div>
  );
}

// ── Section shell ────────────────────────────────────────────────────────────────────────────────────────
function Section({
  icon: Icon,
  title,
  subtitle,
  link,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  subtitle?: string;
  link?: { href: string; label: string };
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-[14px] font-medium">
          <Icon className="size-4 text-meta" /> {title}
          {subtitle && <span className="text-[11px] font-normal normal-case text-meta">· {subtitle}</span>}
        </h2>
        {link && (
          <Link href={link.href} className="inline-flex items-center gap-1 text-[12px] text-meta transition-colors hover:text-foreground">
            {link.label} <ExternalLink className="size-3" />
          </Link>
        )}
      </div>
      {children}
    </section>
  );
}

function RequirementItem({ req, today }: { req: Requirement; today: string }): React.JSX.Element {
  return (
    <div className="flex items-start justify-between gap-3 border-t border-[var(--row-rule)] px-3 py-2.5 first:border-t-0">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13.5px] font-medium">{req.label}</span>
          {req.blocking && <span className="rounded border border-border px-1 py-0.5 text-[9.5px] font-semibold uppercase tracking-[0.06em] text-meta">Blocking</span>}
        </div>
        <div className="text-[12px] text-meta">
          {req.resolution}
          <span className="text-tertiary-text"> · {req.owner}</span>
          {req.deadline ? ` · due ${req.deadline} (${dayLabel(req.deadline, today)})` : ""}
        </div>
      </div>
      <RequirementChip status={req.status} />
    </div>
  );
}

function SliceRequirements({ reqs, ids, today, empty }: { reqs: Requirement[]; ids: string[]; today: string; empty: string }): React.JSX.Element {
  const matched = reqs.filter((r) => ids.includes(r.id));
  if (matched.length === 0) return <Empty>{empty}</Empty>;
  return (
    <div className="border border-border">
      {matched.map((r) => (
        <RequirementItem key={r.id} req={r} today={today} />
      ))}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <p className="text-[12.5px] text-meta">{children}</p>;
}
