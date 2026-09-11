// Analyze a single call on demand — fired automatically when its board is opened (no button). The
// board's AutoAnalyze client posts here; owner/admin only (proxy-gated /api/coaching/*). Idempotent.

import { NextResponse } from "next/server";
import { analyzeCall } from "@/lib/coach/analyze";
import { llmConfigured } from "@/lib/llm";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(req: Request): Promise<NextResponse> {
  if (!llmConfigured()) return NextResponse.json({ ok: false, result: "unconfigured" });
  let body: { callId?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const callId = String(body.callId ?? "");
  if (!callId) return NextResponse.json({ error: "callId required" }, { status: 400 });
  const result = await analyzeCall(callId);
  return NextResponse.json({ ok: result === "analyzed" || result === "already", result });
}
