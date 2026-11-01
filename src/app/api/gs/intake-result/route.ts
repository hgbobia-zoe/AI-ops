// Goodshuffle → app callback for a guided-intake project shell. The logged-in office session posts here
// after it creates (or fails to create) the project, so the intake record + the success screen learn the
// real project id/url. CORS-open to the Goodshuffle origin + GS_INGEST_TOKEN, same trust model as the
// other /api/gs/* ingest routes.

import { NextResponse } from "next/server";
import { getIntake, updateIntake } from "@/lib/intake/store";
import { logIntakeEvent } from "@/lib/intake/audit";
import { enqueueGsOp, webLeadAckForIntake, recentEmailSendOpExists } from "@/lib/db/repo";
import { notify } from "@/lib/notify/channels";
import { replyToLeadPostSoon } from "@/lib/intake/leadSlackReply";

export const dynamic = "force-dynamic";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "https://pro.goodshuffle.com",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, x-publish-token",
  Vary: "Origin",
};

export function OPTIONS(): NextResponse {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function POST(req: Request): Promise<NextResponse> {
  const token = process.env.GS_INGEST_TOKEN;
  if (token && req.headers.get("x-publish-token") !== token) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: CORS });
  }
  let body: { intakeId?: string; projectId?: string; url?: string; contactId?: string; ok?: boolean; error?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400, headers: CORS });
  }
  const id = (body.intakeId ?? "").trim();
  const existing = id ? getIntake(id) : null;
  if (!id || !existing) return NextResponse.json({ error: "intake not found" }, { status: 404, headers: CORS });

  const now = new Date().toISOString();
  // A SECOND, different project for an intake that already has one is a duplicate (two drainers raced, e.g.
  // an older extension without the claim step). Keep the first project as the record and tell ops which one
  // to delete, instead of silently re-pointing the intake at the newer copy.
  if (body.ok && body.projectId && existing.gsProjectId && String(existing.gsProjectId) !== String(body.projectId)) {
    const dup = String(body.projectId);
    await logIntakeEvent("GS_DUPLICATE_PROJECT", id, { kept: String(existing.gsProjectId), duplicate: dup });
    void notify(
      "ops",
      `Duplicate Goodshuffle project for one lead. Keep ${existing.gsProjectId}, delete ${dup}: https://pro.goodshuffle.com/app/project/detail?id=${dup}`,
    ).catch(() => {});
    return NextResponse.json({ ok: true, duplicate: true }, { headers: CORS });
  }
  if (body.ok && body.projectId) {
    updateIntake(id, {
      status: "created",
      gsStatus: "created",
      gsProjectId: String(body.projectId),
      gsProjectUrl: body.url ?? `https://pro.goodshuffle.com/app/project/detail?id=${body.projectId}`,
      gsContactId: body.contactId ?? null,
      gsError: null,
      completedAt: now,
    });
    await logIntakeEvent("GS_SHELL_CREATED", id, { projectId: String(body.projectId) });
    // Web leads: Viktor replies under the lead's #new-leads post with the project link (once; no-op otherwise).
    replyToLeadPostSoon(id);
    // WEB-LEAD extension: a lead from the structured receiver (/api/intake/lead) carries an acknowledgement
    // email in its create_project op payload. Now that Goodshuffle has CONFIRMED the project id, enqueue the
    // ack as an email_send op (the proven GS email write-back) so it only ever fires once the project really
    // exists. Guided intakes carry no ack (webLeadAckForIntake returns null) and are unaffected. The office
    // session threads it into the project's client email; see the caveat in the PR notes if no thread exists.
    const ack = webLeadAckForIntake(id);
    // Idempotency: the office session may report the same created project back more than once (a retry, a
    // lost-response re-POST, a re-pull). Dedup on consume is producer-side only (recentEmailSendOpExists),
    // so guard the ack enqueue here too — otherwise a repeat callback would send the customer two acks.
    const ackDedupeKey = `weback:${id}`;
    if (ack && !recentEmailSendOpExists(ackDedupeKey)) {
      enqueueGsOp({
        op: "email_send",
        transactionId: String(body.projectId),
        label: "web lead acknowledgement",
        payload: { content: ack.content, subject: ack.subject || undefined, dedupeKey: ackDedupeKey },
      });
    }
  } else {
    updateIntake(id, { status: "failed", gsStatus: "failed", gsError: (body.error ?? "unknown").slice(0, 300) });
    await logIntakeEvent("GS_SHELL_FAILED", id, { error: body.error ?? "unknown" });
  }
  return NextResponse.json({ ok: true }, { headers: CORS });
}
