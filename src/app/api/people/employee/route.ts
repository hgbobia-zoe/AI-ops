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
import { createEmployee, getEmployee, getPolicy, listTasks, setEmployeeDepartment, setEmployeePhone } from "@/lib/people/store";
import { insertAudit } from "@/lib/db/repo";
import { toE164 } from "@/lib/notify/sms";
import { deriveWorkEmail, policyIssuesWorkEmail } from "@/lib/people/policy";
import { ensureSopLink } from "@/lib/people/sopAck";
import { announceNewHire, announceOffboardingStarted, announceOnboardingStarted, announceReady } from "@/lib/people/notify";

export const dynamic = "force-dynamic";

type Action = "create" | "start_onboarding" | "advance_ready" | "activate" | "start_offboarding" | "complete_offboarding" | "set_phone" | "set_policy";
const ACTIONS: Action[] = ["create", "start_onboarding", "advance_ready", "activate", "start_offboarding", "complete_offboarding", "set_phone", "set_policy"];

export async function POST(req: Request): Promise<NextResponse> {
  const role = await viewerRole();
  if (!canManageUsers(role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  let body: {
    action?: string;
    id?: string;
    displayName?: string;
    workEmail?: string;
    phone?: string | null;
    role?: string;
    department?: string;
    startDate?: string;
    effectiveDate?: string | null;
    startNow?: boolean;
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
    const name = (body.displayName ?? "").trim();
    if (!name) return NextResponse.json({ error: "displayName required" }, { status: 400 });
    const empRole = isRole(body.role) && body.role !== "guest" ? body.role : "member";
    // Intake by name: a role that gets a mailbox gets firstname.lastname@zoeeventsdmv.com unless one was typed.
    const policy = body.department ? getPolicy(body.department) : null;
    const typedEmail = (body.workEmail ?? "").trim();
    const workEmail = typedEmail || (policyIssuesWorkEmail(policy) ? deriveWorkEmail(name) : null);
    const rawPhone = (body.phone ?? "").trim();
    const phone = rawPhone ? toE164(rawPhone) : "";
    if (rawPhone && !phone) return NextResponse.json({ error: "Phone must be a full mobile number, like 301 555 0123." }, { status: 400 });
    const emp = createEmployee({
      displayName: name,
      workEmail,
      phone: phone || null,
      role: empRole,
      department: body.department ?? null,
      startDate: body.startDate ?? null,
    });
    // Convenience: optionally kick off onboarding immediately on create.
    announceNewHire(emp, policy?.name ?? null, actor);
    if (body.startNow && startOnboarding(emp.id, actor).ok) {
      const cur = getEmployee(emp.id) ?? emp;
      announceOnboardingStarted(cur, listTasks(emp.id, "provision"), ensureSopLink(cur), actor);
    }
    return NextResponse.json({ ok: true, id: emp.id, workEmail });
  }

  const id = (body.id ?? "").trim();
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  if (action === "set_phone" || action === "set_policy") {
    const cur = getEmployee(id);
    if (!cur) return NextResponse.json({ error: "not found" }, { status: 404 });
    if (action === "set_phone") {
      const raw = (body.phone ?? "").trim();
      const phone = raw ? toE164(raw) : "";
      if (raw && !phone) return NextResponse.json({ ok: false, message: "Phone must be a full mobile number, like 301 555 0123." }, { status: 400 });
      setEmployeePhone(id, phone || null);
      insertAudit({ actor, action: "PHONE_SET", entity: "employee", entityId: id, before: { phone: cur.phone }, after: { phone: phone || null } });
      return NextResponse.json({ ok: true, message: phone ? `Phone set to ${phone}.` : "Phone cleared." });
    }
    const dept = (body.department ?? "").trim();
    if (!dept || !getPolicy(dept)) return NextResponse.json({ ok: false, message: "Pick an access policy." }, { status: 400 });
    setEmployeeDepartment(id, dept);
    insertAudit({ actor, action: "POLICY_SET", entity: "employee", entityId: id, before: { department: cur.department }, after: { department: dept } });
    return NextResponse.json({ ok: true, message: `Policy set to ${getPolicy(dept)?.name ?? dept}.` });
  }

  const result =
    action === "start_onboarding" ? startOnboarding(id, actor)
    : action === "advance_ready" ? advanceToReady(id, actor)
    : action === "activate" ? activate(id, actor)
    : action === "start_offboarding" ? startOffboarding(id, actor, body.effectiveDate ?? null)
    : completeOffboarding(id, actor);

  const emp = result.ok ? getEmployee(id) : null;
  if (emp) {
    if (action === "start_onboarding") announceOnboardingStarted(emp, listTasks(id, "provision"), ensureSopLink(emp), actor);
    else if (action === "advance_ready") announceReady(emp, actor);
    else if (action === "start_offboarding") announceOffboardingStarted(emp, listTasks(id, "revoke"), body.effectiveDate ?? null, actor);
  }

  return NextResponse.json({ ok: result.ok, state: result.state, message: result.message }, { status: result.ok ? 200 : 409 });
}
