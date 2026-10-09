// AI Org — per-employee operational settings. Owner/admin only. Today it carries ONE honest, persisted
// knob: PAUSE an employee (operational on/off). A paused employee reads as intentionally off in the org
// chart and its proposer produces nothing (see proposers.ts). This does NOT edit the code-reviewed
// employee config — it only writes an id into settings.aiPaused. No AI/bridge-token path (human cookie
// only), so an agent can never pause or un-pause itself.

import { NextResponse } from "next/server";
import { viewerRole, currentActor } from "@/lib/auth/getSession";
import { canManageSettings } from "@/lib/auth/roles";
import { getSettings, saveSettings } from "@/lib/settings";
import { AI_EMPLOYEES } from "@/lib/aiorg/registry";
import { insertAudit } from "@/lib/db/repo";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  if (!canManageSettings(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  let body: { id?: string; paused?: boolean };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const id = (body.id ?? "").trim();
  const paused = body.paused === true;
  if (!id || !AI_EMPLOYEES.some((e) => e.id === id)) {
    return NextResponse.json({ error: "unknown_agent" }, { status: 400 });
  }

  const settings = getSettings();
  const set = new Set(settings.aiPaused ?? []);
  if (paused) set.add(id);
  else set.delete(id);
  const nextPaused = [...set];
  saveSettings({ ...settings, aiPaused: nextPaused });

  try {
    insertAudit({
      actor: (await currentActor()).label,
      action: paused ? "AI_AGENT_PAUSED" : "AI_AGENT_RESUMED",
      entity: "ai_employee",
      entityId: id,
      after: { paused },
    });
  } catch {
    /* best-effort audit */
  }

  return NextResponse.json({ ok: true, id, paused });
}
