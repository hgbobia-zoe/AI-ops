// Export the Pipeline Status rows — one row per OPEN quote, with every raw fact incl. the last-activity
// and last-outbound timestamps. JSON (?format=json) or CSV (default). Session-gated by the proxy; the
// figures include money, so it is additionally Owner/Admin-only (financial), matching the blade.
// Read-only: it just serializes buildPipelineStatus(). Numbers are computed, never fabricated.

import { NextResponse } from "next/server";
import { buildPipelineStatus, type PipelineStatusRow } from "@/lib/salesos/execSummary";
import { viewerRole } from "@/lib/auth/getSession";
import { canSeeFinancials } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

const FIELDS: { key: string; get: (r: PipelineStatusRow) => string | number | null }[] = [
  { key: "booking_id", get: (r) => r.id },
  { key: "client_name", get: (r) => r.clientName || null },
  { key: "event_name", get: (r) => r.eventName || null },
  { key: "board_status", get: (r) => r.boardStatusLabel },
  { key: "customer_state", get: (r) => r.stateLabel },
  { key: "value_dollars", get: (r) => r.value },
  { key: "amount_due_dollars", get: (r) => r.amountDue },
  { key: "event_date", get: (r) => r.eventDate },
  { key: "days_to_event", get: (r) => r.daysToEvent },
  { key: "quote_sent_at", get: (r) => r.quoteSentAt ?? r.quoteSentDate },
  { key: "quote_opened_at", get: (r) => r.quoteOpenedAt },
  { key: "last_activity_at", get: (r) => r.lastActivity?.at ?? null },
  { key: "last_activity_channel", get: (r) => r.lastActivity?.channel ?? null },
  { key: "last_activity_direction", get: (r) => r.lastActivity?.direction ?? null },
  { key: "last_outbound_at", get: (r) => r.lastOutbound?.at ?? null },
  { key: "last_outbound_channel", get: (r) => r.lastOutbound?.channel ?? null },
  { key: "days_since_activity", get: (r) => r.daysSinceActivity },
  { key: "days_since_outbound", get: (r) => r.daysSinceOutbound },
  { key: "awaiting_reply", get: (r) => (r.awaitingReply ? 1 : 0) },
  { key: "opened_no_followup", get: (r) => (r.openedNoFollowup ? 1 : 0) },
  { key: "neglected_7d", get: (r) => (r.neglected7 ? 1 : 0) },
  { key: "neglected_14d", get: (r) => (r.neglected14 ? 1 : 0) },
];

// A missing fact is an empty CSV cell (honest "no record"), never a fabricated value.
function csvCell(v: string | number | null): string {
  if (v == null) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function GET(req: Request): Promise<NextResponse> {
  if (!canSeeFinancials(await viewerRole())) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const format = new URL(req.url).searchParams.get("format") === "json" ? "json" : "csv";
  const { summary, rows } = buildPipelineStatus();

  if (format === "json") {
    // Timeline omitted from the export payload (it powers the drawer, not the flat export); every scalar
    // row fact is included.
    const flat = rows.map((r) => Object.fromEntries(FIELDS.map((f) => [f.key, f.get(r)])));
    return NextResponse.json({ generatedAt: summary.generatedAt, summary, rows: flat });
  }

  const header = FIELDS.map((f) => f.key).join(",");
  const body = rows.map((r) => FIELDS.map((f) => csvCell(f.get(r))).join(",")).join("\n");
  const csv = `${header}\n${body}\n`;
  const stamp = summary.generatedAt.slice(0, 10);
  return new NextResponse(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="pipeline-status-${stamp}.csv"`,
      "cache-control": "no-store",
    },
  });
}
