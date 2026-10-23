// Saved-views API — RBAC gate (owner/admin via canSeeFinancials) + the happy-path CRUD contract. Uses the
// real in-memory DB; only the session accessor is stubbed so we can flip the viewer's role.
import { describe, it, expect, beforeEach, vi } from "vitest";

const mockRole = { value: "owner" as "owner" | "admin" | "member" };
vi.mock("@/lib/auth/getSession", () => ({
  viewerRole: async () => mockRole.value,
  currentActor: async () => ({ id: "u1", label: "Tester" }),
}));

import { GET, POST, DELETE } from "./route";
import { listFinanceSavedViews } from "@/lib/finance/savedViews";

const postReq = (body: unknown): Request =>
  new Request("http://localhost/api/finance/saved-views", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  mockRole.value = "owner";
});

describe("/api/finance/saved-views — RBAC", () => {
  it("blocks a Member on every verb (403)", async () => {
    mockRole.value = "member";
    expect((await GET()).status).toBe(403);
    expect((await POST(postReq({ name: "x", state: {} }))).status).toBe(403);
    expect((await DELETE(new Request("http://localhost/api/finance/saved-views?id=1", { method: "DELETE" }))).status).toBe(403);
    expect(listFinanceSavedViews()).toHaveLength(0); // nothing was written
  });

  it("admins can save, list, and delete", async () => {
    mockRole.value = "admin";
    const saveRes = await POST(postReq({ name: "Admin View", state: { view: "routes", period: "thisCycle" } }));
    expect(saveRes.status).toBe(200);
    const saved = (await saveRes.json()) as { ok: boolean; view: { id: string } };
    expect(saved.ok).toBe(true);

    const listRes = await GET();
    const listed = (await listRes.json()) as { views: { name: string }[] };
    expect(listed.views.map((v) => v.name)).toContain("Admin View");

    const delRes = await DELETE(new Request(`http://localhost/api/finance/saved-views?id=${saved.view.id}`, { method: "DELETE" }));
    expect(((await delRes.json()) as { removed: boolean }).removed).toBe(true);
  });

  it("rejects an invalid name with 400", async () => {
    const res = await POST(postReq({ name: "   ", state: {} }));
    expect(res.status).toBe(400);
  });

  it("requires a selector on delete (400)", async () => {
    const res = await DELETE(new Request("http://localhost/api/finance/saved-views", { method: "DELETE" }));
    expect(res.status).toBe(400);
  });
});
