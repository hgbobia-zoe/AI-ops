// Close one exception by a person's decision, from the Exceptions page. Owner/admin only. A reason is
// required and the signed-in person is recorded, so every hand close is justified and attributed.
//
// Body: { key: string, as: "resolved" | "disposed", reason: string }

import { NextResponse } from "next/server";
import { viewerRole, currentActor } from "@/lib/auth/getSession";
import { canManageSettings } from "@/lib/auth/roles";
import { disposeException } from "@/lib/exceptions/engine";
import { getException } from "@/lib/exceptions/store";
import { TERMINAL_STATUSES } from "@/lib/exceptions/types";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  const role = await viewerRole();
  if (!canManageSettings(role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  let body: { key?: string; as?: string; reason?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const key = (body.key ?? "").trim();
  const as = body.as === "resolved" ? "resolved" : body.as === "disposed" ? "disposed" : null;
  const reason = (body.reason ?? "").trim().slice(0, 500);
  if (!key || !as) return NextResponse.json({ error: "key and as (resolved or disposed) are required" }, { status: 400 });
  if (reason.length < 3) return NextResponse.json({ error: "Add a short reason so the close is on record." }, { status: 400 });

  const existing = getException(key);
  if (!existing) return NextResponse.json({ error: "exception not found" }, { status: 404 });
  if (TERMINAL_STATUSES.has(existing.status)) return NextResponse.json({ ok: true, status: existing.status, already: true });

  const by = (await currentActor()).label;
  const r = disposeException(key, reason, by, as);
  return NextResponse.json({ ok: !!r, status: r?.status ?? null });
}
