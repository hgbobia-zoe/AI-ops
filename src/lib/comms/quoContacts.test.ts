import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QuoContact } from "./quoContactsDedupe";

// Ordered log of everything that touches Quo or the audit table, so tests can assert sequence.
const log: string[] = [];

vi.mock("@/lib/db/repo", () => ({
  insertAudit: vi.fn((a: { action: string; entityId: string }) => log.push(`AUDIT ${a.action} ${a.entityId}`)),
}));
vi.mock("@/lib/comms/openphone", () => ({ openphoneApiKey: () => "test-key" }));

import { insertAudit } from "@/lib/db/repo";
import { invalidateQuoDedupeReport, listAllQuoContacts, mergeQuoContacts } from "./quoContacts";

// ── Fake Quo API ─────────────────────────────────────────────────────────────────────────────────────
let store: Map<string, QuoContact>;
let patchBehavior: "apply" | "drop-phones" | "fail";

function contact(id: string, first: string | null, phones: string[], emails: string[] = [], createdAt = "2025-01-01T00:00:00Z"): QuoContact {
  return {
    id,
    createdAt,
    defaultFields: {
      firstName: first,
      lastName: null,
      phoneNumbers: phones.map((value, i) => ({ name: "mobile", value, id: `${id}-p${i}` })),
      emails: emails.map((value, i) => ({ name: "primary", value, id: `${id}-e${i}` })),
    },
    customFields: [],
  };
}

function json(status: number, body: unknown): Response {
  return new Response(body === null ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function fakeFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const path = url.pathname.replace(/^\/v1/, "");
  log.push(`${method} ${path}`);
  if (method === "GET" && path === "/contacts") {
    const all = [...store.values()];
    const start = Number(url.searchParams.get("pageToken") ?? 0);
    const size = Number(url.searchParams.get("maxResults"));
    const page = all.slice(start, start + size);
    return json(200, { data: page, nextPageToken: start + size < all.length ? String(start + size) : null });
  }
  const id = decodeURIComponent(path.split("/")[2] ?? "");
  const c = store.get(id);
  if (method === "GET") return c ? json(200, { data: c }) : json(404, { message: "not found" });
  if (method === "PATCH") {
    if (!c) return json(404, {});
    if (patchBehavior === "fail") return json(400, { message: "bad" });
    const body = JSON.parse(String(init?.body));
    const next: QuoContact = { ...c, defaultFields: { ...body.defaultFields }, customFields: body.customFields };
    if (patchBehavior === "drop-phones") next.defaultFields = { ...next.defaultFields, phoneNumbers: [] };
    store.set(id, next);
    return json(200, { data: next });
  }
  if (method === "DELETE") {
    store.delete(id);
    return new Response(null, { status: 204 });
  }
  return json(405, {});
}

beforeEach(() => {
  log.length = 0;
  vi.mocked(insertAudit).mockClear();
  patchBehavior = "apply";
  invalidateQuoDedupeReport();
  store = new Map();
  vi.stubGlobal("fetch", vi.fn(fakeFetch));
});

describe("listAllQuoContacts", () => {
  it("pages through the whole address book", async () => {
    for (let i = 0; i < 120; i++) store.set(`c${i}`, contact(`c${i}`, `N${i}`, [`30155501${String(i).padStart(2, "0")}`]));
    const all = await listAllQuoContacts();
    expect(all).toHaveLength(120);
    expect(log.filter((l) => l === "GET /contacts")).toHaveLength(3);
  }, 10_000);
});

describe("mergeQuoContacts", () => {
  it("updates the survivor, verifies, backs up, then deletes the copies in that order", async () => {
    store.set("keep", contact("keep", "Pat", ["+13015550101"], ["pat@example.com"], "2021-01-01T00:00:00Z"));
    store.set("copy", contact("copy", null, ["(301) 555-0101", "202-555-0199"]));
    const res = await mergeQuoContacts(["keep", "copy"], { actor: "Owner" });
    expect(res).toEqual({ ok: true, survivorId: "keep", deletedIds: ["copy"], skippedIds: [] });
    const writes = log.filter((l) => !l.startsWith("GET"));
    expect(writes).toEqual(["PATCH /contacts/keep", "AUDIT QUO_CONTACT_MERGE keep", "DELETE /contacts/copy"]);
    const kept = store.get("keep")!;
    expect(kept.defaultFields?.phoneNumbers?.map((p) => p.value)).toEqual(["+13015550101", "202-555-0199"]);
    expect(store.has("copy")).toBe(false);
    // The audit backup holds the full original JSON of every member.
    const backup = vi.mocked(insertAudit).mock.calls[0][0].before as { contacts: QuoContact[] };
    expect(backup.contacts.map((c) => c.id).sort()).toEqual(["copy", "keep"]);
  }, 10_000);

  it("deletes nothing when the survivor comes back missing a phone", async () => {
    patchBehavior = "drop-phones";
    store.set("keep", contact("keep", "Pat", ["3015550101"], ["pat@example.com"]));
    store.set("copy", contact("copy", "Pat", ["3015550101"]));
    const res = await mergeQuoContacts(["keep", "copy"], { actor: "Owner" });
    expect(res.ok).toBe(false);
    expect(log.some((l) => l.startsWith("DELETE"))).toBe(false);
    expect(insertAudit).not.toHaveBeenCalled();
    expect(store.has("copy")).toBe(true);
  }, 10_000);

  it("deletes nothing when Quo rejects the update", async () => {
    patchBehavior = "fail";
    store.set("keep", contact("keep", "Pat", ["3015550101"]));
    store.set("copy", contact("copy", "Pat", ["3015550101"]));
    const res = await mergeQuoContacts(["keep", "copy"], { actor: "Owner" });
    expect(res.ok).toBe(false);
    expect(log.some((l) => l.startsWith("DELETE"))).toBe(false);
  }, 10_000);

  it("refuses contacts that do not share a phone or email", async () => {
    store.set("a", contact("a", "Pat", ["3015550101"]));
    store.set("b", contact("b", "Lee", ["2025550199"]));
    const res = await mergeQuoContacts(["a", "b"], { actor: "Owner" });
    expect(res.ok).toBe(false);
    expect(log.some((l) => l.startsWith("PATCH") || l.startsWith("DELETE"))).toBe(false);
  }, 10_000);

  it("needs an explicit confirm when names differ", async () => {
    store.set("a", contact("a", "Pat", ["3015550101"]));
    store.set("b", contact("b", "Sam", ["3015550101"]));
    const blocked = await mergeQuoContacts(["a", "b"], { actor: "Owner" });
    expect(blocked.ok).toBe(false);
    expect(log.some((l) => l.startsWith("PATCH"))).toBe(false);
    const allowed = await mergeQuoContacts(["a", "b"], { actor: "Owner", confirmReview: true });
    expect(allowed.ok).toBe(true);
  }, 10_000);

  it("skips a member that was already deleted and still merges the rest", async () => {
    store.set("keep", contact("keep", "Pat", ["3015550101"], ["pat@example.com"]));
    store.set("copy", contact("copy", "Pat", ["3015550101"]));
    const res = await mergeQuoContacts(["keep", "copy", "gone"], { actor: "Owner" });
    expect(res).toEqual({ ok: true, survivorId: "keep", deletedIds: ["copy"], skippedIds: ["gone"] });
  }, 10_000);

  it("reports nothing to merge when only one contact is left", async () => {
    store.set("keep", contact("keep", "Pat", ["3015550101"]));
    const res = await mergeQuoContacts(["keep", "gone"], { actor: "Owner" });
    expect(res.ok).toBe(false);
    expect(log.some((l) => l.startsWith("PATCH"))).toBe(false);
  }, 10_000);
});
