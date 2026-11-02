import { describe, it, expect } from "vitest";
import { orderRevokes, taskLines } from "./notify";
import type { LifecycleTask } from "./types";

const t = (adapterId: string, system: string, over: Partial<LifecycleTask> = {}): LifecycleTask => ({
  id: adapterId, employeeId: "E1", adapterId, system, kind: "revoke", title: "", status: "manual_required",
  mode: "manual", required: true, source: "manual", changeKey: adapterId, externalRef: null, error: null,
  retryable: false, approvalId: null, actor: null, createdAt: "", completedAt: null, ...over,
});

describe("people notify", () => {
  it("puts the door first when offboarding", () => {
    const out = orderRevokes([t("connecteam", "Connecteam"), t("quo", "Quo"), t("lockly", "Lockly door")]);
    expect(out.map((x) => x.adapterId)).toEqual(["lockly", "quo", "connecteam"]);
  });
  it("writes plain numbered lines with no dashes", () => {
    const lines = taskLines([t("lockly", "Lockly door"), t("zoe_platform", "Zoe login", { required: false, status: "completed" })]);
    expect(lines).toEqual(["1. Lockly door: do by hand", "2. Zoe login: done (optional)"]);
    for (const l of lines) expect(l).not.toMatch(/[—–-]/);
  });
});

import { lockReminder } from "./notify";
describe("Lockly reminder", () => {
  it("reminds to create the key on onboarding and delete it on offboarding", () => {
    expect(lockReminder([t("lockly", "Lockly door")], "provision")).toMatch(/create their Lockly access key/);
    expect(lockReminder([t("lockly", "Lockly door")], "revoke")).toMatch(/delete their Lockly access key/);
    expect(lockReminder([t("quo", "Quo")], "provision")).toBeNull();
  });
});

import { dueCheckIn } from "./notify";
describe("check in reminders", () => {
  it("fires 30, 60, 90 days after start, once each, within a 7 day window", () => {
    expect(dueCheckIn("2026-10-01", "2026-10-30", [])).toBeNull();
    expect(dueCheckIn("2026-10-01", "2026-10-31", [])).toBe(30);
    expect(dueCheckIn("2026-10-01", "2026-11-03", [30])).toBeNull();
    expect(dueCheckIn("2026-10-01", "2026-11-30", [30])).toBe(60);
    expect(dueCheckIn("2026-10-01", "2026-12-30", [30, 60])).toBe(90);
    expect(dueCheckIn("2025-01-01", "2026-11-02", [])).toBeNull();
  });
});
