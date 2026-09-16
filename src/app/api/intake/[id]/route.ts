// Read / autosave one guided sales intake. PATCH persists whatever fields the wizard sends (whitelisted
// in the store); GET is used by the success screen to poll for the Goodshuffle result. Console-gated.

import { NextResponse } from "next/server";
import { getIntake, updateIntake } from "@/lib/intake/store";
import type { IntakePatch } from "@/lib/intake/types";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await params;
  const intake = getIntake(id);
  if (!intake) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ intake });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await params;
  if (!getIntake(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  let patch: IntakePatch;
  try {
    patch = (await req.json()) as IntakePatch;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  // Never let the client move the record into a created/terminal state by autosave — that only happens
  // via the create flow + the Goodshuffle result callback.
  delete (patch as Record<string, unknown>).status;
  delete (patch as Record<string, unknown>).gsProjectId;
  delete (patch as Record<string, unknown>).gsProjectUrl;
  delete (patch as Record<string, unknown>).gsStatus;
  const intake = updateIntake(id, patch);
  return NextResponse.json({ intake });
}
