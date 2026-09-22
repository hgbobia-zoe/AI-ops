// Zoe Visual DNA — GET the live config, POST to save it. Editing is owner/admin only (it changes the house
// look every future image inherits), so the write is role-gated in addition to the proxy's staff gate.

import { NextResponse } from "next/server";
import { getVisualDNA, saveVisualDNA, resetVisualDNA } from "@/lib/creative/visualDna";
import { viewerRole } from "@/lib/auth/getSession";
import { canManageSettings } from "@/lib/auth/roles";
import type { ZoeVisualDNA } from "@/lib/creative/types";

export const dynamic = "force-dynamic";

export function GET(): NextResponse {
  return NextResponse.json({ dna: getVisualDNA() });
}

export async function POST(req: Request): Promise<NextResponse> {
  if (!canManageSettings(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  let body: { dna?: Partial<ZoeVisualDNA>; reset?: boolean };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const dna = body.reset ? resetVisualDNA() : saveVisualDNA(body.dna ?? {});
  return NextResponse.json({ ok: true, dna });
}
