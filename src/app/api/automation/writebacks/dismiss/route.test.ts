import { beforeEach, describe, expect, it, vi } from "vitest";

let role: "owner" | "admin" | "member" = "owner";
vi.mock("@/lib/auth/getSession", () => ({
  viewerRole: vi.fn(async () => role),
  currentActor: vi.fn(async () => ({ id: "u1", label: "Pat (Owner)" })),
}));

import { getDb } from "@/lib/db";
import { enqueueGsOp, getGsOpById } from "@/lib/db/repo";
import { POST } from "./route";

async function post(body: Record<string, unknown>) {
  return POST(new Request("http://localhost/api/automation/writebacks/dismiss", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
}

describe("POST /api/automation/writebacks/dismiss", () => {
  beforeEach(() => {
    role = "owner";
    getDb().prepare("DELETE FROM gs_outbox").run();
  });

  it("forbids a member", async () => {
    role = "member";
    const op = enqueueGsOp({ op: "provision_user", label: "invite", payload: { system: "quo" } });
    expect((await post({ id: op.id, reason: "Done by hand" })).status).toBe(403);
    expect(getGsOpById(op.id)!.status).toBe("pending");
  });

  it("requires a reason", async () => {
    const op = enqueueGsOp({ op: "provision_user", label: "invite", payload: { system: "quo" } });
    expect((await post({ id: op.id, reason: "" })).status).toBe(400);
  });

  it("dismisses with the signed-in person and reason on record", async () => {
    const op = enqueueGsOp({ op: "provision_user", label: "invite", payload: { system: "quo" } });
    const res = await post({ id: op.id, reason: "Invited by hand" });
    expect(res.status).toBe(200);
    const row = getGsOpById(op.id)!;
    expect(row.status).toBe("dismissed");
    expect(row.lastError).toBe("Dismissed by Pat (Owner): Invited by hand");
  });

  it("404s an unknown id", async () => {
    expect((await post({ id: "nope", reason: "x y z" })).status).toBe(404);
  });
});
