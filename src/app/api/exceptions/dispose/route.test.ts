import { beforeEach, describe, expect, it, vi } from "vitest";

let role: "owner" | "admin" | "member" = "owner";
vi.mock("@/lib/auth/getSession", () => ({
  viewerRole: vi.fn(async () => role),
  currentActor: vi.fn(async () => ({ id: "u1", label: "Pat (Owner)" })),
}));

import { getDb } from "@/lib/db";
import { upsertException, setFields, getException } from "@/lib/exceptions/store";
import { enqueueGsOp, getGsOpById } from "@/lib/db/repo";
import { liveOutboxSummary } from "@/lib/aiorg/outboxHealth";
import { POST } from "./route";

const KEY = "risk:sig-x";

function seed(status: "unverifiable" | "awaiting_approval" = "unverifiable"): void {
  upsertException({ source: "risk", sourceId: "sig-x", type: "route_no_driver", severity: "high", title: "Route has no driver", detail: "Assign one" });
  setFields(KEY, { status });
}

async function post(body: Record<string, unknown>) {
  return POST(new Request("http://localhost/api/exceptions/dispose", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
}

describe("POST /api/exceptions/dispose", () => {
  beforeEach(() => {
    role = "owner";
    getDb().prepare("DELETE FROM exception_resolutions").run();
  });

  it("forbids a member", async () => {
    role = "member";
    seed();
    expect((await post({ key: KEY, as: "resolved", reason: "Driver assigned" })).status).toBe(403);
    expect(getException(KEY)!.status).toBe("unverifiable");
  });

  it("requires a reason", async () => {
    seed();
    expect((await post({ key: KEY, as: "resolved", reason: " " })).status).toBe(400);
  });

  it("closes with the reason and the signed-in person on record", async () => {
    seed();
    const res = await post({ key: KEY, as: "disposed", reason: "Event was cancelled" });
    expect(res.status).toBe(200);
    const r = getException(KEY)!;
    expect(r.status).toBe("disposed");
    expect(r.disposition).toBe("Event was cancelled");
    expect(r.disposedBy).toBe("Pat (Owner)");
  });

  it("404s an unknown key", async () => {
    expect((await post({ key: "risk:nope", as: "resolved", reason: "x y z" })).status).toBe(404);
  });

  it("closing a failed write-back also dismisses the outbox op, so the alarm clears", async () => {
    getDb().prepare("DELETE FROM gs_outbox").run();
    const op = enqueueGsOp({ op: "set_delivery_fee", transactionId: "77", label: "delivery fee $50", payload: { amount: 50 } });
    getDb().prepare("UPDATE gs_outbox SET status = 'dead' WHERE id = ?").run(op.id);
    upsertException({ source: "dead_letter", sourceId: op.id, type: "dead_letter:set_delivery_fee", severity: "medium", title: "Write-back failed", detail: "x" });
    setFields(`dead_letter:${op.id}`, { status: "escalated" });

    const res = await post({ key: `dead_letter:${op.id}`, as: "disposed", reason: "Fee set by hand in Goodshuffle" });
    expect(res.status).toBe(200);
    const row = getGsOpById(op.id)!;
    expect(row.status).toBe("dismissed");
    expect(row.lastError).toBe("Dismissed by Pat (Owner): Fee set by hand in Goodshuffle");
    expect(liveOutboxSummary().deadLetter).toBe(0);
  });
});
