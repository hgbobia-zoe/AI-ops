import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Keep side effects inert: the audit log and Slack.
vi.mock("@/lib/intake/audit", () => ({ logIntakeEvent: vi.fn(async () => {}) }));
vi.mock("@/lib/notify/channels", () => ({ notify: vi.fn(async () => ({ ok: true })) }));

import { getDb } from "@/lib/db";
import { enqueueGsOp, claimGsOp, listPendingGsOps, ackGsOp, getGsOpStatus, GS_CLAIM_LEASE_MS } from "@/lib/db/repo";
import { createIntake, getIntake, updateIntake } from "@/lib/intake/store";
import { notify } from "@/lib/notify/channels";

beforeEach(() => {
  getDb().prepare("DELETE FROM gs_outbox").run();
});
afterEach(() => vi.clearAllMocks());

function queueCreate(intakeId: string): string {
  return enqueueGsOp({ op: "create_project", label: "test", payload: { intakeId, eventName: "Test - Wedding" } }).id;
}

async function post(path: "outbox" | "intake-result", body: unknown) {
  const mod = path === "outbox" ? await import("./route") : await import("../intake-result/route");
  const r = await mod.POST(new Request(`http://localhost/api/gs/${path}`, { method: "POST", body: JSON.stringify(body) }));
  return (await r.json()) as Record<string, unknown>;
}

describe("claimGsOp (single runner per op)", () => {
  it("grants exactly one claim when several drainers race", () => {
    const id = queueCreate(createIntake().id);
    expect(claimGsOp(id, "browser-a")).toBe(true);
    expect(claimGsOp(id, "browser-b")).toBe(false);
    expect(claimGsOp(id, "bookmarklet")).toBe(false);
  });

  it("hides a claimed op from the pending list until it is acked", () => {
    const id = queueCreate(createIntake().id);
    claimGsOp(id, "browser-a");
    expect(listPendingGsOps().map((o) => o.id)).not.toContain(id);
    ackGsOp(id, true);
    expect(getGsOpStatus(id)?.status).toBe("done");
    expect(claimGsOp(id, "browser-b")).toBe(false); // done ops are never claimable
  });

  it("a failed attempt releases the claim so the retry (after backoff) can be claimed again", () => {
    const id = queueCreate(createIntake().id);
    claimGsOp(id, "browser-a");
    ackGsOp(id, false, "create_no_project_id at /login (complete)");
    const row = getDb().prepare("SELECT claimed_at FROM gs_outbox WHERE id = ?").get(id) as { claimed_at: string | null };
    expect(row.claimed_at).toBeNull();
    expect(claimGsOp(id, "browser-b")).toBe(true);
  });

  it("an abandoned claim (browser closed mid-create) can be taken over once the lease runs out", () => {
    const id = queueCreate(createIntake().id);
    claimGsOp(id, "browser-a");
    const old = new Date(Date.now() - GS_CLAIM_LEASE_MS - 1000).toISOString();
    getDb().prepare("UPDATE gs_outbox SET claimed_at = ? WHERE id = ?").run(old, id);
    expect(listPendingGsOps().map((o) => o.id)).toContain(id);
    expect(claimGsOp(id, "browser-b")).toBe(true);
  });
});

describe("POST /api/gs/outbox claim", () => {
  it("answers claimed true once, then claimed false", async () => {
    const id = queueCreate(createIntake().id);
    expect((await post("outbox", { id, claim: true, holder: "ext-1" })).claimed).toBe(true);
    const second = await post("outbox", { id, claim: true, holder: "ext-2" });
    expect(second.claimed).toBe(false);
    expect(second.reason).toBe("claimed_elsewhere");
  });

  it("refuses and closes a create whose intake already has its Goodshuffle project", async () => {
    const intake = createIntake();
    updateIntake(intake.id, { gsProjectId: "231976248" });
    const id = queueCreate(intake.id);
    const res = await post("outbox", { id, claim: true, holder: "ext-1" });
    expect(res.claimed).toBe(false);
    expect(res.reason).toBe("already_created");
    expect(getGsOpStatus(id)?.status).toBe("done");
  });

  it("an ack without claim still requires an explicit ok", async () => {
    const id = queueCreate(createIntake().id);
    const mod = await import("./route");
    const r = await mod.POST(new Request("http://localhost/api/gs/outbox", { method: "POST", body: JSON.stringify({ id }) }));
    expect(r.status).toBe(400);
  });
});

describe("POST /api/gs/intake-result duplicate guard", () => {
  it("keeps the first project and alerts ops when a second one is reported", async () => {
    const intake = createIntake();
    await post("intake-result", { intakeId: intake.id, projectId: "231976248", ok: true });
    const res = await post("intake-result", { intakeId: intake.id, projectId: "231976249", ok: true });
    expect(res.duplicate).toBe(true);
    expect(getIntake(intake.id)?.gsProjectId).toBe("231976248");
    expect(notify).toHaveBeenCalledWith("ops", expect.stringContaining("delete 231976249"));
  });

  it("a repeat report of the SAME project is not a duplicate", async () => {
    const intake = createIntake();
    await post("intake-result", { intakeId: intake.id, projectId: "231976248", ok: true });
    const res = await post("intake-result", { intakeId: intake.id, projectId: "231976248", ok: true });
    expect(res.duplicate).toBeUndefined();
    expect(notify).not.toHaveBeenCalled();
  });
});
