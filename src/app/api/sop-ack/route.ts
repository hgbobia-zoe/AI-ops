// Public SOP sign off (no session): the random token in the body IS the credential. See lib/people/sopAck.ts.

import { NextResponse } from "next/server";
import { signSop } from "@/lib/people/sopAck";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  let body: { token?: string; name?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "Bad request." }, { status: 400 });
  }
  const token = String(body.token ?? "").slice(0, 100);
  const name = String(body.name ?? "").slice(0, 120);
  if (!token || !name.trim()) return NextResponse.json({ ok: false, error: "Type your full name." }, { status: 400 });
  const r = signSop(token, name);
  return NextResponse.json(r, { status: r.ok ? 200 : 400 });
}
