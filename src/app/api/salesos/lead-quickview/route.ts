// Compact lead detail for the board's side-drawer (Jira-style peek without leaving the board). Read-
// only; money fields omitted for Members. Proxy-gated to signed-in console users.

import { NextResponse } from "next/server";
import { getLead } from "@/lib/salesos/service";
import { getBookingById, getCustomerState, getCommsForLead } from "@/lib/db/repo";
import { resolveDeterministic, fromStored, replyMinutesAgo } from "@/lib/salesos/stateService";
import { nextBestAction, NBA_LABEL } from "@/lib/salesos/nba";
import { STATE_LABEL } from "@/lib/salesos/state";
import { STAGE_LABEL } from "@/lib/salesos/calc";
import { viewerRole } from "@/lib/auth/getSession";
import { canSeeFinancials } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

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

  const dte = lead.signals.daysToEvent;
  const eventWhen = dte == null ? "No event date" : dte < 0 ? `${Math.abs(dte)} days ago` : dte === 0 ? "Today" : dte === 1 ? "Tomorrow" : `In ${dte} days`;
  const conversation = getCommsForLead(id, 8).map((c) => ({ id: c.id, direction: c.direction, channel: c.channel, body: c.body ?? "", actor: c.actor, at: c.occurredAt ?? c.ts }));

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
    state: cstate ? { label: STATE_LABEL[cstate.state], reason: cstate.reason ?? null, evidence: cstate.source === "inbound_reply" ? cstate.evidence ?? null : null, confidence: Math.round(cstate.confidence * 100) } : null,
    nba: nba ? { label: NBA_LABEL[nba.action], objective: nba.objective, doNot: nba.doNot ?? null } : null,
    conversation,
  });
}
