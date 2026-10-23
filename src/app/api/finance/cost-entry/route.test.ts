import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Control the viewer role + actor per test (auth is otherwise off → owner). currentActor must resolve so
// the audit write has a real actor label.
let role: "owner" | "admin" | "member" = "owner";
vi.mock("@/lib/auth/getSession", () => ({
  viewerRole: vi.fn(async () => role),
  currentActor: vi.fn(async () => ({ id: "u1", label: "Pat (Owner)" })),
}));

import { getDb } from "@/lib/db";
import { listManualCostEntries } from "@/lib/db/repo";

async function post(body: Record<string, unknown>) {
  const { POST } = await import("./route");
  return POST(new Request("http://localhost/api/finance/cost-entry", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
}
async function del(body: Record<string, unknown>) {
  const { DELETE } = await import("./route");
  return DELETE(new Request("http://localhost/api/finance/cost-entry", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
}
async function get(projectId: string) {
  const { GET } = await import("./route");
  return GET(new Request(`http://localhost/api/finance/cost-entry?projectId=${projectId}`));
}

describe("POST/DELETE /api/finance/cost-entry", () => {
  beforeEach(() => {
    role = "owner";
  });
  afterEach(() => vi.clearAllMocks());

  it("forbids a member (RBAC) on write, read, and delete", async () => {
    role = "member";
    expect((await post({ projectId: "RB1", type: "sub_rental", class: "DIRECT", amount: 100 })).status).toBe(403);
    expect((await get("RB1")).status).toBe(403);
    expect((await del({ sourceRef: "manual:RB1:x" })).status).toBe(403);
  });

  it("400s an invalid body (bad type / missing project)", async () => {
    expect((await post({ projectId: "P1", type: "labor", class: "DIRECT", amount: 100 })).status).toBe(400); // labor not allowed
    expect((await post({ projectId: "", type: "other", class: "DIRECT", amount: 100 })).status).toBe(400);
  });

  it("creates, then edits IN PLACE (idempotent on source_ref), then deletes — and audits each write", async () => {
    const pid = "PROJ-IDEMP";
    // create
    const r1 = await post({ projectId: pid, type: "sub_rental", class: "DIRECT", amount: 250, note: "tent" });
    const j1 = (await r1.json()) as { ok: boolean; entry: { sourceRef: string; amount: number } };
    expect(j1.ok).toBe(true);
    const ref = j1.entry.sourceRef;
    expect(ref.startsWith("manual:")).toBe(true);
    expect(listManualCostEntries(pid)).toHaveLength(1);

    // edit in place — same source_ref, updated amount, still ONE row
    const r2 = await post({ projectId: pid, type: "sub_rental", class: "DIRECT", amount: 300, note: "tent (revised)", sourceRef: ref });
    const j2 = (await r2.json()) as { entry: { sourceRef: string; amount: number } };
    expect(j2.entry.sourceRef).toBe(ref);
    expect(j2.entry.amount).toBe(300);
    const rows = listManualCostEntries(pid);
    expect(rows).toHaveLength(1);
    expect(rows[0].amount).toBe(300);

    // the write is audited
    const audits = getDb().prepare(`SELECT COUNT(*) AS n FROM audit_logs WHERE action='finance.cost-entry.upsert' AND entity_id=?`).get(ref) as { n: number };
    expect(audits.n).toBeGreaterThanOrEqual(2);

    // delete
    const r3 = await del({ sourceRef: ref });
    expect((await r3.json()).deleted).toBe(true);
    expect(listManualCostEntries(pid)).toHaveLength(0);
    const delAudit = getDb().prepare(`SELECT COUNT(*) AS n FROM audit_logs WHERE action='finance.cost-entry.delete' AND entity_id=?`).get(ref) as { n: number };
    expect(delAudit.n).toBe(1);
  });

  it("404s a delete of a non-existent entry", async () => {
    expect((await del({ sourceRef: "manual:NOPE:zzz" })).status).toBe(404);
  });
});
