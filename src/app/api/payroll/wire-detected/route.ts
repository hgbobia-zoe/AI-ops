// Mercury "wire out to Gusto" webhook — the "wire sent" alert in the owner's end-to-end payroll automation.
// A Zapier workflow (Mercury New Transaction trigger → a filter) POSTs the matching transaction here. We
// classify it as a Gusto payroll wire, best-effort correlate the amount to the current/last payroll period,
// persist the event (deduped by transactionId), and post ONCE to the payroll Slack channel in the shared
// payroll Slack voice so the team knows the wire went out and can confirm it in Gusto. The persisted record
// is the seam for the FUTURE "confirm the wire in Gusto" automation.
//
// Auth: dedicated header `x-wire-token` vs env WIRE_WEBHOOK_TOKEN. Fail-CLOSED once WIRE_WEBHOOK_TOKEN is set
// (must match, else 401); fail-OPEN until it is set — the SAME posture as INTAKE_TOKEN / GS_INGEST_TOKEN on
// the other inbound webhooks. Added to the proxy PUBLIC allowlist (exact path) so a Zap can POST with no
// session; the token is the gate. CORS is permissive (Zapier has no fixed origin) and is not a security
// control — server-to-server, no browser involved.
//
// Idempotency: transactionId is the dedup key. Mercury may re-deliver the same transaction as its status
// moves pending → sent, and Zapier retries on any non-2xx. We post exactly once on the first qualifying
// event, update the stored record on later deliveries WITHOUT re-posting, and post one concise update only if
// the status later becomes "failed". A non-matching body returns 200 {ignored:true} and posts nothing.

import { NextResponse } from "next/server";
import { getPayrollConfig } from "@/lib/payroll/config";
import {
  normalizeMercuryTxn,
  classifyWire,
  payrollPeriodCandidates,
  matchWireAmount,
  readWireEvent,
  upsertWireEvent,
  mergeWireRecord,
  wireAlertCard,
  wireFailedCard,
  formatUsd,
  type WirePeriodMatch,
} from "@/lib/payroll/wireEvent";
import { postPayrollCard } from "@/lib/payroll/slack";
import { logImport } from "@/lib/pull/state";

export const dynamic = "force-dynamic";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, x-wire-token",
  Vary: "Origin",
};

export function OPTIONS(): NextResponse {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function POST(req: Request): Promise<NextResponse> {
  // Token gate: fail-closed once WIRE_WEBHOOK_TOKEN is set, fail-open until then (INTAKE_TOKEN posture).
  const token = process.env.WIRE_WEBHOOK_TOKEN;
  if (token && req.headers.get("x-wire-token") !== token) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: CORS });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400, headers: CORS });
  }

  const txn = normalizeMercuryTxn(raw);
  if (!txn.transactionId) {
    return NextResponse.json({ error: "transactionId required" }, { status: 400, headers: CORS });
  }

  // Classify (defense in depth: Zapier pre-filters, but we re-check). Non-matching → record nothing, post
  // nothing, just acknowledge so Zapier does not retry.
  const cfg = getPayrollConfig();
  const cls = classifyWire(txn, cfg);
  if (!cls.isPayrollWire) {
    return NextResponse.json({ ok: true, ignored: true, reason: cls.reason }, { headers: CORS });
  }

  // Best-effort period correlation. NEVER blocks and NEVER fabricates: a failure here just leaves the period
  // unconfirmed in the alert.
  let match: WirePeriodMatch | null = null;
  try {
    match = matchWireAmount(cls.amountAbs, await payrollPeriodCandidates());
  } catch {
    /* best-effort */
  }

  const now = new Date().toISOString();
  const existing = readWireEvent(txn.transactionId);
  const rec = mergeWireRecord(txn, cls, match, existing, now);
  const isFailed = (txn.status ?? "") === "failed";

  let posted = false;
  let note: string;
  if (!existing || !existing.postedToSlack) {
    // First qualifying event for this transactionId → announce once.
    const res = await postPayrollCard(wireAlertCard(rec), `wire:${rec.transactionId}`);
    if (res.ok) {
      rec.postedToSlack = true;
      rec.postedAt = now;
      posted = true;
    }
    note = res.ok ? "posted" : "post failed (will retry on next delivery)";
  } else if (isFailed && !existing.failureNotified) {
    // We already announced the wire; it has now gone to "failed" → one concise follow-up.
    const res = await postPayrollCard(wireFailedCard(rec), `wire-failed:${rec.transactionId}`);
    if (res.ok) {
      rec.failureNotified = true;
      posted = true;
    }
    note = res.ok ? "posted failed update" : "failed-update post failed";
  } else {
    note = "already announced, record updated, no re-post";
  }

  upsertWireEvent(rec);

  try {
    logImport("payroll_wire", true, {
      rowsIn: 1,
      rowsWritten: 1,
      detail: `${txn.counterpartyName ?? "?"} ${formatUsd(cls.amountAbs)} ${note}${match ? ` [${match.periodLabel}]` : " [period unconfirmed]"}`,
    });
  } catch {
    /* the ledger is observability only; never fail the webhook on it */
  }

  return NextResponse.json(
    {
      ok: true,
      ignored: false,
      posted,
      postedToSlack: rec.postedToSlack,
      matchedPeriod: rec.matchedPeriod,
    },
    { headers: CORS },
  );
}
