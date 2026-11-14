// Mark or clear "waiting on us" on a lead (owner, 2026-11-14). A marked lead is never auto closed as lost at
// 3 days to the event, and the morning text holds for a person. Records who marked or cleared it.
// Authenticated app users only (the session proxy guards non-public paths).
//   POST { id, on: true, note? }  → mark   |   POST { id, on: false } → clear   |   GET ?id= → current state

import { NextResponse } from "next/server";
import { currentActor } from "@/lib/auth/getSession";
import { getBookingById } from "@/lib/db/repo";
import { logSalesEvent } from "@/lib/salesos/audit";
import { clearWaiting, getWaitingMark, markWaiting, openAsks } from "@/lib/salesos/waitingOnUs";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<NextResponse> {
  const id = (new URL(req.url).searchParams.get("id") ?? "").trim();
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  return NextResponse.json({ ok: true, id, mark: getWaitingMark(id), openAsks: openAsks(id) });
}

export async function POST(req: Request): Promise<NextResponse> {
  let body: { id?: string; on?: boolean; note?: string | null };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const id = (body.id ?? "").trim();
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  if (typeof body.on !== "boolean") return NextResponse.json({ error: "on must be true or false" }, { status: 400 });
  if (!getBookingById(id)) return NextResponse.json({ error: "unknown project" }, { status: 404 });

  const actor = await currentActor();
  const who = actor.id === "anon" ? "Someone" : actor.label;
  if (body.on) {
    const mark = markWaiting(id, who, body.note ?? null);
    await logSalesEvent("WAITING_ON_US_MARKED", id, { note: mark.note }, who);
    return NextResponse.json({ ok: true, id, mark });
  }
  const cleared = clearWaiting(id, who);
  if (cleared) await logSalesEvent("WAITING_ON_US_CLEARED", id, {}, who);
  return NextResponse.json({ ok: true, id, mark: null, cleared });
}
