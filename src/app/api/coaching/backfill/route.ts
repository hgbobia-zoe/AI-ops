// Coaching backfill — analyze a small batch of un-analyzed calls per request. New calls auto-analyze
// on the OpenPhone webhook; this drains the pre-existing backlog. Kept to a few per call so each
// request stays well within timeouts; the client (BackfillDriver) loops until the backlog is clear.
// Owner/admin only — enforced by the proxy for /api/coaching/*. Key-gated: no-ops without an LLM.

import { NextResponse } from "next/server";
import { listUnanalyzedCoachableCalls, saveCoachingAnalysis, countUnanalyzedCoachableCalls } from "@/lib/db/repo";
import { generateRecap } from "@/lib/coach/recap";
import { llmConfigured } from "@/lib/llm";

export const dynamic = "force-dynamic";
export const maxDuration = 120; // allow the batch's sequential LLM calls to finish

export async function POST(req: Request): Promise<NextResponse> {
  if (!llmConfigured()) {
    return NextResponse.json({ done: true, disabled: true, analyzed: 0, remaining: countUnanalyzedCoachableCalls() });
  }
  const url = new URL(req.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 3, 1), 6);

  const batch = listUnanalyzedCoachableCalls(limit);
  let analyzed = 0;
  for (const c of batch) {
    const recap = await generateRecap({
      transcript: c.transcript,
      direction: c.direction,
      contactName: c.contactName,
      durationSec: c.durationSec,
    });
    if (recap) {
      saveCoachingAnalysis(c.id, recap);
      analyzed++;
    }
  }
  const remaining = countUnanalyzedCoachableCalls();
  // done when the backlog is clear, or when this batch made no progress (avoids an infinite client
  // loop on calls the model can't turn into a recap — they're left for a future run).
  const done = remaining === 0 || (batch.length > 0 && analyzed === 0) || batch.length === 0;
  return NextResponse.json({ done, analyzed, remaining, batch: batch.length });
}
