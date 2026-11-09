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
import { normalizeLead, leadValidationError, webLeadEventName, type WebLeadInput } from "@/lib/intake/webLead";
import { logImport } from "@/lib/pull/state";
import { adaptLeadBody, newLeadSlackText } from "@/lib/intake/sourceAdapters";
import { parseLeadBodyText } from "@/lib/intake/lenientBody";
import { queueLeadProject } from "@/lib/intake/queueLead";

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
    // ?soft=1 (see below) turns even this into a 200 {ok:false}, so a rotated token can never stop a Zap's
    // customer auto-reply; the body still says "unauthorized".
    const soft = new URL(req.url).searchParams.get("soft") === "1";
    return NextResponse.json(soft ? { ok: false, created: false, error: "unauthorized" } : { error: "unauthorized" }, { status: soft ? 200 : 401, headers: CORS });
  }

  // Query options a source Zap can set on the URL (so its webhook step needs no field mapping at all):
  //   ?source=google_ads  fills a missing source;  ?slack=1  posts the lead to #new-leads (for sources whose
  //   Zap no longer posts it);  ?dryRun=1  only parses and echoes the lead (for Zapier's "Test step").
  //   ?soft=1  never answers with an error status: a webhook step that errors stops the rest of the Zap,
  //   and a Zap that also auto-replies to the customer (Yelp) must keep running whatever happens here.
  const url = new URL(req.url);
  const postToSlack = url.searchParams.get("slack") === "1";
  const dryRun = url.searchParams.get("dryRun") === "1";
  const soft = url.searchParams.get("soft") === "1";
  const fail = (error: string, status: number) =>
    NextResponse.json(soft ? { ok: false, created: false, error } : { error }, { status: soft ? 200 : status, headers: CORS });

  // Lenient: a Zap that pastes form fields into a JSON template breaks on a message with a line break or a
  // quote. Read those bodies anyway rather than losing the lead.
  const text = await req.text().catch(() => "");
  const body = parseLeadBodyText(text, req.headers.get("content-type") ?? "");
  if (body == null) {
    try {
      logImport(`intake:${url.searchParams.get("source") || "unknown"}`, false, { rowsIn: 1, rowsWritten: 0, detail: `unreadable body (${text.length} chars)` });
    } catch {
      /* observability only */
    }
    return fail("invalid_json", 400);
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
  if (invalid) return fail(invalid, 400);

  // Record, post to #new-leads (?slack=1), dedupe and queue the Goodshuffle project: the shared lead tail.
  const r = await queueLeadProject(lead, { slackText: postToSlack ? newLeadSlackText(lead, yelp) : null });
  return NextResponse.json({ ok: r.ok, created: r.created, reason: r.reason, intakeId: r.intakeId }, { headers: CORS });
}
