// Warehouse-Desktop team check — REPORT. The office extension POSTs the upcoming signed projects it
// verified against GSPRO and found MISSING the Warehouse Desktop account on their team. This endpoint:
//   1. Slack-nags about them (deduped ~daily per project via wd_alerts, so a stuck one keeps
//      surfacing without spamming), and
//   2. re-queues an add_team_member op for each so the system self-heals on the next drain (unless an
//      add is already pending).
// The warehouse tablet/workstation only sees a project once Warehouse Desktop is on its team, so a
// missing one is a real gap. Slack is internal ops (not customer-facing), so it sends without approval.
// CORS-open to the GSPRO origin; same optional GS_INGEST_TOKEN as the other ingest endpoints.

import { NextResponse } from "next/server";
import { shouldAlertMissingWd, requeueWarehouseTeamAdd } from "@/lib/db/repo";
import { slackNotify } from "@/lib/notify/slack";

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

interface MissingProject {
  transactionId?: string | number;
  eventName?: string | null;
  eventDate?: string | null;
}

const detailUrl = (id: string): string => `https://pro.goodshuffle.com/app/project/detail?id=${id}`;

export async function POST(req: Request): Promise<NextResponse> {
  const publishToken = process.env.GS_INGEST_TOKEN;
  if (publishToken && req.headers.get("x-publish-token") !== publishToken) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: CORS });
  }
  let body: { checked?: number; missing?: MissingProject[] };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400, headers: CORS });
  }
  const missing = Array.isArray(body.missing) ? body.missing : [];

  const toAlert: { id: string; name: string; date: string | null }[] = [];
  let requeued = 0;
  for (const m of missing) {
    const id = m.transactionId != null ? String(m.transactionId) : "";
    if (!id) continue;
    const date = m.eventDate && /^\d{4}-\d{2}-\d{2}$/.test(m.eventDate) ? m.eventDate : null;
    // Self-heal: re-queue an add (no-op if one is already pending) so it's fixed on the next drain.
    if (requeueWarehouseTeamAdd(id)) requeued++;
    // Nag a human, throttled — in case the add keeps failing or someone is removing WD.
    if (shouldAlertMissingWd(id, date)) toAlert.push({ id, name: (m.eventName ?? "").toString().trim() || `Project ${id}`, date });
  }

  let slack: { ok: boolean; skipped?: boolean; error?: string } = { ok: true, skipped: true };
  if (toAlert.length > 0) {
    const lines = toAlert.map((p) => `• *${p.name}*${p.date ? ` — event ${p.date}` : ""} — ${detailUrl(p.id)}`);
    const text =
      `⚠️ Warehouse Desktop is missing from the GSPRO team on ${toAlert.length} upcoming signed ` +
      `project${toAlert.length === 1 ? "" : "s"}:\n${lines.join("\n")}\n` +
      `Re-queued the add — it should be fixed on the next Auto-Pull. If a project keeps reappearing here, ` +
      `someone may be removing Warehouse Desktop from its team.`;
    slack = await slackNotify(text);
  }

  return NextResponse.json(
    { ok: true, checked: typeof body.checked === "number" ? body.checked : missing.length, missing: missing.length, alerted: toAlert.length, requeued, slack },
    { headers: CORS },
  );
}
