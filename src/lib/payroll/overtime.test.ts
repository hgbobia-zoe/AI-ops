import { describe, expect, it } from "vitest";
import { overtimeFlag, overtimeRule } from "./overtime";
import { resolvePayType } from "./workers";
import { payTypeForUserOn, rateForUserOn, type PayRate } from "@/lib/connecteam";
import type { GustoSnapshotMember } from "./gustoSnapshot";
import type { WorkerRecord } from "./types";

describe("overtime rule", () => {
  it("maps pay types: hourly gets overtime, salary/fixed never, missing is unknown", () => {
    expect(overtimeRule("hourly")).toBe("hourly");
    expect(overtimeRule("salary")).toBe("salaried");
    expect(overtimeRule("fixed")).toBe("salaried");
    expect(overtimeRule(null)).toBe("unknown");
  });

  it("flags hourly over the threshold, never salaried, and asks for the pay type when unknown", () => {
    expect(overtimeFlag(43.85, "hourly", 40)?.label).toBe("Overtime: 3.85h over 40h");
    expect(overtimeFlag(40, "hourly", 40)).toBeNull();
    expect(overtimeFlag(55, "salary", 40)).toBeNull();
    expect(overtimeFlag(44, null, 40)?.label).toContain("pay type not set in Connecteam");
    expect(overtimeFlag(null, "hourly", 40)).toBeNull();
  });
});

describe("Connecteam pay rates", () => {
  const rates = new Map<number, PayRate[]>([
    [1, [{ userId: 1, rate: 24, rateType: "hourly", effectiveDate: "2026-01-01" }]],
    [2, [
      { userId: 2, rate: 4500, rateType: "monthly", effectiveDate: "2026-09-01" },
      { userId: 2, rate: 20, rateType: "hourly", effectiveDate: "2026-01-01" },
    ]],
    [3, [{ userId: 3, rate: 60000, rateType: "yearly", effectiveDate: "2026-12-01" }]],
  ]);

  it("reads hourly vs salaried from the rate in effect on the date", () => {
    expect(payTypeForUserOn(rates, 1, "2026-11-01")).toBe("hourly");
    expect(payTypeForUserOn(rates, 2, "2026-11-01")).toBe("salary"); // switched to monthly in September
    expect(payTypeForUserOn(rates, 2, "2026-06-01")).toBe("hourly"); // was hourly before
    expect(payTypeForUserOn(rates, 3, "2026-11-01")).toBeNull(); // salary only starts in December
    expect(payTypeForUserOn(rates, 9, "2026-11-01")).toBeNull();
  });

  it("never returns a salary amount as an hourly rate", () => {
    expect(rateForUserOn(rates, 1, "2026-11-01")).toBe(24);
    expect(rateForUserOn(rates, 2, "2026-11-01")).toBeNull();
    expect(rateForUserOn(rates, 2, "2026-06-01")).toBe(20);
  });
});

describe("resolvePayType", () => {
  const gm = (payUnit: string | null) => ({ payUnit }) as GustoSnapshotMember;
  const rec = (payType: WorkerRecord["payType"]) => ({ payType }) as WorkerRecord;
  it("Connecteam first, then the Gusto pay unit, then the saved record, else unknown (never a default)", () => {
    expect(resolvePayType("salary", gm("Hour"), rec("hourly"))).toBe("salary");
    expect(resolvePayType(null, gm("Hour"), rec("salary"))).toBe("hourly");
    expect(resolvePayType(null, gm("Year"), null)).toBe("salary");
    expect(resolvePayType(null, null, rec("hourly"))).toBe("hourly");
    expect(resolvePayType(null, gm(null), null)).toBeNull();
  });
});
