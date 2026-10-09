// Self-Improvement Controller API — one run's detail + its full lifecycle event trail (gate 11).

import { NextResponse } from "next/server";
import { getRun, listRunEvents } from "@/lib/ai/improvement/store";
import { bridgeTokenValid } from "@/lib/ai/provider";
import { viewerRole } from "@/lib/auth/getSession";
import { canViewAi } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  if (!bridgeTokenValid(req.headers.get("x-bridge-token")) && !canViewAi(await viewerRole())) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await ctx.params;
  const run = getRun(id);
  if (!run) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true, run, events: listRunEvents(id) });
}
