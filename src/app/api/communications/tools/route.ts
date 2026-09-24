// The voice-agent tool registry + a guarded execution endpoint. GET returns the registry (names +
// permission classes). POST executes a tool THROUGH the enforcement layer — read-only tools run for
// real; controlled actions are gated and run only in dryRun (they report the decision, never fire an
// outward side effect). The AI can never bypass a permission: this is where the boundary is enforced.

import { NextResponse } from "next/server";
import { TOOL_REGISTRY } from "@/lib/comms/toolRegistry";
import { executeTool } from "@/lib/comms/tools";
import { currentActor } from "@/lib/auth/getSession";

export const dynamic = "force-dynamic";

export function GET(): NextResponse {
  return NextResponse.json({ tools: TOOL_REGISTRY });
}

export async function POST(req: Request): Promise<NextResponse> {
  let body: { tool?: string; input?: Record<string, unknown>; caller?: "sona" | "human" | "lab" };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!body.tool) return NextResponse.json({ error: "tool required" }, { status: 400 });
  const actor = await currentActor();
  // Force dryRun: this endpoint never performs an outward side effect. Going live for controlled actions
  // requires an explicit human-approval UI (future). Read-only tools return real data.
  const result = await executeTool(body.tool, body.input ?? {}, {
    caller: body.caller ?? "lab",
    actor: actor.label,
    dryRun: true,
  });
  return NextResponse.json(result);
}
