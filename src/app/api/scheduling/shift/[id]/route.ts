// Scheduling — update or delete one shift. Staff-only (proxy denies guests + requires a session on
// /api/*). Next.js 16: `params` is a Promise, so it's awaited.

import { NextResponse } from "next/server";
import { updateShift, deleteShift, type ShiftPatch } from "@/lib/scheduling/store";

export const dynamic = "force-dynamic";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await params;
  let body: ShiftPatch;
  try {
    body = (await req.json()) as ShiftPatch;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const shift = updateShift(id, body);
  if (!shift) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true, shift });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await params;
  deleteShift(id);
  return NextResponse.json({ ok: true });
}
