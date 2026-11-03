import { describe, it, expect } from "vitest";
import { buildBladeSignals, mergeAttention, type HubItem } from "./bladeSignals";

const today = "2026-11-03"; // Tue
const now = Date.parse("2026-11-03T15:00:00Z");

describe("command center: blade signals", () => {
  it("emits nothing when every blade is quiet or unread", () => {
    expect(buildBladeSignals({ today, now })).toEqual([]);
    expect(buildBladeSignals({
      today, now,
      outbox: { down: false, reasons: [] }, payrollOpenExceptions: 0, wiresPending: [], shiftExceptions: [],
      needsReviewDates: [], instawork: { ok: true }, postEventOpenIssues: 0, radarOutreach: [],
    })).toEqual([]);
  });

  it("raises each blade's stored problem with its owner, link and money flag", () => {
    const items = buildBladeSignals({
      today, now,
      outbox: { down: true, reasons: ["2 ops dead-lettered"] },
      wiresPending: [{ label: "Oct 26 to Nov 1", submittedAt: "2026-11-03T12:00:00Z" }],
      payrollOpenExceptions: 3,
      instawork: { ok: false, failingSince: "2026-11-03T09:00:00Z" },
      postEventOpenIssues: 1,
      radarOutreach: [{ name: "Fall Gala", date: "2026-12-05" }, { name: "Expo", date: null }],
    });
    const by = Object.fromEntries(items.map((i) => [i.key, i]));
    expect(by["blade:outbox"]).toMatchObject({ priority: "high", source: "Goodshuffle", href: "/admin/pull", financial: false });
    expect(by["blade:outbox"].detail).toBe("2 ops dead-lettered → Open the office Goodshuffle tab");
    expect(by["blade:wire:Oct 26 to Nov 1"]).toMatchObject({ priority: "high", source: "Payroll", financial: true });
    expect(by["blade:wire:Oct 26 to Nov 1"].detail).toContain("Submitted in Gusto 3h ago");
    expect(by["blade:payroll-exceptions"]).toMatchObject({ priority: "medium", title: "3 payroll exceptions open", financial: true, href: "/payroll?tab=exceptions" });
    expect(by["blade:instawork"].detail).toContain("Failing since 6h ago");
    expect(by["blade:postevent-issues"]).toMatchObject({ priority: "high", title: "1 open customer issue", href: "/postevent/issues" });
    expect(by["blade:radar-outreach"]).toMatchObject({ priority: "info", title: "2 high-fit events in the outreach window" });
    expect(by["blade:radar-outreach"].detail).toContain("Fall Gala and 1 more");
  });

  it("counts only this week's shift problems, one row per severity, linked to the soonest day", () => {
    const items = buildBladeSignals({
      today, now,
      shiftExceptions: [
        { date: "2026-11-01", severity: "RED", title: "Past problem" }, // before today: ignored
        { date: "2026-11-06", severity: "RED", title: "Truck 2 understaffed" },
        { date: "2026-11-04", severity: "RED", title: "No truck assigned" },
        { date: "2026-11-20", severity: "RED", title: "Far future" }, // after the 7-day window: ignored
        { date: "2026-11-05", severity: "YELLOW", title: "Packet not delivered" },
      ],
      needsReviewDates: ["2026-11-07", "2026-11-05", "2026-10-30"],
    });
    const red = items.find((i) => i.key === "blade:shift-red")!;
    expect(red).toMatchObject({ priority: "high", title: "2 shift problems this week", href: "/scheduling?date=2026-11-04" });
    expect(red.detail).toBe("No truck assigned (Wed, Nov 4) and 1 more → Fix in Scheduling");
    expect(items.find((i) => i.key === "blade:shift-yellow")).toMatchObject({ priority: "medium", title: "1 shift warning this week" });
    expect(items.find((i) => i.key === "blade:needs-review")).toMatchObject({ title: "2 shifts need review", href: "/scheduling?date=2026-11-05" });
  });

  it("does not raise Instawork before its first probe", () => {
    expect(buildBladeSignals({ today, now, instawork: { ok: undefined } })).toEqual([]);
  });

  it("merges by priority, keeping ops rows ahead of blade rows inside a band", () => {
    const ops = (key: string, priority: HubItem["priority"], score: number): HubItem => ({ key, priority, score, title: key, detail: "", href: "/", source: "Event Risk", financial: false });
    const blades = buildBladeSignals({ today, now, payrollOpenExceptions: 1, postEventOpenIssues: 2 });
    const merged = mergeAttention([ops("ops-med", "medium", 40), ops("ops-high", "high", 70), ops("ops-info", "info", 15)], blades);
    expect(merged.map((i) => i.key)).toEqual(["ops-high", "blade:postevent-issues", "ops-med", "blade:payroll-exceptions", "ops-info"]);
  });
});
