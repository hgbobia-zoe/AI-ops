// Goodshuffle → app callback for a guided-intake project shell. The logged-in office session posts here
// after it creates (or fails to create) the project, so the intake record + the success screen learn the
// real project id/url. CORS-open to the Goodshuffle origin + GS_INGEST_TOKEN, same trust model as the
// other /api/gs/* ingest routes.

import { NextResponse } from "next/server";
import { getIntake, updateIntake } from "@/lib/intake/store";
import { logIntakeEvent } from "@/lib/intake/audit";

export const dynamic = "force-dynamic";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "https://pro.goodshuffle.com",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, x-publish-token",
  Vary: "Origin",
};

export function OPTIONS(): NextResponse {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function POST(req: Request): Promise<NextResponse> {
  const token = process.env.GS_INGEST_TOKEN;
  if (token && req.headers.get("x-publish-token") !== token) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: CORS });
  }
  let body: { intakeId?: string; projectId?: string; url?: string; contactId?: string; ok?: boolean; error?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400, headers: CORS });
  }
  const id = (body.intakeId ?? "").trim();
  if (!id || !getIntake(id)) return NextResponse.json({ error: "intake not found" }, { status: 404, headers: CORS });

  const now = new Date().toISOString();
  if (body.ok && body.projectId) {
    updateIntake(id, {
      status: "created",
      gsStatus: "created",
      gsProjectId: String(body.projectId),
      gsProjectUrl: body.url ?? `https://pro.goodshuffle.com/app/project/detail?id=${body.projectId}`,
      gsContactId: body.contactId ?? null,
      gsError: null,
      completedAt: now,
    });
    await logIntakeEvent("GS_SHELL_CREATED", id, { projectId: String(body.projectId) });
  } else {
    updateIntake(id, { status: "failed", gsStatus: "failed", gsError: (body.error ?? "unknown").slice(0, 300) });
    await logIntakeEvent("GS_SHELL_FAILED", id, { error: body.error ?? "unknown" });
  }
  return NextResponse.json({ ok: true }, { headers: CORS });
}
