// Shift Pass management — list + create. Owner/Admin only (the proxy gates /api/passes as settings).
// Creating a pass mints an unguessable token and returns the shareable /pass/<token> link; the client
// shows it (copy) and can text it to the contractor via Quo (see ./send).

import { NextResponse } from "next/server";
import { listShiftPasses, createShiftPass } from "@/lib/db/repo";
import { newPassToken, passStatus } from "@/lib/auth/pass";
import { currentActor } from "@/lib/auth/getSession";
import { publicOrigin } from "@/lib/http/origin";

export const dynamic = "force-dynamic";

function withStatus(origin: string) {
  return (p: ReturnType<typeof listShiftPasses>[number]) => ({ ...p, status: passStatus(p), url: `${origin}/pass/${p.id}` });
}

export async function GET(req: Request): Promise<NextResponse> {
  const origin = publicOrigin(req);
  return NextResponse.json({ passes: listShiftPasses().map(withStatus(origin)) });
}

export async function POST(req: Request): Promise<NextResponse> {
  let body: { name?: string; expiresAt?: string; phone?: string; scope?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const name = (body.name ?? "").trim();
  if (!name) return NextResponse.json({ error: "name_required" }, { status: 400 });

  // driver = kiosk route checklist (mark progress); board = office dispatch board (view). Default driver.
  const scope = body.scope === "board" ? "board" : "driver";

  const ms = Date.parse((body.expiresAt ?? "").trim());
  if (!Number.isFinite(ms)) return NextResponse.json({ error: "bad_expiry" }, { status: 400 });
  if (ms <= Date.now() + 60_000) return NextResponse.json({ error: "expiry_in_past" }, { status: 400 });

  const actor = await currentActor();
  const pass = createShiftPass({
    id: newPassToken(),
    name,
    phone: (body.phone ?? "").trim() || null,
    scope,
    createdBy: actor.label,
    expiresAt: new Date(ms).toISOString(),
  });

  const origin = publicOrigin(req);
  return NextResponse.json({ pass: withStatus(origin)(pass) });
}
