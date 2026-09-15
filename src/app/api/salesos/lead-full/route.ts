// Full lead detail for the board's side panel — everything the lead board shows (state, next-best-
// action, call/text/email briefs, conversation feed, priority + facts + activity), so the rep never
// has to open another page. Read-only; money hidden for Members. Proxy-gated to console users.

import { NextResponse } from "next/server";
import { getLead } from "@/lib/salesos/service";
import { getBookingById, getCustomerState, getCommsForLead, getCustomerCallThread } from "@/lib/db/repo";
import { resolveDeterministic, fromStored, replyMinutesAgo } from "@/lib/salesos/stateService";
import { nextBestAction, NBA_LABEL } from "@/lib/salesos/nba";
import { STATE_LABEL } from "@/lib/salesos/state";
import { STAGE_LABEL } from "@/lib/salesos/calc";
import { callBriefFor } from "@/lib/salesos/callBrief";
import { buildConversationFeed, emailFeedItems } from "@/lib/coach/feed";
import { leadActivity } from "@/lib/salesos/audit";
import { ourPhoneDigits, last10 } from "@/lib/comms/identity";
import { getOpenphoneContactMap } from "@/lib/comms/openphone";
import { formatYmdLong } from "@/lib/dates";
import { viewerRole, viewerFirstName } from "@/lib/auth/getSession";
import { canSeeFinancials } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

const money = (n: number | null): string => (n == null ? "—" : "$" + Math.round(n).toLocaleString("en-US"));

export async function GET(req: Request): Promise<NextResponse> {
  const id = new URL(req.url).searchParams.get("id")?.trim();
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const lead = getLead(id);
  if (!lead) return NextResponse.json({ error: "not found" }, { status: 404 });

  const showMoney = canSeeFinancials(await viewerRole());
  const booking = getBookingById(id);
  const stored = getCustomerState(id);
  const cstate = stored ? fromStored(stored) : booking ? resolveDeterministic(booking) : null;
  const repliedMinutesAgo = replyMinutesAgo(id);
  const nba = cstate ? nextBestAction({ state: cstate.state, value: lead.value, daysToEvent: lead.signals.daysToEvent, repliedMinutesAgo }) : null;
  const brief = cstate ? callBriefFor(cstate.state, lead.clientName, await viewerFirstName()) : null;

  const dte = lead.signals.daysToEvent;
  const eventWhen = dte == null ? "No event date" : dte < 0 ? `${Math.abs(dte)} days ago` : dte === 0 ? "Today" : dte === 1 ? "Tomorrow" : `In ${dte} days`;

  const ourDigits = ourPhoneDigits();
  const custDigits = last10(lead.clientPhone);
  const contactMap = await getOpenphoneContactMap();
  const thread = custDigits ? getCustomerCallThread(custDigits, { ourDigits, contactMap, limit: 8 }) : [];
  const comms = getCommsForLead(id, 60);
  const feed = buildConversationFeed(thread, comms, emailFeedItems(booking));
  const activity = leadActivity(id, 20).map((a) => ({ actor: a.actor, actionLabel: a.actionLabel, ts: a.ts, detail: a.detail?.source ? String(a.detail.source) : null }));

  return NextResponse.json({
    id: lead.id,
    eventName: lead.eventName,
    clientName: lead.clientName,
    clientPhone: lead.clientPhone,
    clientEmail: lead.clientEmail,
    hasPhone: lead.signals.hasPhone,
    hasEmail: lead.signals.hasEmail,
    statusLabel: lead.statusLabel,
    stageLabel: STAGE_LABEL[lead.stage],
    eventDate: lead.eventDate,
    eventWhen,
    value: showMoney ? lead.value : null,
    gsUrl: `https://pro.goodshuffle.com/app/project/detail?id=${lead.id}`,
    state: cstate ? { label: STATE_LABEL[cstate.state], reason: cstate.reason ?? null, evidence: (cstate.source === "inbound_reply" || cstate.source === "notes") ? cstate.evidence ?? null : null, confidence: Math.round(cstate.confidence * 100) } : null,
    nba: nba ? { label: NBA_LABEL[nba.action], objective: nba.objective, doNot: nba.doNot ?? null, reason: nba.reason ?? null } : null,
    brief: brief && brief.opening ? { blocker: brief.blocker, opening: brief.opening, primaryQuestion: brief.primaryQuestion, watchFor: brief.watchFor, textDraft: brief.textDraft, email: brief.email } : null,
    feed,
    priority: { score: lead.priority.score, factors: lead.priority.factors },
    facts: {
      quoteCreated: lead.dateCreated ? formatYmdLong(lead.dateCreated) : "Unknown",
      quoteSent: lead.quoteSentDate ? `${formatYmdLong(lead.quoteSentDate)}${lead.signals.quoteAgeDays != null ? ` · ${lead.signals.quoteAgeDays}d ago` : ""}` : "Not sent yet",
      eventDate: lead.eventDate ? `${formatYmdLong(lead.eventDate)} · ${eventWhen}` : "Not set",
      deposit: showMoney && (lead.amountDue != null || lead.amountPaid != null) ? `${money(lead.amountPaid)} paid · ${money(lead.amountDue)} due` : null,
    },
    internalNotes: lead.internalNotes,
    clientNotes: lead.clientNotes,
    activity,
  });
}
