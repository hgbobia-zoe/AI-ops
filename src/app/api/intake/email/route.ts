// Email to hello@ → the same lead experience as the website form. A Gmail Zap ("New Email" on the hello@
// inbox, with a search that already drops promotions/social/updates) POSTs the raw email here with an EMPTY
// Data field. We decide, cheapest first:
//   1. free rules (emailLead.ts): our own mail, automated / bulk mail, replies, platform notices, pitches;
//   2. free lookups: the sender is already a Goodshuffle customer or open lead (Sales OS owns them), or we
//      already made a project for this sender (never two);
//   3. one short Haiku call (emailClassify.ts) for what is left, to confirm intent and read the event details.
// A confirmed new inquiry goes through the SAME tail as a web form lead (queueLead.ts): record, #new-leads
// post, Goodshuffle project, then the "New Webform Submission" welcome email from inside that project.
// Anything unclear is never auto-answered: it is posted for a person to look at (with ?slack=1).
//
// Query: ?dryRun=1 decides and echoes, with no side effects (for Zapier's Test step). ?slack=1 posts leads and
// "needs a look" emails to #new-leads. ?soft=1 never answers with an error status.
// Auth: x-intake-token vs INTAKE_TOKEN, exactly like /api/intake/lead. Kill switch: EMAIL_INTAKE=false.
// GET (token required, fail-closed) lists the recent decisions so the team can audit what was skipped.

import { NextResponse } from "next/server";
import { parseLeadBodyText } from "@/lib/intake/lenientBody";
import { parseInboundEmail, ruleVerdict, leadInputFromEmail, emailLeadSlackText, type InboundEmail } from "@/lib/intake/emailLead";
import { classifyEmail, LEAD_CONFIDENCE, type EmailClassification } from "@/lib/intake/emailClassify";
import { normalizeLead, leadValidationError, webLeadEventName } from "@/lib/intake/webLead";
import { queueLeadProject } from "@/lib/intake/queueLead";
import { newLeadsChannel } from "@/lib/intake/leadSlackReply";
import { contactOwner } from "@/lib/prospecting/contactOwnership";
import { recentLeadCreateOpExists } from "@/lib/db/repo";
import { logImport } from "@/lib/pull/state";
import { getJson, setJson } from "@/lib/kv";
import { flagOn } from "@/lib/flags";
import { slackBotConfigured, slackPostAs } from "@/lib/notify/slack";
import { todayInOpsTz } from "@/lib/dates";

export const dynamic = "force-dynamic";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, x-intake-token",
  Vary: "Origin",
};

/** "Never two projects for the same sender": a create for this contact at any time counts. */
const EVER_MS = 10 * 365 * 24 * 60 * 60 * 1000;
const RECENT_KEY = "intake.email.recent";
const RECENT_MAX = 200;

export type EmailDecision = "lead" | "review" | "skip";

export interface EmailDecisionRecord {
  at: string;
  from: string;
  subject: string;
  decision: EmailDecision;
  reason: string;
  by: "rules" | "lookup" | "model";
  intakeId?: string;
  created?: boolean;
}

function remember(r: EmailDecisionRecord): void {
  try {
    const list = getJson<EmailDecisionRecord[]>(RECENT_KEY, []);
    setJson(RECENT_KEY, [r, ...list].slice(0, RECENT_MAX));
    logImport("intake:email", true, { rowsIn: 1, rowsWritten: r.created ? 1 : 0, rowsSkipped: r.created ? 0 : 1, detail: `${r.decision}: ${r.reason}`.slice(0, 200) });
  } catch {
    /* observability only */
  }
}

export function OPTIONS(): NextResponse {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function GET(req: Request): Promise<NextResponse> {
  const token = process.env.INTAKE_TOKEN;
  if (!token || req.headers.get("x-intake-token") !== token) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: CORS });
  return NextResponse.json({ ok: true, recent: getJson<EmailDecisionRecord[]>(RECENT_KEY, []) }, { headers: CORS });
}

async function postForReview(e: InboundEmail, why: string): Promise<void> {
  if (!slackBotConfigured()) return;
  const text = [
    "Possible lead by email to hello@. No project made and nothing sent, please take a look.",
    `From: ${e.fromName ? `${e.fromName} ` : ""}<${e.fromEmail}>`,
    e.subject ? `Subject: ${e.subject}` : "",
    `Why it is held: ${why}`,
    e.body ? `Message: ${e.body.slice(0, 400)}${e.body.length > 400 ? "..." : ""}` : "",
  ].filter(Boolean).join("\n");
  await slackPostAs(newLeadsChannel(), { name: "Email Triage", icon: ":email:" }, text).catch(() => {});
}

export async function POST(req: Request): Promise<NextResponse> {
  const url = new URL(req.url);
  const soft = url.searchParams.get("soft") === "1";
  const dryRun = url.searchParams.get("dryRun") === "1";
  const postToSlack = url.searchParams.get("slack") === "1";
  const fail = (error: string, status: number) =>
    NextResponse.json(soft ? { ok: false, created: false, error } : { error }, { status: soft ? 200 : status, headers: CORS });

  const token = process.env.INTAKE_TOKEN;
  if (token && req.headers.get("x-intake-token") !== token) return fail("unauthorized", 401);
  if (!flagOn("EMAIL_INTAKE")) return NextResponse.json({ ok: true, created: false, decision: "skip", reason: "email intake is off (EMAIL_INTAKE=false)" }, { headers: CORS });

  const text = await req.text().catch(() => "");
  const body = parseLeadBodyText(text, req.headers.get("content-type") ?? "");
  if (body == null) return fail("invalid_json", 400);
  const email = parseInboundEmail(body);
  const base = { at: new Date().toISOString(), from: email.fromEmail, subject: email.subject.slice(0, 140) };

  const answer = (rec: EmailDecisionRecord, extra: Record<string, unknown> = {}) => {
    if (!dryRun) remember(rec);
    return NextResponse.json({ ok: true, dryRun: dryRun || undefined, created: !!rec.created, decision: rec.decision, reason: rec.reason, by: rec.by, intakeId: rec.intakeId, ...extra }, { headers: CORS });
  };

  // 1. Free rules.
  const rules = ruleVerdict(email);
  if (rules.decision === "skip") return answer({ ...base, decision: "skip", reason: `${rules.reason}: ${rules.detail}`, by: "rules" });

  // 2. Free lookups: Sales OS already owns this contact, or we already made a project for this sender.
  const owner = contactOwner({ email: email.fromEmail });
  if (owner.owner === "salesos") return answer({ ...base, decision: "skip", reason: `existing_contact: ${owner.reason}`, by: "lookup" });
  if (recentLeadCreateOpExists(email.fromEmail.toLowerCase(), "", EVER_MS)) {
    return answer({ ...base, decision: "skip", reason: "already_lead: a project was already made for this sender", by: "lookup" });
  }

  // 3. One cheap model call to confirm intent and read the details. Without a model, the rules decide alone.
  const cls: EmailClassification | null = await classifyEmail(email, todayInOpsTz());
  let decision: EmailDecision;
  let reason: string;
  let by: EmailDecisionRecord["by"];
  if (cls) {
    by = "model";
    if (cls.intent === "new_inquiry" && cls.confidence >= LEAD_CONFIDENCE) {
      decision = "lead";
      reason = `new inquiry (${Math.round(cls.confidence * 100)}%): ${cls.summary}`;
    } else if (cls.intent === "new_inquiry" || (cls.intent === "other" && rules.decision === "lead")) {
      decision = "review";
      reason = `maybe an inquiry (${Math.round(cls.confidence * 100)}%): ${cls.summary}`;
    } else {
      decision = "skip";
      reason = `not_a_lead (${cls.intent}): ${cls.summary}`;
    }
  } else {
    by = "rules";
    decision = rules.decision === "lead" ? "lead" : "review";
    reason = rules.decision === "lead" ? `reads like a rental inquiry (${rules.signals.positive} signs)` : `unclear (${rules.signals.positive} rental signs, ${rules.signals.negative} other)`;
  }

  const lead = normalizeLead(leadInputFromEmail(email, cls ?? {}));
  const invalid = leadValidationError(lead);
  if (decision === "lead" && invalid) {
    decision = "review";
    reason = `${reason} (no way to reach them: ${invalid})`;
  }

  if (dryRun) {
    return answer({ ...base, decision, reason, by }, { eventName: decision === "lead" ? webLeadEventName(lead) : undefined, lead: decision === "lead" ? lead : undefined, email: { from: email.fromEmail, name: email.fromName, subject: email.subject, body: email.body.slice(0, 500) } });
  }

  if (decision === "skip") return answer({ ...base, decision, reason, by });
  if (decision === "review") {
    if (postToSlack) await postForReview(email, reason);
    return answer({ ...base, decision, reason, by });
  }

  const r = await queueLeadProject(lead, {
    slackText: postToSlack ? emailLeadSlackText(lead, email) : null,
    dedupeWindowMs: EVER_MS,
    notesExtra: "Came in by email to hello@. Read the original in the inbox before replying.",
  });
  return answer({ ...base, decision, reason, by, intakeId: r.intakeId, created: r.created }, { eventName: r.eventName, queueReason: r.reason });
}
