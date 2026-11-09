// The bookings ingest's runaway-create guard: more than N blank drafts created today/yesterday posts ONE
// status card per day, on either lane, and never repeats on later pulls. Real in-memory DB; status posts mocked.

import { describe, it, expect, beforeEach, vi } from "vitest";

const status = vi.hoisted(() => ({ post: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/notify/status", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/notify/status")>()), postStatus: status.post }));

import { getDb } from "@/lib/db";
import { todayInOpsTz, shiftYmd } from "@/lib/dates";
import { POST } from "./route";
import { statusText, type StatusAlert } from "@/lib/notify/status";

beforeEach(() => {
  const db = getDb();
  db.prepare("DELETE FROM bookings").run();
  db.prepare("DELETE FROM settings WHERE key IN ('pull_state','bookings_force_prune_once')").run();
  status.post.mockClear();
  delete process.env.GS_BLANK_DRAFT_ALERT_THRESHOLD;
});

function blanks(n: number, dateCreated: string, start = 900000000) {
  return Array.from({ length: n }, (_, i) => ({ bookingId: start + i, eventName: "", statusLabel: "New Project", grandTotalCents: 0, dateCreated }));
}

function post(projects: unknown[], scope?: "active" | "full"): Promise<Response> {
  return POST(
    new Request("http://localhost/api/gs/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projects, ...(scope ? { scope } : {}) }),
    }),
  );
}

describe("POST /api/gs/projects blank-draft guard", () => {
  it("alerts once when more than 5 blanks were created today, then stays quiet on the next pulls", async () => {
    const today = todayInOpsTz();
    const real = { bookingId: 1, eventName: "Smith Wedding", clientName: "Smith", statusLabel: "New Project", dateCreated: today };
    const r1 = await post([...blanks(6, today), real], "active");
    expect((await r1.json()).blankDraftAlerts).toBe(1);
    expect(status.post).toHaveBeenCalledTimes(1);
    const text = statusText((status.post.mock.calls[0] as unknown as [StatusAlert])[0]);
    expect(text).toContain("6 blank Unnamed Project drafts");
    expect(text).toContain("ids 900000000 to 900000005");

    // Same burst seen again by the full lane, and grown: deduped per day.
    const r2 = await post([...blanks(9, today), real]);
    expect((await r2.json()).blankDraftAlerts).toBe(0);
    expect(status.post).toHaveBeenCalledTimes(1);
  });

  it("does not alert at the threshold, for real leads, or for old days like the archived 10/31 incident", async () => {
    const today = todayInOpsTz();
    const realLeads = Array.from({ length: 20 }, (_, i) => ({ bookingId: 100 + i, eventName: `Lead ${i}`, clientName: `C${i}`, dateCreated: today }));
    await post([...blanks(5, today), ...realLeads, ...blanks(66, "2026-10-31", 231976120)], "active");
    expect(status.post).not.toHaveBeenCalled();
  });

  it("counts yesterday too and honors the env threshold", async () => {
    process.env.GS_BLANK_DRAFT_ALERT_THRESHOLD = "2";
    await post(blanks(3, shiftYmd(todayInOpsTz(), -1)), "active");
    expect(status.post).toHaveBeenCalledTimes(1);
  });
});
