import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Geocoding reaches the network; stub it so the create route is hermetic and the test exercises only the
// enqueue + idempotency behaviour. Returning null is the route's documented "no location" fallback.
vi.mock("@/lib/intake/geocode", () => ({ geocodeAddress: vi.fn(async () => null) }));
// Keep the audit side effect inert (it would otherwise try to resolve a session).
vi.mock("@/lib/intake/audit", () => ({ logIntakeEvent: vi.fn(async () => {}) }));

import { createIntake, updateIntake, getIntake } from "@/lib/intake/store";
import { listGsOps, pendingCreateOpExists, ackGsOp, listPendingGsOps } from "@/lib/db/repo";

// A minimally-valid intake (passes missingRequired): name, phone, email, event type + date.
function seedReadyIntake() {
  const i = createIntake();
  updateIntake(i.id, {
    firstName: "Pat",
    lastName: "Smith",
    phone: "5555550111",
    email: "pat@example.com",
    eventType: "wedding",
    eventDate: "2027-06-20",
  });
  return i.id;
}

async function callCreate(id: string) {
  const { POST } = await import("./route");
  return POST(new Request(`http://localhost/api/intake/${id}/create`, { method: "POST" }), {
    params: Promise.resolve({ id }),
  });
}

describe("POST /api/intake/[id]/create", () => {
  afterEach(() => vi.clearAllMocks());

  it("queues exactly one create_project op for a ready intake", async () => {
    const id = seedReadyIntake();
    const r = await callCreate(id);
    const j = (await r.json()) as { ok?: boolean; status?: string };
    expect(j.ok).toBe(true);
    expect(j.status).toBe("queued");

    const ops = listGsOps(100).filter((o) => o.op === "create_project" && (o.payload as { intakeId?: string }).intakeId === id);
    expect(ops).toHaveLength(1);
    // The op carries the client contact so the drainer creates + attaches the customer (saveNewContact).
    const payload = ops[0].payload as { client?: { firstName?: string; lastName?: string; email?: string; mobilePhone?: string } };
    expect(payload.client).toMatchObject({ firstName: "Pat", lastName: "Smith", email: "pat@example.com", mobilePhone: "5555550111" });
    // The intake is moved into the honest "creating/queued" state, NOT "created" (that only lands via the
    // Goodshuffle result callback).
    const after = getIntake(id)!;
    expect(after.status).toBe("creating");
    expect(after.gsStatus).toBe("queued");
  });

  it("is idempotent — a repeat submit does not enqueue a second create op", async () => {
    const id = seedReadyIntake();
    await callCreate(id);
    const r2 = await callCreate(id); // double click / retry while still pending
    const j2 = (await r2.json()) as { ok?: boolean; status?: string };
    expect(j2.ok).toBe(true);
    expect(j2.status).toBe("queued");

    const ops = listGsOps(100).filter((o) => o.op === "create_project" && (o.payload as { intakeId?: string }).intakeId === id);
    expect(ops).toHaveLength(1);
  });

  it("short-circuits once the project exists (never a duplicate project)", async () => {
    const id = seedReadyIntake();
    updateIntake(id, { gsProjectId: "4242", gsProjectUrl: "https://pro.goodshuffle.com/app/project/detail?id=4242" });
    const r = await callCreate(id);
    const j = (await r.json()) as { ok?: boolean; status?: string; gsProjectId?: string };
    expect(j.status).toBe("created");
    expect(j.gsProjectId).toBe("4242");

    const ops = listGsOps(100).filter((o) => o.op === "create_project" && (o.payload as { intakeId?: string }).intakeId === id);
    expect(ops).toHaveLength(0); // nothing queued
  });

  it("rejects an intake that is still missing required fields", async () => {
    const i = createIntake(); // blank — missing everything
    const r = await callCreate(i.id);
    expect(r.status).toBe(400);
    const j = (await r.json()) as { error?: string; missing?: string[] };
    expect(j.error).toBe("missing_required");
    expect((j.missing ?? []).length).toBeGreaterThan(0);
  });
});

describe("pendingCreateOpExists (idempotency helper)", () => {
  it("is true only while a matching create op is pending", async () => {
    const id = seedReadyIntake();
    expect(pendingCreateOpExists(id)).toBe(false);
    await callCreate(id);
    expect(pendingCreateOpExists(id)).toBe(true);
    expect(pendingCreateOpExists("INTK-unrelated")).toBe(false);
    expect(pendingCreateOpExists("")).toBe(false);

    // Once the op is acked (office browser finished), a genuine future retry is allowed again.
    const op = listPendingGsOps(100).find((o) => o.op === "create_project" && (o.payload as { intakeId?: string }).intakeId === id)!;
    ackGsOp(op.id, true);
    expect(pendingCreateOpExists(id)).toBe(false);
  });
});
