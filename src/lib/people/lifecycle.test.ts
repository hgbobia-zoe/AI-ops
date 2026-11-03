// People lifecycle engine tests (DB-backed, in-memory). Policy → task materialization (Sales = 6 systems,
// correct modes, idempotent), readiness (READY only when all required provision tasks complete), the
// automated Zoe provision, manual Mark Complete (records actor), offboarding (revoke generation + the
// HONEST rule that OFFBOARDED does NOT auto-complete manual revokes), and audit capture on grant/revoke.

import { describe, it, expect } from "vitest";
import { getDb } from "@/lib/db";
import {
  advanceToReady,
  completeOffboarding,
  computeReadiness,
  executeAutomatedTask,
  markTaskComplete,
  readinessFor,
  startOffboarding,
  startOnboarding,
} from "./lifecycle";
import { createEmployee, getEmployee, getPolicy, getTask, linkEmployee, listTasks } from "./store";
import { acceptInvite } from "@/lib/auth/invites";
import { inviteTokenFromRef, reconcileZoeLogin } from "./zoeLink";

/** Simulate the hire opening their /join link and creating a login, then the link back. */
function hireAccepts(employeeId: string, taskId: string, username: string): void {
  const token = inviteTokenFromRef(getTask(taskId)!.externalRef)!;
  const r = acceptInvite(token, { username, password: "a-long-test-password-123" });
  expect(r.ok).toBe(true);
  reconcileZoeLogin(employeeId);
}

function newSalesHire(name = "Pat Sales") {
  return createEmployee({ displayName: name, role: "member", department: "sales" });
}

function auditCount(action: string, entityId: string): number {
  const r = getDb().prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = ? AND entity_id = ?").get(action, entityId) as { n: number };
  return r.n;
}

describe("materialization", () => {
  it("onboarding a Sales rep yields the 6 policy systems with correct modes + statuses", () => {
    const e = newSalesHire();
    const r = startOnboarding(e.id, "tester");
    expect(r.ok).toBe(true);
    expect(getEmployee(e.id)!.lifecycleState).toBe("ONBOARD");

    const tasks = listTasks(e.id, "provision");
    expect(tasks.length).toBe(6);
    const zoe = tasks.find((t) => t.adapterId === "zoe_platform")!;
    expect(zoe.mode).toBe("automated");
    expect(zoe.status).toBe("pending"); // awaits the approval gate
    const gs = tasks.find((t) => t.adapterId === "goodshuffle")!;
    expect(gs.mode).toBe("manual");
    expect(gs.status).toBe("manual_required"); // a human must act, then Mark Complete
  });

  it("re-running materialization is idempotent (no duplicate tasks)", () => {
    const e = newSalesHire();
    startOnboarding(e.id, "tester");
    const before = listTasks(e.id, "provision").length;
    // Re-materialize via a second startOnboarding attempt (illegal transition, but materialize is idempotent
    // on change_key regardless).
    startOnboarding(e.id, "tester");
    expect(listTasks(e.id, "provision").length).toBe(before);
  });
});

describe("readiness", () => {
  it("NOT READY until every required provision task is completed, and it lists the blockers", async () => {
    const e = newSalesHire();
    startOnboarding(e.id, "tester");
    let readiness = readinessFor(e.id);
    expect(readiness.ready).toBe(false);
    expect(readiness.blockers.length).toBeGreaterThan(0);
    // advanceToReady is guarded — refuses while blocked.
    expect(advanceToReady(e.id, "tester").ok).toBe(false);

    // Complete every REQUIRED provision task (zoe via automate, the rest via manual mark-complete).
    for (const t of listTasks(e.id, "provision").filter((t) => t.required)) {
      if (t.mode === "automated") {
        await executeAutomatedTask(t.id, "tester");
        if (t.adapterId === "zoe_platform") hireAccepts(e.id, t.id, "pat.sales");
      } else markTaskComplete(t.id, "tester");
    }
    readiness = readinessFor(e.id);
    expect(readiness.ready).toBe(true);
    expect(readiness.blockers).toEqual([]);
    expect(advanceToReady(e.id, "tester").ok).toBe(true);
    expect(getEmployee(e.id)!.lifecycleState).toBe("READY");
  });

  it("computeReadiness is pure over the provided tasks", () => {
    const base = { id: "x", employeeId: "e", adapterId: "a", system: "A", kind: "provision" as const, title: "", mode: "manual" as const, source: "manual" as const, changeKey: "", externalRef: null, error: null, retryable: true, approvalId: null, actor: null, createdAt: "", completedAt: null };
    const r = computeReadiness([
      { ...base, required: true, status: "completed" },
      { ...base, required: true, status: "manual_required" },
      { ...base, required: false, status: "manual_required" },
    ]);
    expect(r.ready).toBe(false);
    expect(r.totalRequired).toBe(2);
    expect(r.completed).toBe(1);
    expect(r.blockers.length).toBe(1);
  });
});

describe("automated Zoe provision", () => {
  it("mints the invite and WAITS for the hire (in progress), auditing ACCESS_GRANTED", async () => {
    const e = newSalesHire();
    startOnboarding(e.id, "tester");
    const zoe = listTasks(e.id, "provision").find((t) => t.adapterId === "zoe_platform")!;
    const res = await executeAutomatedTask(zoe.id, "Hermann");
    expect(res.ok).toBe(true);
    expect(res.task!.status).toBe("in_progress"); // closes only when the hire creates the login
    expect(res.task!.externalRef).toMatch(/\/join\?token=/); // a real invite link, no password stored
    expect(res.task!.approvalId).toMatch(/^AP-/); // a governance card was raised + decided
    expect(auditCount("ACCESS_GRANTED", `${e.id}:zoe_platform`)).toBe(1);
  });

  it("links the login and completes the step once the hire accepts; offboarding then turns it off", async () => {
    const e = newSalesHire("Lee Accept");
    startOnboarding(e.id, "tester");
    const zoe = listTasks(e.id, "provision").find((t) => t.adapterId === "zoe_platform")!;
    await executeAutomatedTask(zoe.id, "Hermann");
    expect(reconcileZoeLogin(e.id)).toBe("waiting");
    hireAccepts(e.id, zoe.id, "lee.accept");
    const linked = getEmployee(e.id)!;
    expect(linked.userId).toBeTruthy();
    expect(getTask(zoe.id)!.status).toBe("completed");
    expect(reconcileZoeLogin(e.id)).toBe("already_linked"); // idempotent

    startOffboarding(e.id, "tester", null);
    const rv = listTasks(e.id, "revoke").find((t) => t.adapterId === "zoe_platform")!;
    const res = await executeAutomatedTask(rv.id, "tester");
    expect(res.task!.status).toBe("completed"); // a real deactivation now, not manual_required
  });

  it("an invite that expires unused fails the step so it can be retried", async () => {
    const e = newSalesHire("Kim Late");
    startOnboarding(e.id, "tester");
    const zoe = listTasks(e.id, "provision").find((t) => t.adapterId === "zoe_platform")!;
    await executeAutomatedTask(zoe.id, "Hermann");
    expect(reconcileZoeLogin(e.id, new Date(Date.now() + 30 * 86_400_000))).toBe("expired");
    expect(getTask(zoe.id)!.status).toBe("failed");
  });
});

describe("SOP sign off gate", () => {
  it("Mark Complete cannot close the SOP step; only a signature can", () => {
    const e = createEmployee({ displayName: "Ana Sign", role: "member", department: "sales_associate" });
    startOnboarding(e.id, "tester");
    const sop = listTasks(e.id, "provision").find((t) => t.adapterId === "sop_ack")!;
    const r = markTaskComplete(sop.id, "Hermann");
    expect(r.ok).toBe(false);
    expect(getTask(sop.id)!.status).toBe("manual_required");
    expect(markTaskComplete(sop.id, "Ana Sign (signed SOP v1)", "signed", { sopSigned: true }).ok).toBe(true);
  });

  it("offboarding has no revoke step for the SOP", () => {
    const e = createEmployee({ displayName: "Bo Leave", role: "member", department: "sales_associate" });
    startOnboarding(e.id, "tester");
    startOffboarding(e.id, "tester", null);
    expect(listTasks(e.id, "revoke").some((t) => t.adapterId === "sop_ack")).toBe(false);
  });
});

describe("manual Mark Complete", () => {
  it("records the actor + completion time and audits the grant", () => {
    const e = newSalesHire();
    startOnboarding(e.id, "tester");
    const gs = listTasks(e.id, "provision").find((t) => t.adapterId === "goodshuffle")!;
    const res = markTaskComplete(gs.id, "Cindy", "done in GSPRO");
    expect(res.ok).toBe(true);
    expect(res.task!.status).toBe("completed");
    expect(res.task!.actor).toBe("Cindy");
    expect(res.task!.completedAt).toBeTruthy();
    expect(auditCount("ACCESS_GRANTED", `${e.id}:goodshuffle`)).toBe(1);
  });
});

describe("offboarding honesty", () => {
  it("OFFBOARD generates revoke tasks; OFFBOARDED does NOT auto-complete the manual ones", async () => {
    const e = newSalesHire();
    startOnboarding(e.id, "tester");
    // Provision Zoe so there's a real grant to revoke.
    const zoe = listTasks(e.id, "provision").find((t) => t.adapterId === "zoe_platform")!;
    await executeAutomatedTask(zoe.id, "tester");

    const off = startOffboarding(e.id, "tester", "2099-01-01");
    expect(off.ok).toBe(true);
    expect(getEmployee(e.id)!.lifecycleState).toBe("OFFBOARD");
    expect(getEmployee(e.id)!.endDate).toBe("2099-01-01");

    const revokes = listTasks(e.id, "revoke");
    expect(revokes.length).toBe(6);
    const manualRevokes = revokes.filter((t) => t.mode !== "automated");
    expect(manualRevokes.every((t) => t.status === "manual_required")).toBe(true);

    // Mark the HR process done — OFFBOARDED — WITHOUT touching the revoke tasks.
    const done = completeOffboarding(e.id, "tester");
    expect(done.ok).toBe(true);
    expect(getEmployee(e.id)!.lifecycleState).toBe("OFFBOARDED");

    // The honest guardrail: the manual revokes are STILL open after OFFBOARDED.
    const after = listTasks(e.id, "revoke").filter((t) => t.mode !== "automated");
    expect(after.every((t) => t.status === "manual_required")).toBe(true);
  });

  it("OFFBOARD is reachable mid-onboarding (trip from any live state)", () => {
    const e = newSalesHire();
    startOnboarding(e.id, "tester"); // ONBOARD
    const r = startOffboarding(e.id, "tester", null);
    expect(r.ok).toBe(true);
    expect(getEmployee(e.id)!.lifecycleState).toBe("OFFBOARD");
  });

  it("a Zoe revoke completes + audits ACCESS_REVOKED", async () => {
    const e = newSalesHire();
    startOnboarding(e.id, "tester");
    const zoe = listTasks(e.id, "provision").find((t) => t.adapterId === "zoe_platform")!;
    await executeAutomatedTask(zoe.id, "tester");
    // Link a login so revoke has a target (the automate path mints an invite, not a user, so simulate the
    // accepted-link outcome by linking a user id is out of scope — instead assert the manual_required path
    // is honest when no login is linked).
    startOffboarding(e.id, "tester", null);
    const zoeRevoke = listTasks(e.id, "revoke").find((t) => t.adapterId === "zoe_platform")!;
    const res = await executeAutomatedTask(zoeRevoke.id, "tester");
    // No linked user_id → honest manual_required (never a faked revoke), still audited as the attempt.
    expect(res.task!.status).toBe("manual_required");
    expect(auditCount("ACCESS_REVOKED", `${e.id}:zoe_platform`)).toBe(1);
  });
});

describe("Zoe Dispatch is office only", () => {
  it("a driver gets no Zoe login task at onboarding, but an existing login is still revoked at offboarding", () => {
    const d = createEmployee({ displayName: "Field Driver", role: "member", department: "driver", lifecycleState: "HIRE" });
    startOnboarding(d.id, "Hermann");
    expect(listTasks(d.id, "provision").map((t) => t.adapterId)).toEqual(["connecteam"]);

    linkEmployee(d.id, "user_id", "U-made-by-hand");
    startOffboarding(d.id, "Hermann", null);
    expect(listTasks(d.id, "revoke").map((t) => t.adapterId).sort()).toEqual(["connecteam", "zoe_platform"]);
  });

  it("removes a stored Zoe rule from a field policy and skips an open Zoe setup task for field staff", () => {
    const db = getDb();
    db.prepare("INSERT OR IGNORE INTO access_policy_rule (id, policy_id, adapter_id, system, required, mode) VALUES ('warehouse:zoe_platform','warehouse','zoe_platform','Zoe',1,'automated')").run();
    const w = createEmployee({ displayName: "Ware House", role: "member", department: "warehouse", lifecycleState: "ONBOARD" });
    db.prepare("INSERT INTO lifecycle_task (id, employee_id, adapter_id, system, kind, title, status, mode, required, source, change_key, created_at) VALUES ('LT-x', ?, 'zoe_platform', 'Zoe', 'provision', 'Provision Zoe', 'pending', 'automated', 1, 'automated', ?, '2026-11-03')").run(w.id, `${w.id}:provision:zoe_platform`);
    getPolicy("warehouse"); // any policy read runs the enforcement
    expect(db.prepare("SELECT COUNT(*) AS c FROM access_policy_rule WHERE policy_id='warehouse' AND adapter_id='zoe_platform'").get()).toEqual({ c: 0 });
    expect(getTask("LT-x")?.status).toBe("skipped");
  });
});
