// Historical-call import — one batched step of the crawl (see src/lib/coach/importHistory.ts). The
// client loops this until done. Owner/admin only (proxy-gated /api/coaching/*).

import { NextResponse } from "next/server";
import { importHistoryStep } from "@/lib/coach/importHistory";
import { openphoneApiKey } from "@/lib/comms/openphone";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(): Promise<NextResponse> {
  if (!openphoneApiKey()) return NextResponse.json({ done: true, imported: 0, checked: 0, total: 0, phase: "unconfigured" });
  const step = await importHistoryStep();
  return NextResponse.json(step);
}
