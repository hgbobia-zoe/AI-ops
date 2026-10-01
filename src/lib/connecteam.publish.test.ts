import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPublishedShift, updatePublishedShift } from "./connecteam";

const BASE_INPUT = {
  schedulerId: 42,
  title: "Driver — Yim",
  startUnix: 1_800_000_000,
  endUnix: 1_800_010_000,
  timezone: "America/New_York",
  assignedUserIds: [111, 222],
};

beforeEach(() => {
  process.env.CONNECTEAM_API_KEY = "test-key";
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.CONNECTEAM_API_KEY;
});

function mockFetch(status: number, body: unknown): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as ReturnType<typeof vi.fn>;
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("createPublishedShift", () => {
  it("posts a published shift and returns the created id", async () => {
    const fn = mockFetch(200, { data: { shifts: [{ id: 987 }] } });
    const r = await createPublishedShift(BASE_INPUT);
    expect(r.ok).toBe(true);
    expect(r.shiftId).toBe("987");
    // Verify the request: published, notifyUsers, epoch seconds, assignees.
    const [url, init] = fn.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/scheduler/v1/schedulers/42/shifts");
    expect(url).toContain("notifyUsers=true");
    const sent = JSON.parse(String(init.body))[0];
    expect(sent.isPublished).toBe(true);
    expect(sent.isOpenShift).toBe(false);
    expect(sent.startTime).toBe(BASE_INPUT.startUnix);
    expect(sent.assignedUserIds).toEqual([111, 222]);
  });

  it("marks an unassigned shift as an open shift", async () => {
    const fn = mockFetch(200, { data: { shifts: [{ id: 1 }] } });
    await createPublishedShift({ ...BASE_INPUT, assignedUserIds: [] });
    const sent = JSON.parse(String((fn.mock.calls[0] as [string, RequestInit])[1].body))[0];
    expect(sent.isOpenShift).toBe(true);
  });

  it("surfaces a Connecteam error (never fakes success)", async () => {
    mockFetch(400, { message: "overlapping shift" });
    const r = await createPublishedShift(BASE_INPUT);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("overlapping shift");
  });

  it("rejects an invalid window WITHOUT calling Connecteam", async () => {
    const fn = mockFetch(200, {});
    const r = await createPublishedShift({ ...BASE_INPUT, endUnix: BASE_INPUT.startUnix });
    expect(r.ok).toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });

  it("fails safe when Connecteam is not configured", async () => {
    delete process.env.CONNECTEAM_API_KEY;
    const fn = mockFetch(200, {});
    const r = await createPublishedShift(BASE_INPUT);
    expect(r.ok).toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("updatePublishedShift", () => {
  it("PUTs the shift with its id and keeps that id", async () => {
    const fn = mockFetch(200, { data: { shifts: [{ id: 555 }] } });
    const r = await updatePublishedShift({ ...BASE_INPUT, shiftId: "555" });
    expect(r.ok).toBe(true);
    expect(r.shiftId).toBe("555");
    const [, init] = fn.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("PUT");
    const sent = JSON.parse(String(init.body))[0];
    expect(sent.id).toBe(555); // numeric id threaded into the body
    expect(sent.isPublished).toBe(true);
  });

  it("surfaces an update error (never fakes success)", async () => {
    mockFetch(400, { message: "shift not found" });
    const r = await updatePublishedShift({ ...BASE_INPUT, shiftId: "999" });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("shift not found");
  });
});
