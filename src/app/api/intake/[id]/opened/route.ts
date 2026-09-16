// Audit that the salesperson opened the created Goodshuffle quote (they go there to add inventory).

import { NextResponse } from "next/server";
import { getIntake } from "@/lib/intake/store";
import { logIntakeEvent } from "@/lib/intake/audit";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await params;
  if (!getIntake(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  await logIntakeEvent("GS_QUOTE_OPENED", id);
  return NextResponse.json({ ok: true });
}
