// Structured lead-intake receiver. EVERY external lead source (web form, Yelp, Google Business, any future
// source) POSTs here via its own Zapier webhook action. Each submission is RECORDED (a sales_intake row +
// an import-ledger line, so a lead is never lost), and — when the master switch is on and it is not a
// duplicate — it creates a Goodshuffle project by REUSING the guided-intake create_project gs_outbox op
// (the logged-in office session drains it and reports the id back to /api/gs/intake-result, which then
// enqueues the Goodshuffle welcome-template email). No email/LLM parsing: all sources send structured fields.
//
// Auth: a dedicated token header `x-intake-token` vs env INTAKE_TOKEN. Fail-CLOSED when INTAKE_TOKEN is
// set (must match, else 401); fail-OPEN until it is set, mirroring the GS_INGEST_TOKEN posture used by the
// other ingest endpoints (/api/gs/projects, /api/instawork/import). Added to the proxy PUBLIC allowlist
// (exact path) so a Zap can POST with no session — the token is the gate. CORS is permissive (Zapier has
// no fixed origin); it is not a security control.

import { NextResponse } from "next/server";
import { createIntake, updateIntake } from "@/lib/intake/store";
import { formatIntakeNotes, gsEventDetails, gsClientContact } from "@/lib/intake/format";
import { mdyFromYmd } from "@/lib/intake/gsItems";
import {
  normalizeLead,
  leadValidationError,
  toIntakePatch,
  webLeadEventName,
  webIntakeEnabled,
  webIntakeSalesPingEnabled,
  type WebLeadInput,
} from "@/lib/intake/webLead";
import { enqueueGsOp, recentLeadCreateOpExists } from "@/lib/db/repo";
import { logImport } from "@/lib/pull/state";
import { logIntakeEvent } from "@/lib/intake/audit";
import { notify } from "@/lib/notify/channels";
import { adaptLeadBody, newLeadSlackText } from "@/lib/intake/sourceAdapters";
import { postNewLeadToSlack } from "@/lib/intake/leadSlackReply";

export const dynamic = "force-dynamic";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, x-intake-token",
  Vary: "Origin",
};

export function OPTIONS(): NextResponse {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function POST(req: Request): Promise<NextResponse> {
  // Token gate: fail-closed once INTAKE_TOKEN is set, fail-open until then (GS_INGEST_TOKEN posture).
  const token = process.env.INTAKE_TOKEN;
  if (token && req.headers.get("x-intake-token") !== token) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: CORS });
  }

  // Query options a source Zap can set on the URL (so its webhook step needs no field mapping at all):
  //   ?source=google_ads  fills a missing source;  ?slack=1  posts the lead to #new-leads (for sources whose
  //   Zap no longer posts it);  ?dryRun=1  only parses and echoes the lead (for Zapier's "Test step").
  const url = new URL(req.url);
  const postToSlack = url.searchParams.get("slack") === "1";
  const dryRun = url.searchParams.get("dryRun") === "1";

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400, headers: CORS });
  }
  const { input: raw, yelp } = adaptLeadBody(body, url.searchParams.get("source") ?? "");

  const lead = normalizeLead(raw as WebLeadInput);
  const invalid = leadValidationError(lead);
  if (dryRun) {
    return NextResponse.json(
      { ok: !invalid, dryRun: true, error: invalid ?? undefined, eventName: webLeadEventName(lead), lead, slackText: postToSlack ? newLeadSlackText(lead, yelp) : undefined },
      { headers: CORS },
    );
  }
  if (invalid) return NextResponse.json({ error: invalid }, { status: 400, headers: CORS });

  // ALWAYS record the lead first (so nothing is lost, even while disabled or on a duplicate). The raw
  // source is stored on the row + echoed into the import ledger so the office can see volume per source.
  const intake = createIntake({ source: lead.source, ...toIntakePatch(lead) });

  // Post the lead to #new-leads first (before the project exists), so Viktor can reply under it with the
  // project link once Goodshuffle confirms. Never blocks the lead on a Slack failure.
  if (postToSlack) {
    await postNewLeadToSlack(lead.source, newLeadSlackText(lead, yelp)).catch(() => {});
  }

  // Gated OFF by default: accept + record, but do not create a project or send anything.
  if (!webIntakeEnabled()) {
    logImport(`intake:${lead.source}`, true, { rowsIn: 1, rowsWritten: 0, detail: "accepted (intake disabled)" });
    await logIntakeEvent("WEB_LEAD_DISABLED", intake.id, { source: lead.source });
    return NextResponse.json({ ok: true, created: false, reason: "intake disabled", intakeId: intake.id }, { headers: CORS });
  }

  // Dedupe: a create for the same contact within the window (default 10 minutes) → do not make a second project.
  if (recentLeadCreateOpExists(lead.emailKey, lead.phoneKey)) {
    logImport(`intake:${lead.source}`, true, { rowsIn: 1, rowsWritten: 0, rowsSkipped: 1, detail: "duplicate (within 10 minutes)" });
    await logIntakeEvent("WEB_LEAD_DUPLICATE", intake.id, { source: lead.source });
    return NextResponse.json({ ok: true, created: false, reason: "duplicate", intakeId: intake.id }, { headers: CORS });
  }

  // Build the create_project op by REUSING the guided-intake pipeline. Web leads carry no address, so no
  // location / logistics legs / line items (no inventory, no pricing on a raw lead); eventName uses the
  // web convention "LastName - EventType". The source tag is appended to the stashed notes.
  const eventName = webLeadEventName(lead);
  const details = { ...gsEventDetails(intake), eventName };
  const notes = `${formatIntakeNotes(intake)}\n\nLead source: ${lead.source} (web intake)`;
  // The welcome email is decided later, by /api/gs/intake-result, once the project really exists.

  enqueueGsOp({
    op: "create_project",
    label: `web lead (${lead.source}) ${eventName}`,
    payload: {
      intakeId: intake.id,
      eventName,
      notes,
      details,
      client: gsClientContact(intake), // create + attach the customer (web leads carry name/email/phone)
      eventDateMDY: mdyFromYmd(lead.eventDate),
      addItems: [],
      windowUpgrade: null,
      location: null,
      logisticsLegs: [],
      // Web-lead specifics (ignored by the drainer; read by our own code):
      kind: "web_lead",
      source: lead.source,
      leadEmail: lead.emailKey,
      leadPhone: lead.phoneKey,
    },
  });
  updateIntake(intake.id, { status: "creating", gsStatus: "queued" });
  logImport(`intake:${lead.source}`, true, { rowsIn: 1, rowsWritten: 1, detail: `queued create: ${eventName}` });
  await logIntakeEvent("WEB_LEAD_QUEUED", intake.id, { source: lead.source, name: eventName });

  // Optional quiet sales-ai ping (default OFF). Honest wording: the project is QUEUED, not yet created
  // (the office session creates it on its next pull) — never claim a project that does not exist yet.
  if (webIntakeSalesPingEnabled()) {
    void notify("sales", `New ${lead.source} lead received, project queued: ${eventName}`).catch(() => {});
  }

  return NextResponse.json({ ok: true, created: true, reason: "queued", intakeId: intake.id }, { headers: CORS });
}
