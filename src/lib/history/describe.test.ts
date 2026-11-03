import { describe, it, expect } from "vitest";
import { describeChange, areaOf, AREA_KINDS } from "./describe";
import { opsDayKey, opsDayLabel, opsTime, opsDateTime, formatDollars } from "./format";
import { logChange, queryChanges } from "./store";

const TZ = "America/New_York";

describe("history time is Eastern, not the server clock", () => {
  it("puts a late-evening change on its Eastern day", () => {
    // 01:30 UTC on Nov 4 is 8:30 PM Eastern on Nov 3 (EST, UTC-5).
    expect(opsDayKey("2026-11-04T01:30:00Z", TZ)).toBe("2026-11-03");
    expect(opsTime("2026-11-04T01:30:00Z", TZ)).toBe("8:30 PM");
    expect(opsDateTime("2026-11-04T01:30:00Z", TZ)).toBe("Nov 3, 8:30 PM");
  });

  it("labels Today, Yesterday, then the date", () => {
    expect(opsDayLabel("2026-11-04T01:30:00Z", "2026-11-03", TZ)).toBe("Today");
    expect(opsDayLabel("2026-11-02T15:00:00Z", "2026-11-03", TZ)).toBe("Yesterday");
    expect(opsDayLabel("2026-10-30T15:00:00Z", "2026-11-03", TZ)).toBe("Fri, Oct 30");
    expect(opsDayLabel("not a date", "2026-11-03", TZ)).toBe("Unknown date");
  });

  it("formats dollars and rejects non-numbers", () => {
    expect(formatDollars("1250")).toBe("$1,250");
    expect(formatDollars(null)).toBeNull();
    expect(formatDollars("abc")).toBeNull();
  });
});

describe("describeChange", () => {
  const base = { field: "Acme Wedding", entityId: "R-1", fromValue: null, toValue: null };

  it("hides booking dollars from viewers who can't see money", () => {
    const c = { ...base, kind: "booking_value_changed", fromValue: "1000", toValue: "1250" };
    expect(describeChange(c, { showMoney: true }).detail).toBe("$1,000 to $1,250");
    expect(describeChange(c, { showMoney: false }).detail).toBeNull();
  });

  it("reads the linen safeguard in plain words", () => {
    const d = describeChange({ ...base, kind: "cancel_linen_safeguard", toValue: "signed→lost, no linen items — no action" }, { showMoney: true });
    expect(d.title).toBe("Linen check after a cancellation");
    expect(d.detail).toBe("signed to lost, no linen items, no action");
  });

  it("names who made a risk decision", () => {
    const d = describeChange({ ...base, kind: "risk_status_changed", toValue: "acknowledged (by Jessie)" }, { showMoney: true });
    expect(d).toMatchObject({ title: "Risk marked acknowledged", detail: "by Jessie", area: "risk" });
    // Real statuses are uppercase with underscores.
    expect(describeChange({ ...base, kind: "risk_status_changed", toValue: "IN_PROGRESS" }, { showMoney: true }).title).toBe("Risk marked in progress");
    expect(describeChange({ ...base, kind: "risk_status_changed", toValue: "OPEN" }, { showMoney: true }).title).toBe("Risk reopened");
  });

  it("describes escalation, reschedule and delivery outcome", () => {
    expect(describeChange({ ...base, kind: "risk_escalated", fromValue: "MEDIUM", toValue: "HIGH" }, { showMoney: true }).detail).toBe("Medium to High");
    expect(describeChange({ ...base, kind: "event_rescheduled", fromValue: "2026-11-10", toValue: "2026-11-17" }, { showMoney: true }).detail).toBe("Tue, Nov 10 to Tue, Nov 17");
    const done = describeChange({ ...base, kind: "event_completed", field: "2/3 stops", toValue: "partial" }, { showMoney: true });
    expect(done).toMatchObject({ title: "Event closed, not all stops done", detail: "2 of 3 stops done", tone: "attention" });
  });

  it("falls back readably for a kind it doesn't know", () => {
    const d = describeChange({ ...base, kind: "something_new", fromValue: "a", toValue: "b" }, { showMoney: true });
    expect(d).toMatchObject({ title: "Something new", detail: "a to b", area: null });
  });

  it("files every area kind under exactly one area", () => {
    const all = Object.values(AREA_KINDS).flat();
    expect(new Set(all).size).toBe(all.length);
    for (const k of all) expect(areaOf(k)).not.toBeNull();
  });
});

describe("queryChanges", () => {
  it("filters by kind and text, and pages without skipping same-millisecond rows", () => {
    const ts = new Date("2026-11-01T12:00:00Z"); // every row shares one timestamp, like a scan batch
    for (let i = 0; i < 5; i++) {
      logChange({ source: "risk", entity: "risk", entityId: `qc-${i}`, kind: "risk_detected", field: `QC Party ${i}`, changeKey: `qc|${i}` }, ts);
    }
    logChange({ source: "dispatch", entity: "route", entityId: "qc-route", kind: "driver_assigned", field: "driver", toValue: "QC Marco", changeKey: "qc|driver" }, ts);

    const drivers = queryChanges({ kinds: ["driver_assigned"], q: "QC Marco" });
    expect(drivers.rows.map((r) => r.entityId)).toEqual(["qc-route"]);

    const seen: string[] = [];
    let before: string | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const page = queryChanges({ q: "QC Party", limit: 2, before });
      seen.push(...page.rows.map((r) => r.entityId ?? ""));
      if (!page.nextBefore) break;
      before = page.nextBefore;
    }
    expect(seen.sort()).toEqual(["qc-0", "qc-1", "qc-2", "qc-3", "qc-4"]);
  });

  it("treats % and _ in a search as plain text", () => {
    logChange({ source: "risk", entity: "risk", entityId: "pct", kind: "risk_detected", field: "100% Fun", changeKey: "qc|pct" });
    expect(queryChanges({ q: "100%" }).rows.map((r) => r.entityId)).toContain("pct");
    expect(queryChanges({ q: "%" }).rows.every((r) => (r.field ?? "").includes("%") || (r.fromValue ?? "").includes("%") || (r.toValue ?? "").includes("%"))).toBe(true);
  });
});
