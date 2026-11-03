// Zoe login link back. The Zoe platform step mints a one-time /join invite; the hire then creates their
// own login. The invite row records which user accepted it (acceptedUserId), so this reads that back and
// links the login onto the employee. Without the link, offboarding could not turn the login off.
//
// The step stays "in progress" until the invite is actually accepted (the gate closes on the real
// condition, not when the link was made). An invite that expires unused fails the step so it can be retried.
// Reads auth/invites only through its exported getter; nothing under src/lib/auth is changed.

import { getInvite } from "@/lib/auth/invites";
import { getUser } from "@/lib/auth/users";
import { insertAudit } from "@/lib/db/repo";
import { getEmployee, linkEmployee, listTasks, updateTask } from "./store";
import type { Employee } from "./types";

/** The invite token inside a task's externalRef ("/join?token=X" or a full URL). PURE. */
export function inviteTokenFromRef(ref: string | null | undefined): string | null {
  if (!ref) return null;
  const m = /[?&]token=([A-Za-z0-9_-]+)/.exec(ref);
  return m ? m[1] : null;
}

export type ZoeLinkOutcome = "already_linked" | "linked" | "waiting" | "expired" | "no_invite";

function audit(actor: string, action: string, entityId: string, after: unknown): void {
  try {
    insertAudit({ actor, action, entity: "employee", entityId, before: null, after });
  } catch {
    /* audit best effort */
  }
}

/**
 * Link the Zoe login for one employee if their invite has been accepted. Idempotent and safe to call on
 * every page view and tick. Never overwrites an existing link.
 */
export function reconcileZoeLogin(employeeId: string, now: Date = new Date()): ZoeLinkOutcome {
  const emp = getEmployee(employeeId);
  if (!emp) return "no_invite";
  const task = listTasks(emp.id, "provision").find((t) => t.adapterId === "zoe_platform");
  if (emp.userId) {
    // Linked already (by matching or an earlier pass). Close a still-open invite step if that login is live.
    if (task && task.status === "in_progress" && getUser(emp.userId)?.active) {
      updateTask(task.id, { status: "completed", error: null, completedAt: now.toISOString() });
    }
    return "already_linked";
  }
  const token = inviteTokenFromRef(task?.externalRef);
  if (!task || !token) return "no_invite";
  const invite = getInvite(token);
  if (!invite) return "no_invite";

  if (invite.acceptedUserId) {
    linkEmployee(emp.id, "user_id", invite.acceptedUserId);
    const user = getUser(invite.acceptedUserId);
    const actor = `${emp.displayName} (accepted the invite)`;
    if (task.status !== "completed") {
      updateTask(task.id, { status: "completed", error: null, actor, completedAt: invite.acceptedAt ?? now.toISOString() });
      audit(actor, "ACCESS_GRANTED", `${emp.id}:zoe_platform`, { status: "completed", source: "invite_accepted", detail: `Login ${user?.username ?? invite.acceptedUserId} created.` });
    }
    audit("People Lifecycle", "IDENTITY_LINKED", `${emp.id}:zoe_platform`, { field: "user_id", value: invite.acceptedUserId, detail: `Linked Zoe login ${user?.username ?? invite.acceptedUserId} from the accepted invite.` });
    return "linked";
  }

  if (Date.parse(invite.expiresAt) < now.getTime()) {
    if (task.status === "in_progress") {
      updateTask(task.id, { status: "failed", error: "The invite expired before it was used. Retry to make a new link." });
    }
    return "expired";
  }
  return "waiting";
}

/** Reconcile every employee that has an open Zoe invite. For the runtime tick. */
export function reconcileAllZoeLogins(employees: Employee[], now: Date = new Date()): number {
  let linked = 0;
  for (const e of employees) {
    if (e.lifecycleState === "OFFBOARDED") continue;
    if (reconcileZoeLogin(e.id, now) === "linked") linked++;
  }
  return linked;
}
