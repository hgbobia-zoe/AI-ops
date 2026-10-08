// AI Control Plane — the Requests backlog API. POST files a request (a feature idea, question, or
// operational ask captured from a session); GET lists the backlog. Create is open to the responder
// (x-bridge-token) OR any signed staff (operate level) — anyone can file an idea, and the responder files
// what it classifies. Nothing here executes a production change; a request is a tracked record.

import { NextResponse } from "next/server";
import { createRequest, listRequests, countRequestsByStatus, REQUEST_TYPES, type AiRequestType, type AiRequestStatus } from "@/lib/ai/requests";
import { bridgeTokenValid } from "@/lib/ai/provider";
import { currentActor, viewerRole } from "@/lib/auth/getSession";
import { canOperateAi } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<NextResponse> {
  if (!bridgeTokenValid(req.headers.get("x-bridge-token")) && !canOperateAi(await viewerRole())) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const sp = new URL(req.url).searchParams;
  const status = sp.get("status") as AiRequestStatus | null;
  const type = sp.get("type") as AiRequestType | null;
  return NextResponse.json({
    ok: true,
    requests: listRequests({ status: status ?? undefined, type: type ?? undefined }),
    counts: countRequestsByStatus(),
  });
}

export async function POST(req: Request): Promise<NextResponse> {
  const tokenAuthed = bridgeTokenValid(req.headers.get("x-bridge-token"));
  if (!tokenAuthed && !canOperateAi(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  let body: { title?: string; type?: string; body?: string; blade?: string; sessionId?: string; requestedBy?: string; changeKey?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const title = (body.title ?? "").trim();
  if (!title) return NextResponse.json({ error: "title required" }, { status: 400 });
  const type = (body.type ?? "feature") as AiRequestType;
  if (!REQUEST_TYPES.includes(type)) return NextResponse.json({ error: "bad_type" }, { status: 400 });

  // A human filing attributes to themselves; the headless responder passes requestedBy explicitly.
  const requestedBy = tokenAuthed ? body.requestedBy ?? "AI responder" : (await currentActor()).label;

  const request = createRequest({
    title,
    type,
    body: body.body ?? null,
    blade: body.blade ?? null,
    sessionId: body.sessionId ?? null,
    requestedBy,
    changeKey: body.changeKey,
  });
  return NextResponse.json({ ok: true, request });
}
