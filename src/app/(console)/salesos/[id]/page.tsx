// AI Sales OS (Phase 1) — lead detail & call prep. One open lead: the recommended next action with a
// fact-based rationale, the explainable priority breakdown, a timeline of what we actually know, and
// one-tap contact (the human initiates the call/text/email — nothing is sent automatically).

import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Phone, MessageSquare, Mail, ExternalLink, Sparkles, Clock, CalendarClock, FileText, EyeOff, MessagesSquare, History, AlertTriangle } from "lucide-react";
import { OutreachPanel } from "@/components/OutreachPanel";
import { getLead } from "@/lib/salesos/service";
import { getCommsForLead, getBookingById, getCustomerState } from "@/lib/db/repo";
import { STAGE_LABEL, type SalesStage } from "@/lib/salesos/calc";
import { resolveDeterministic, fromStored, replyMinutesAgo } from "@/lib/salesos/stateService";
import { nextBestAction, NBA_LABEL } from "@/lib/salesos/nba";
import { STATE_LABEL as STATE_LABEL_V2 } from "@/lib/salesos/state";
import { callBriefFor } from "@/lib/salesos/callBrief";
import { logLeadView, leadActivity } from "@/lib/salesos/audit";
import { formatYmdLong } from "@/lib/dates";
import { viewerRole } from "@/lib/auth/getSession";
import { canSeeFinancials } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

const money = (n: number | null): string => (n == null ? "—" : "$" + Math.round(n).toLocaleString("en-US"));

const STAGE_STYLE: Record<SalesStage, string> = {
  closing: "border-rose-500/40 bg-rose-500/10 text-rose-200",
  unsent: "border-sky-500/40 bg-sky-500/10 text-sky-200",
  follow_up: "border-amber-500/40 bg-amber-500/10 text-amber-200",
  cold: "border-white/15 bg-white/5 text-muted-foreground",
  awaiting: "border-emerald-500/30 bg-emerald-500/10 text-emerald-200",
};

const GS_PROJECT = (id: string): string => `https://pro.goodshuffle.com/app/project/detail?id=${id}`;

export default async function LeadDetailPage({ params }: { params: Promise<{ id: string }> }): Promise<React.JSX.Element> {
  const { id } = await params;
  const showMoney = canSeeFinancials(await viewerRole());
  const lead = getLead(id);
  if (!lead) notFound();

  await logLeadView(id); // audit trail: who viewed this lead (deduped per actor/30min)
  const activity = leadActivity(id, 30);
  const conversation = getCommsForLead(id, 20); // inbound + outbound SMS timeline

  // Evidence-driven state (stored AI-refined if we have it, else instant deterministic) + NBA v2.
  const booking = getBookingById(id);
  const stored = getCustomerState(id);
  const cstate = stored ? fromStored(stored) : booking ? resolveDeterministic(booking) : null;
  const repliedMinutesAgo = replyMinutesAgo(id);
  const nba = cstate ? nextBestAction({ state: cstate.state, value: lead.value, daysToEvent: lead.signals.daysToEvent, repliedMinutesAgo }) : null;
  const brief = cstate ? callBriefFor(cstate.state, lead.clientName) : null;

  const { signals: s, priority } = lead;
  const dte = s.daysToEvent;
  const eventWhen =
    dte == null ? "No event date on file" : dte < 0 ? `${Math.abs(dte)} days ago` : dte === 0 ? "Today" : dte === 1 ? "Tomorrow" : `In ${dte} days`;

  return (
    <main className="mx-auto max-w-2xl p-5 pb-16 md:p-8">
      <Link href="/salesos" className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> Sales OS
      </Link>

      <header className="mb-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-bold tracking-tight">{lead.eventName || lead.clientName || `Project ${lead.id}`}</h1>
            <p className="text-sm text-muted-foreground">{lead.clientName || "Unknown client"}</p>
          </div>
          <span className={`shrink-0 border px-2 py-1 text-xs font-medium ${STAGE_STYLE[lead.stage]}`}>{STAGE_LABEL[lead.stage]}</span>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span className="flex items-center gap-1"><CalendarClock className="size-3.5" /> {lead.eventDate ? `${formatYmdLong(lead.eventDate)} · ${eventWhen}` : eventWhen}</span>
          {showMoney && <span className="text-amber-200">{money(lead.value)} potential</span>}
          {lead.statusLabel && <span>Goodshuffle: {lead.statusLabel}</span>}
        </div>
      </header>

      {/* Customer state (evidence-driven) + the recommended next step (NBA v2) */}
      <section className="surface mb-4 border border-white/10 p-4">
        {cstate && (
          <div className="mb-3 border-b border-white/5 pb-3">
            <div className="mb-1 flex items-center justify-between text-[11px] uppercase tracking-wide text-muted-foreground">
              <span>Customer state</span>
              <span className="tabular-nums">{Math.round(cstate.confidence * 100)}% confidence</span>
            </div>
            <div className="text-lg font-semibold">{STATE_LABEL_V2[cstate.state]}</div>
            {cstate.reason && <p className="mt-0.5 text-xs text-muted-foreground">{cstate.reason}</p>}
            {cstate.evidence && cstate.source === "inbound_reply" && (
              <p className="mt-1 border-l-2 border-sky-500/40 pl-2 text-xs italic text-sky-200/90">“{cstate.evidence}”</p>
            )}
          </div>
        )}

        <div className="mb-1 flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
          <Sparkles className="size-3.5" /> Next best action
        </div>
        {nba ? (
          <>
            <div className="text-lg font-semibold">{NBA_LABEL[nba.action]}</div>
            <p className="mt-1 text-sm">{nba.objective}</p>
            {nba.doNot && (
              <p className="mt-1 flex items-start gap-1.5 text-xs text-amber-200">
                <AlertTriangle className="mt-0.5 size-3 shrink-0" /> Do not: {nba.doNot}
              </p>
            )}
          </>
        ) : (
          <div className="text-lg font-semibold">Review this lead</div>
        )}

        {/* One-tap contact — the human initiates. */}
        <div className="mt-3 flex flex-wrap gap-2">
          {s.hasPhone ? (
            <>
              <a href={`tel:${lead.clientPhone.replace(/[^\d+]/g, "")}`} className="btn-hero flex items-center gap-1.5 px-3 py-1.5 text-sm">
                <Phone className="size-4" /> Call
              </a>
              <a href={`sms:${lead.clientPhone.replace(/[^\d+]/g, "")}`} className="flex items-center gap-1.5 border border-white/15 px-3 py-1.5 text-sm hover:bg-white/5">
                <MessageSquare className="size-4" /> Text
              </a>
            </>
          ) : null}
          {s.hasEmail ? (
            <a href={`mailto:${lead.clientEmail}`} className="flex items-center gap-1.5 border border-white/15 px-3 py-1.5 text-sm hover:bg-white/5">
              <Mail className="size-4" /> Email
            </a>
          ) : null}
          {!s.hasPhone && !s.hasEmail && (
            <span className="text-xs text-amber-200">No phone or email on file — add contact details in Goodshuffle.</span>
          )}
          <a href={GS_PROJECT(lead.id)} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 border border-white/15 px-3 py-1.5 text-sm hover:bg-white/5">
            <ExternalLink className="size-4" /> Open in Goodshuffle
          </a>
        </div>
      </section>

      {/* Call brief — the 15-second briefing before dialing (state-keyed, deterministic) */}
      {brief && brief.opening && (
        <section className="surface mb-4 border border-white/10 p-4">
          <div className="mb-2 flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
            <Phone className="size-3.5" /> Call brief
          </div>
          {brief.blocker && (
            <p className="mb-2 text-xs text-muted-foreground">Likely blocker: <span className="text-amber-200">{brief.blocker}</span></p>
          )}
          <div className="space-y-2 text-sm">
            <div>
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Opening</div>
              <p>{brief.opening}</p>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Ask this</div>
              <p className="font-medium">&ldquo;{brief.primaryQuestion}&rdquo;</p>
            </div>
            {brief.watchFor.length > 0 && (
              <div>
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Watch for</div>
                <ul className="mt-0.5 flex flex-wrap gap-1.5">
                  {brief.watchFor.map((w, i) => (
                    <li key={i} className="border border-white/10 px-1.5 py-0.5 text-[11px] text-muted-foreground">{w}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </section>
      )}

      {/* Suggested outreach — message copy + call strategy, on demand */}
      <OutreachPanel id={lead.id} />

      {/* Conversation — inbound + outbound texts on the unified timeline (FACT: actual messages) */}
      {conversation.length > 0 && (
        <section className="surface mb-4 border border-white/10 p-4">
          <div className="mb-2 flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
            <MessageSquare className="size-3.5" /> Conversation
          </div>
          <ul className="space-y-2">
            {conversation.map((c) => {
              const inbound = c.direction === "inbound";
              return (
                <li key={c.id} className={`flex ${inbound ? "justify-start" : "justify-end"}`}>
                  <div className={`max-w-[80%] border p-2.5 text-sm ${inbound ? "border-sky-500/30 bg-sky-500/[0.07]" : "border-emerald-500/25 bg-emerald-500/[0.06]"}`}>
                    <div className="mb-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                      {inbound ? "Customer" : c.actor || "Zoe"} · {c.occurredAt ? new Date(c.occurredAt).toLocaleString() : ""}
                    </div>
                    <div className="whitespace-pre-wrap">{c.body}</div>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {/* Prior contact — the Goodshuffle comms log the outreach is based on */}
      {lead.internalNotes && (
        <section className="surface mb-4 border border-white/10 p-4">
          <div className="mb-2 flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
            <MessagesSquare className="size-3.5" /> Prior contact (from Goodshuffle)
          </div>
          {lead.clientNotes && (
            <p className="mb-2 border border-amber-500/30 bg-amber-500/[0.07] p-2 text-xs text-amber-100">{lead.clientNotes}</p>
          )}
          <pre className="max-h-56 overflow-y-auto whitespace-pre-wrap border border-white/5 bg-white/[0.02] p-2.5 text-xs text-muted-foreground">{lead.internalNotes}</pre>
        </section>
      )}

      {/* Why this priority — the explainable breakdown */}
      <section className="surface mb-4 border border-white/10 p-4">
        <div className="mb-2 flex items-center justify-between">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Why it&apos;s ranked here</div>
          <div className="text-sm font-bold tabular-nums">score {priority.score}</div>
        </div>
        <ul className="space-y-1.5">
          {priority.factors.map((f, i) => (
            <li key={i} className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">{f.label}</span>
              <span className="tabular-nums">+{f.points}</span>
            </li>
          ))}
        </ul>
      </section>

      {/* What we actually know — the fact timeline */}
      <section className="surface mb-4 border border-white/10 p-4">
        <div className="mb-2 text-[11px] uppercase tracking-wide text-muted-foreground">What we know</div>
        <dl className="space-y-2 text-sm">
          <Fact icon={FileText} label="Quote created" value={lead.dateCreated ? formatYmdLong(lead.dateCreated) : "Unknown"} />
          <Fact
            icon={Clock}
            label="Quote sent"
            value={lead.quoteSentDate ? `${formatYmdLong(lead.quoteSentDate)}${s.quoteAgeDays != null ? ` · ${s.quoteAgeDays}d ago` : ""}` : "Not sent yet"}
          />
          <Fact icon={CalendarClock} label="Event date" value={lead.eventDate ? `${formatYmdLong(lead.eventDate)} · ${eventWhen}` : "Not set"} />
          {showMoney && (lead.amountDue != null || lead.amountPaid != null) && (
            <Fact icon={FileText} label="Deposit" value={`${money(lead.amountPaid)} paid · ${money(lead.amountDue)} due`} />
          )}
        </dl>
      </section>

      {/* Activity trail — who did what on this lead (attributable once login is on) */}
      {activity.length > 0 && (
        <section className="surface mb-4 border border-white/10 p-4">
          <div className="mb-2 flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
            <History className="size-3.5" /> Activity
          </div>
          <ul className="space-y-1.5">
            {activity.map((a, i) => (
              <li key={i} className="flex items-baseline justify-between gap-3 text-xs">
                <span>
                  <span className="text-foreground">{a.actor}</span> <span className="text-muted-foreground">{a.actionLabel.toLowerCase()}</span>
                  {a.detail?.source ? <span className="text-muted-foreground"> ({String(a.detail.source)})</span> : ""}
                  {a.detail?.edited === true ? <span className="text-amber-300"> · edited</span> : ""}
                </span>
                <span className="shrink-0 tabular-nums text-muted-foreground">{new Date(a.ts).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
        <EyeOff className="mt-0.5 size-3 shrink-0" />
        We can&apos;t see the client&apos;s replies or calls yet, so &ldquo;awaiting&rdquo;/&ldquo;quiet&rdquo; is inferred from elapsed time. Confirm the real
        state in Goodshuffle before you reach out.
      </p>
    </main>
  );
}

function Fact({ icon: Icon, label, value }: { icon: typeof FileText; label: string; value: string }): React.JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      <dt className="w-28 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}
