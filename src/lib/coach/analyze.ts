// Analyze one call into a cached coaching recap. Shared by the auto-analyze route (the call being
// viewed), the backlog backfill, and the webhook. Idempotent: already-analyzed calls are a no-op;
// a call the model can't turn into a recap is marked attempted so nothing keeps retrying it forever.

import { getCallEventById, getCoachingAnalysis, saveCoachingAnalysis, resolveCallerName, markCoachingAttempted, updateCallContent } from "@/lib/db/repo";
import { generateRecap } from "@/lib/coach/recap";
import { computeCallMetrics } from "@/lib/coach/metrics";
import { getCallSummary } from "@/lib/comms/openphone";

export type AnalyzeResult = "analyzed" | "already" | "no_transcript" | "too_short" | "failed";

// A call needs at least this much said before there's anything to coach — below it (voicemails,
// hang-ups, 4-second calls) we don't waste an LLM call and don't show a scary "couldn't generate".
const MIN_COACH_WORDS = 20;

export async function analyzeCall(id: string): Promise<AnalyzeResult> {
  const c = getCallEventById(id);
  if (!c || !c.transcript) return "no_transcript";

  // The summary is Quo's — fetch it if we don't have it yet (a copy, not a generation).
  if (!c.summary && c.providerId) {
    const s = await getCallSummary(c.providerId);
    if (s) {
      updateCallContent(id, { summary: s });
      c.summary = s;
    }
  }

  if (getCoachingAnalysis(id)) return "already";

  // Too short to coach — mark it so the backfill moves on, but it's not an error.
  if (computeCallMetrics(c.transcript, null).words < MIN_COACH_WORDS) {
    markCoachingAttempted(id);
    return "too_short";
  }

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
