import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Keep side effects inert: the audit log and Slack.
vi.mock("@/lib/intake/audit", () => ({ logIntakeEvent: vi.fn(async () => {}) }));
vi.mock("@/lib/notify/channels", () => ({ notify: vi.fn(async () => ({ ok: true })) }));

import { getDb } from "@/lib/db";
import {
  enqueueGsOp,
  claimGsOp,
  listPendingGsOps,
  ackGsOp,
  getGsOpStatus,
  GS_CLAIM_LEASE_MS,
  nextCreateGsOp,
  gatedCreateDrainerAlive,
  drainerRecentlySignedOut,
  isSignedOutCreateError,
  SIGNED_OUT_DRAINER_MS,
} from "@/lib/db/repo";
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

describe("finished is final", () => {
  it("a late failure report never puts a done op back in the queue", () => {
    const id = queueCreate(createIntake().id);
    ackGsOp(id, true); // browser A created it
    ackGsOp(id, false, "create_tab_never_claimed"); // browser B reports late
    expect(getGsOpStatus(id)?.status).toBe("done");
    expect(listPendingGsOps().map((o) => o.id)).not.toContain(id);
  });

  it("a create whose intake already has its project is never listed or handed out", () => {
    const intake = createIntake();
    const id = queueCreate(intake.id);
    updateIntake(intake.id, { gsProjectId: "231976222" });
    expect(listPendingGsOps().map((o) => o.id)).not.toContain(id);
    expect(nextCreateGsOp("ext-1")).toBeNull();
  });
});

describe("the create gate (nextCreate)", () => {
  beforeEach(() => {
    getDb().prepare("DELETE FROM settings WHERE key = 'gs_gated_create_drainer_seen_at'").run();
  });

  it("hands each create to exactly one caller, oldest first", () => {
    const a = queueCreate(createIntake().id);
    const b = queueCreate(createIntake().id);
    expect(nextCreateGsOp("browser-1")?.id).toBe(a);
    expect(nextCreateGsOp("browser-2")?.id).toBe(b);
    expect(nextCreateGsOp("browser-3")).toBeNull();
  });

  it("once a gated drainer is alive, the plain list stops showing creates (old copies can't act)", async () => {
    const createId = queueCreate(createIntake().id);
    const noteId = enqueueGsOp({ op: "note_append", transactionId: "1", payload: { line: "x" } }).id;
    const mod = await import("./route");
    const list = async () =>
      ((await (await mod.GET(new Request("http://localhost/api/gs/outbox"))).json()) as { ops: { id: string }[] }).ops.map((o) => o.id);
    expect(await list()).toContain(createId); // no gated drainer yet: legacy behaviour
    expect(gatedCreateDrainerAlive()).toBe(false);
    await post("outbox", { nextCreate: true, holder: "ext-new" }); // a 1.18.4 install asks (and gets it)
    expect(gatedCreateDrainerAlive()).toBe(true);
    const after = await list();
    expect(after).not.toContain(createId);
    expect(after).toContain(noteId); // other ops are unaffected
  });

  it("the route returns the claimed op, then null for the next caller", async () => {
    const id = queueCreate(createIntake().id);
    const first = await post("outbox", { nextCreate: true, holder: "ext-1" });
    expect((first.op as { id: string }).id).toBe(id);
    const second = await post("outbox", { nextCreate: true, holder: "ext-2" });
    expect(second.op).toBeNull();
  });
});

describe("a signed-out browser never holds a create", () => {
  beforeEach(() => {
    getDb().prepare("DELETE FROM settings WHERE key LIKE 'gs_create_drainer_signed_out:%'").run();
  });

  it("a sign-in page failure hands the lead straight to a signed-in browser, no retry wait, no attempt used", () => {
    const id = queueCreate(createIntake().id);
    expect(nextCreateGsOp("ext-signed-out")?.id).toBe(id);
    expect(ackGsOp(id, false, "create_no_project_id at /ui/auth (complete)").status).toBe("pending");
    const row = getDb().prepare("SELECT attempts, next_attempt_at, claimed_at FROM gs_outbox WHERE id = ?").get(id) as {
      attempts: number;
      next_attempt_at: string | null;
      claimed_at: string | null;
    };
    expect(row).toEqual({ attempts: 0, next_attempt_at: null, claimed_at: null });
    expect(drainerRecentlySignedOut("ext-signed-out")).toBe(true);
    expect(nextCreateGsOp("ext-signed-out")).toBeNull(); // passed over while signed out
    expect(nextCreateGsOp("ext-signed-in")?.id).toBe(id);
  });

  it("the signed-out browser is eligible again after 15 minutes", () => {
    const id = queueCreate(createIntake().id);
    nextCreateGsOp("ext-a");
    ackGsOp(id, false, "create_no_project_id at /login (complete)");
    expect(drainerRecentlySignedOut("ext-a", Date.now() + SIGNED_OUT_DRAINER_MS + 1000)).toBe(false);
  });

  it("any other failure still counts and waits (normal retry policy)", () => {
    const id = queueCreate(createIntake().id);
    nextCreateGsOp("ext-a");
    ackGsOp(id, false, "create_no_project_id at /app/project/createNewProject (loading)");
    const row = getDb().prepare("SELECT attempts, next_attempt_at FROM gs_outbox WHERE id = ?").get(id) as { attempts: number; next_attempt_at: string | null };
    expect(row.attempts).toBe(1);
    expect(row.next_attempt_at).not.toBeNull();
    expect(drainerRecentlySignedOut("ext-a")).toBe(false);
  });

  it("recognizes only Goodshuffle sign-in pages, only for creates", () => {
    expect(isSignedOutCreateError("create_project", "create_no_project_id at /ui/auth (complete)")).toBe(true);
    expect(isSignedOutCreateError("create_project", "create_no_project_id at /login (loading)")).toBe(true);
    expect(isSignedOutCreateError("create_project", "create_no_project_id at /app/project/detail (complete)")).toBe(false);
    expect(isSignedOutCreateError("note_append", "create_no_project_id at /ui/auth (complete)")).toBe(false);
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
