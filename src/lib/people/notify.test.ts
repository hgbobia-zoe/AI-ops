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
