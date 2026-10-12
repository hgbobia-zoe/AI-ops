// End-to-end: the People engine drives the REAL Connecteam automation and the replay enqueue, and the
// Phase-1 approval gate + audit front BOTH. Confirms materialization snapshots the live adapter capability
// (so a verified Connecteam scope / a captured replay endpoint makes those tasks automated), that approving
// a Connecteam task performs the real create (mocked) + stores the link, and that approving a replay task
// enqueues a provision_user op (never a faked completion).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/lib/db";
import { setSecret } from "@/lib/secrets";
import { executeAutomatedTask, startOnboarding } from "./lifecycle";
import { createEmployee, getEmployee, listTasks } from "./store";
import { PROVISION_ENDPOINTS } from "./provisioningEndpoints";

function mockFetch(status: number, body: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body })));
}
function auditCount(action: string, entityId: string): number {
  return (getDb().prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = ? AND entity_id = ?").get(action, entityId) as { n: number }).n;
}

beforeEach(() => {
  process.env.CONNECTEAM_API_KEY = "test-key";
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.CONNECTEAM_API_KEY;
  getDb().prepare("DELETE FROM secrets").run();
  PROVISION_ENDPOINTS.goodshuffle.provision = null;
});

describe("Connecteam automated provision through the engine", () => {
  it("verified scope → the onboarding task is automated, approving it creates + links + audits", async () => {
    setSecret("connecteam.provisioningScope", "verified");
    const e = createEmployee({ displayName: "Sam Crew", role: "member", department: "warehouse", phone: "+12025559900" });
    startOnboarding(e.id, "tester");

    const ct = listTasks(e.id, "provision").find((t) => t.adapterId === "connecteam")!;
    expect(ct.mode).toBe("automated"); // materialization snapshotted the LIVE capability
    expect(ct.status).toBe("pending"); // awaits the approval gate

    mockFetch(200, { data: { results: [{ userId: 9001 }] } });
    const res = await executeAutomatedTask(ct.id, "Hermann");
    expect(res.ok).toBe(true);
    expect(res.task!.status).toBe("completed");
    expect(res.task!.approvalId).toMatch(/^AP-/); // the governance card fronted it
    expect(getEmployee(e.id)!.connecteamUserId).toBe(9001); // link stored
    expect(auditCount("ACCESS_GRANTED", `${e.id}:connecteam`)).toBe(1);
  });
});

describe("Goodshuffle replay provision through the engine", () => {
  it("captured endpoint → the task is automated; approving it enqueues a provision_user op (never completed)", async () => {
    PROVISION_ENDPOINTS.goodshuffle.provision = { method: "POST", path: "/app/team/invite", bodyType: "form" };
    const e = createEmployee({ displayName: "Lee Rep", role: "member", department: "sales" });
    startOnboarding(e.id, "tester");

    const gs = listTasks(e.id, "provision").find((t) => t.adapterId === "goodshuffle")!;
    expect(gs.mode).toBe("automated"); // replay-ready

    const res = await executeAutomatedTask(gs.id, "Hermann");
    expect(res.ok).toBe(true);
    expect(res.task!.status).toBe("in_progress"); // queued for the drainer; NOT a faked completion
    expect(res.task!.approvalId).toMatch(/^AP-/); // still approval-gated
    const n = (getDb().prepare("SELECT COUNT(*) AS n FROM gs_outbox WHERE op = 'provision_user'").get() as { n: number }).n;
    expect(n).toBe(1);
  });
});
