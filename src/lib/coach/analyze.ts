// Analyze one call into a cached coaching recap. Shared by the auto-analyze route (the call being
// viewed), the backlog backfill, and the webhook. Idempotent: already-analyzed calls are a no-op;
// a call the model can't turn into a recap is marked attempted so nothing keeps retrying it forever.

import { getCallEventById, getCoachingAnalysis, saveCoachingAnalysis, resolveCallerName, markCoachingAttempted } from "@/lib/db/repo";
import { generateRecap } from "@/lib/coach/recap";

export type AnalyzeResult = "analyzed" | "already" | "no_transcript" | "failed";

export async function analyzeCall(id: string): Promise<AnalyzeResult> {
  const c = getCallEventById(id);
  if (!c || !c.transcript) return "no_transcript";
  if (getCoachingAnalysis(id)) return "already";
  const recap = await generateRecap({
    transcript: c.transcript,
    direction: c.direction,
    contactName: resolveCallerName(c),
    durationSec: c.durationSec,
    quoSummary: c.summary,
  });
  if (recap) {
    saveCoachingAnalysis(id, recap);
    return "analyzed";
  }
  markCoachingAttempted(id);
  return "failed";
}
