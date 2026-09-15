// Nightly batch re-analysis of open leads' customer state from full context (activity log + messages),
// so a lead that was actually reached doesn't sit as a false "Dormant". Triggered by a scheduled job
// (GitHub Actions cron at midnight EST) with a bearer token — NOT a console route. Bounded + best-effort:
// each lead is independent, one failure never aborts the run. Read + AI only; nothing is sent to anyone.

import { NextResponse } from "next/server";
import { getOpenLeads } from "@/lib/db/repo";
import { reanalyzeLead } from "@/lib/salesos/stateService";
import { llmConfigured } from "@/lib/llm";
import { todayInOpsTz } from "@/lib/dates";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAX_LEADS = 200; // safety cap on a single run

function authorized(req: Request): boolean {
  const secret = process.env.REANALYZE_TOKEN?.trim();
  if (!secret) return false; // fail closed — no token configured means no batch runs
  const url = new URL(req.url);
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  const header = req.headers.get("x-reanalyze-token")?.trim();
  const query = url.searchParams.get("token")?.trim();
  return bearer === secret || header === secret || query === secret;
}

export async function POST(req: Request): Promise<NextResponse> {
  if (!process.env.REANALYZE_TOKEN?.trim()) {
    return NextResponse.json({ error: "Batch re-analyze isn't configured (set REANALYZE_TOKEN)." }, { status: 503 });
  }
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!llmConfigured()) return NextResponse.json({ error: "The AI model isn't configured (set ANTHROPIC_API_KEY)." }, { status: 400 });

  const started = Date.now();
  const leads = getOpenLeads(todayInOpsTz()).slice(0, MAX_LEADS);
  let analyzed = 0;
  let changedToActive = 0; // moved OFF dormant thanks to the notes
  let failed = 0;

  // Sequential — the LLM has per-minute limits, and this runs overnight with no one waiting.
  for (const b of leads) {
    try {
      const resolved = await reanalyzeLead(b.bookingId);
      analyzed++;
      if (resolved && resolved.state !== "DORMANT" && resolved.source === "notes") changedToActive++;
    } catch {
      failed++;
    }
  }

  return NextResponse.json({
    ok: true,
    considered: leads.length,
    analyzed,
    reclassifiedFromNotes: changedToActive,
    failed,
    tookMs: Date.now() - started,
  });
}
