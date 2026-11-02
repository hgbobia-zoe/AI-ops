// People Lifecycle — employee create + lifecycle transitions. Owner/admin only (canManageUsers; the proxy
// also gates /api/people). This is a thin wrapper over the pure engine: the machine guards every
// transition, the engine materializes tasks + audits. Nothing new executes here.

import { NextResponse } from "next/server";
import { currentActor, viewerRole } from "@/lib/auth/getSession";
import { canManageUsers, isRole } from "@/lib/auth/roles";
import {
  activate,
  advanceToReady,
  completeOffboarding,
  startOffboarding,
  startOnboarding,
} from "@/lib/people/lifecycle";
import { createEmployee, getEmployee, getPolicy, listTasks } from "@/lib/people/store";
import { deriveWorkEmail, policyIssuesWorkEmail } from "@/lib/people/policy";
import { displayNameFor, normalizeIntake, saveIntake } from "@/lib/people/intake";
import { ensureSopLink } from "@/lib/people/sopAck";
import { announceNewHire, announceOffboardingStarted, announceOnboardingStarted, announceReady } from "@/lib/people/notify";

export const dynamic = "force-dynamic";

type Action = "create" | "start_onboarding" | "advance_ready" | "activate" | "start_offboarding" | "complete_offboarding";
const ACTIONS: Action[] = ["create", "start_onboarding", "advance_ready", "activate", "start_offboarding", "complete_offboarding"];

export async function POST(req: Request): Promise<NextResponse> {
  const role = await viewerRole();
  if (!canManageUsers(role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  let body: {
    action?: string;
    id?: string;
    displayName?: string;
    workEmail?: string;
    role?: string;
    department?: string;
    startDate?: string;
    effectiveDate?: string | null;
    startNow?: boolean;
    intake?: Record<string, unknown>;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const action = body.action as Action | undefined;
  if (!action || !ACTIONS.includes(action)) return NextResponse.json({ error: "bad_action" }, { status: 400 });
  const actor = (await currentActor()).label;

  if (action === "create") {
    // Full intake (preferred): validate it and take the name + phone from it.
    let intake = null;
    if (body.intake) {
      const n = normalizeIntake(body.intake, new Date().toISOString().slice(0, 10));
      if (!n.ok) return NextResponse.json({ error: n.errors.join(" ") }, { status: 400 });
      intake = n.intake;
    }
    const name = intake ? displayNameFor(intake) : (body.displayName ?? "").trim();
    if (!name) return NextResponse.json({ error: "displayName required" }, { status: 400 });
    const empRole = isRole(body.role) && body.role !== "guest" ? body.role : "member";
    // Intake by name: a role that gets a mailbox gets firstname.lastname@zoeeventsdmv.com unless one was typed.
    const policy = body.department ? getPolicy(body.department) : null;
    const typedEmail = (body.workEmail ?? "").trim();
    const workEmail = typedEmail || (policyIssuesWorkEmail(policy) ? deriveWorkEmail(name) : null);
    const emp = createEmployee({
      displayName: name,
      workEmail,
      phone: intake?.phone ?? null,
      role: empRole,
      department: body.department ?? null,
      startDate: body.startDate ?? null,
    });
    if (intake) saveIntake(emp.id, intake);
    // Convenience: optionally kick off onboarding immediately on create.
    announceNewHire(emp, policy?.name ?? null);
    if (body.startNow && startOnboarding(emp.id, actor).ok) {
      const cur = getEmployee(emp.id) ?? emp;
      announceOnboardingStarted(cur, listTasks(emp.id, "provision"), ensureSopLink(cur));
    }
    return NextResponse.json({ ok: true, id: emp.id, workEmail });
  }

  const id = (body.id ?? "").trim();
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const result =
    action === "start_onboarding" ? startOnboarding(id, actor)
    : action === "advance_ready" ? advanceToReady(id, actor)
    : action === "activate" ? activate(id, actor)
    : action === "start_offboarding" ? startOffboarding(id, actor, body.effectiveDate ?? null)
    : completeOffboarding(id, actor);

  const emp = result.ok ? getEmployee(id) : null;
  if (emp) {
    if (action === "start_onboarding") announceOnboardingStarted(emp, listTasks(id, "provision"), ensureSopLink(emp));
    else if (action === "advance_ready") announceReady(emp);
    else if (action === "start_offboarding") announceOffboardingStarted(emp, listTasks(id, "revoke"), body.effectiveDate ?? null);
  }

  return NextResponse.json({ ok: result.ok, state: result.state, message: result.message }, { status: result.ok ? 200 : 409 });
}
