// Post-Event project actions — one POST dispatcher for every human action on a project. Each action is
// attributed to currentActor and records a structured artifact (transition, contact, review, issue).
//
//   move            — drag between columns (structured state transition; never just visual)
//   close           — terminal, REQUIRES a structured closure reason ('other' requires a note)
//   reopen          — bring a closed project back (edge case: customer responds after close)
//   contact         — log a contact attempt
//   review_request  — record a review request (idempotent: never double-send) + compose the warm invite
//   review_received — record that a review came in
//   issue_create / issue_update — service-recovery branch
//
// Review requests do NOT auto-send to the customer here. We record the request (the funnel fact) and
// notify the team internally; the outward SMS/email send reuses the Sales OS provider path and is a
// documented Phase 2 wire-up. Human-triggered only, with idempotency, so a customer is never double-asked.

import { NextResponse } from "next/server";
import {
  getProject,
  setState,
  setNextAction,
  closeProject,
  reopenProject,
  addContact,
  addReview,
  hasReviewRequest,
  createIssue,
  updateIssue,
  openIssueCounts,
  getConfig,
} from "@/lib/postevent/store";
import { deriveNextAction, projectFacts } from "@/lib/postevent/engine";
import { currentActor } from "@/lib/auth/getSession";
import { humanize } from "@/lib/salesos/outreach";
import { slackNotify } from "@/lib/notify/slack";
import {
  POSTEVENT_STATE_ORDER,
  isClosureReason,
  type PostEventState,
  type ContactInput,
  type IssueInput,
  type ReviewRequestChannel,
} from "@/lib/postevent/types";

export const dynamic = "force-dynamic";

interface Body {
  type: string;
  // move / reopen
  to?: PostEventState;
  note?: string;
  // close
  reason?: string;
  // contact
  contact?: ContactInput;
  // review
  channel?: ReviewRequestChannel;
  rating?: number | null;
  link?: string | null;
  force?: boolean;
  // issue
  issue?: IssueInput;
  issueId?: string;
}

function recomputeNext(id: string): void {
  const p = getProject(id)!;
  setNextAction(id, deriveNextAction(p.state, p.disposition, openIssueCounts().get(id) ?? 0));
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await params;
  const project = getProject(id);
  if (!project) return NextResponse.json({ error: "not_found" }, { status: 404 });

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const actor = (await currentActor()).label;

  switch (body.type) {
    case "move": {
      const to = body.to;
      if (!to || !(POSTEVENT_STATE_ORDER as string[]).includes(to)) return NextResponse.json({ error: "bad_state" }, { status: 400 });
      // A drag must never bypass the data a transition needs. These targets carry required structured data,
      // so the bare move is refused and the caller is told which flow to use (the board opens the dialog).
      if (to === "closed") return NextResponse.json({ error: "use_close", message: "Closing requires a structured closure reason." }, { status: 400 });
      if (to === "experience_confirmed" && !project.disposition)
        return NextResponse.json({ error: "needs_experience", message: "Record how the customer experienced the event before confirming." }, { status: 400 });
      if (to === "review_requested")
        return NextResponse.json({ error: "use_review_request", message: "Requesting a review records the destination, channel, and who asked. Use the review request flow." }, { status: 400 });
      if (to === "review_completed")
        return NextResponse.json({ error: "use_review_received", message: "Recording a completed review needs the review details. Use the review received flow." }, { status: 400 });
      if (project.state === "closed") reopenProject(id, to, actor, body.note);
      else setState(id, to, actor, body.note);
      recomputeNext(id);
      return NextResponse.json({ ok: true, project: getProject(id) });
    }

    case "reopen": {
      const to = body.to && (POSTEVENT_STATE_ORDER as string[]).includes(body.to) && body.to !== "closed" ? body.to : "customer_responded";
      reopenProject(id, to, actor, body.note ?? "Reopened after close");
      recomputeNext(id);
      return NextResponse.json({ ok: true, project: getProject(id) });
    }

    case "close": {
      const reason = body.reason;
      if (!isClosureReason(reason)) return NextResponse.json({ error: "bad_reason" }, { status: 400 });
      if (reason === "other" && !(body.note && body.note.trim())) return NextResponse.json({ error: "note_required", message: "A note is required when the closure reason is Other." }, { status: 400 });
      closeProject(id, reason, body.note ?? null, actor);
      return NextResponse.json({ ok: true, project: getProject(id) });
    }

    case "contact": {
      const c = addContact(id, body.contact ?? {}, actor);
      // A logged contact can advance the mechanical early states from the human's report.
      const fresh = getProject(id)!;
      if (fresh.state === "needs_follow_up" && c.direction === "outbound") setState(id, "follow_up_in_progress", "system", "Contact logged");
      const responded = ["customer_responded", "requested_callback", "positive", "issue_reported"].includes(c.outcome) || c.direction === "inbound";
      const now = getProject(id)!;
      if (responded && (now.state === "needs_follow_up" || now.state === "follow_up_in_progress")) setState(id, "customer_responded", "system", "Customer responded");
      recomputeNext(id);
      return NextResponse.json({ ok: true, contact: c, project: getProject(id) });
    }

    case "review_request": {
      // Idempotency: never double-ask unless explicitly forced.
      if (hasReviewRequest(id) && !body.force) return NextResponse.json({ error: "already_requested", message: "A review has already been requested for this project." }, { status: 409 });
      const cfg = getConfig();
      const facts = projectFacts(id);
      const destination = cfg.reviewDestinationLabel || cfg.reviewDestinationUrl || "our review page";
      const link = cfg.reviewDestinationUrl ? `\n\n${cfg.reviewDestinationUrl}` : "";
      const message = humanize(`${cfg.reviewTemplate}${link}`);
      const channel = body.channel ?? "sms";
      const rec = addReview({ bookingId: id, kind: "requested", employee: actor, channel, destination, message });
      setState(id, "review_requested", actor, `Review requested via ${channel}`);
      recomputeNext(id);
      // Internal team notice (safe; not customer-facing). Outward send is the documented Phase 2 wire-up.
      void slackNotify(`Review requested for ${facts.customer} (${facts.eventName}) by ${actor} via ${channel}.`);
      return NextResponse.json({ ok: true, review: rec, message, project: getProject(id) });
    }

    case "review_received": {
      const rec = addReview({ bookingId: id, kind: "received", employee: actor, rating: body.rating ?? null, link: body.link ?? null });
      setState(id, "review_completed", actor, "Review received");
      recomputeNext(id);
      return NextResponse.json({ ok: true, review: rec, project: getProject(id) });
    }

    case "issue_create": {
      const issue = createIssue(id, body.issue ?? {}, actor);
      // Surfacing an issue confirms the experience as an issue disposition if none set; keep human in control
      // of the exact grade, but ensure the project reflects that an issue exists.
      recomputeNext(id);
      void slackNotify(`Post-event issue opened on ${projectFacts(id).customer} by ${actor}: ${issue.issueType ?? "other"}.`);
      return NextResponse.json({ ok: true, issue, project: getProject(id) });
    }

    case "issue_update": {
      if (!body.issueId) return NextResponse.json({ error: "issue_id_required" }, { status: 400 });
      const issue = updateIssue(body.issueId, body.issue ?? {});
      if (!issue) return NextResponse.json({ error: "issue_not_found" }, { status: 404 });
      recomputeNext(id);
      return NextResponse.json({ ok: true, issue, project: getProject(id) });
    }

    default:
      return NextResponse.json({ error: "unknown_action", message: `Unknown action type: ${body.type}` }, { status: 400 });
  }
}
