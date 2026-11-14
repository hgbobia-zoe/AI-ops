// Owner (2026-11-14): morning texts between 9:12 and 9:17 ET, random to the second, never in the 9:15 minute,
// and spread so they do not bunch.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/comms/openphoneSync", () => ({ ensureLeadThreadSynced: vi.fn() }));
vi.mock("@/lib/comms/openphone", () => ({ getOpenphonePhoneNumbers: vi.fn(), listOpenphoneCalls: vi.fn(), openphoneApiKey: () => null }));
vi.mock("@/lib/notify/aiBots", () => ({ botAnnounce: vi.fn(), appUrl: () => null }));

import { randomSendTime, spreadSendTimes, inAvoidMinute, clockLabel } from "./morningOutreach";
import { rowsFromPlan } from "./morningLive";

const minuteOf = (iso: string): string => clockLabel(iso).replace(/:\d\d (AM|PM)$/, "");
let seed = 7;
const rng = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647);

describe("morning text send times", () => {
  it("never lands in the 9:15 minute, across the whole rng range and DST", () => {
    for (const day of ["2026-11-14", "2026-07-15"]) {
      for (let k = 0; k <= 1000; k++) {
        const iso = randomSendTime(day, () => k / 1000.0001);
        expect(clockLabel(iso)).toMatch(/^9:1[2-7]:\d\d AM$/);
        expect(minuteOf(iso)).not.toBe("9:15");
      }
    }
    expect(clockLabel(randomSendTime("2026-11-14", () => 0))).toBe("9:12:00 AM");
    expect(clockLabel(randomSendTime("2026-11-14", () => 0.999999))).toBe("9:17:59 AM");
  });

  it("spreads several texts: distinct seconds, never 9:15, five or fewer each in its own minute", () => {
    for (const n of [1, 3, 5, 12, 25]) {
      const times = spreadSendTimes("2026-11-14", n, rng);
      expect(times).toHaveLength(n);
      expect(new Set(times).size).toBe(n);
      for (const t of times) {
        expect(clockLabel(t)).toMatch(/^9:1[2-7]:\d\d AM$/);
        expect(inAvoidMinute(new Date(t))).toBe(false);
      }
      const sorted = [...times].sort();
      for (let k = 1; k < sorted.length; k++) expect(Date.parse(sorted[k]) - Date.parse(sorted[k - 1])).toBeGreaterThanOrEqual(2000);
      if (n <= 5) expect(new Set(times.map(minuteOf)).size).toBe(n);
    }
  });

  it("knows the 9:15 minute in Eastern time", () => {
    expect(inAvoidMinute(new Date("2026-11-14T14:15:30Z"))).toBe(true); // 9:15:30 EST
    expect(inAvoidMinute(new Date("2026-11-14T14:16:00Z"))).toBe(false);
    expect(inAvoidMinute(new Date("2026-07-15T13:15:00Z"))).toBe(true); // 9:15 EDT
  });

  it("the live run re-spreads the texts that will go out, never 9:15", () => {
    const row = (id: string, at: string) => ({ leadId: id, send: true, draft: "Hi", sendAt: at, eventName: id, clientName: "C", value: 1, whereWeAre: [], signedAs: "Jessie", reason: null }) as never;
    // A plan that bunched everything into 9:15 (an old plan): the live rows never keep 9:15.
    const rows = rowsFromPlan([row("A", "2026-11-14T14:15:01Z"), row("B", "2026-11-14T14:15:02Z"), row("C", "2026-11-14T14:15:03Z")], 25, rng);
    const minutes = rows.map((r) => minuteOf(r.sendAt!));
    expect(minutes).not.toContain("9:15");
    expect(new Set(minutes).size).toBe(3);
  });
});
