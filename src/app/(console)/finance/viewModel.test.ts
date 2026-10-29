import { describe, it, expect } from "vitest";
import {
  money, signedMoney, hrs, pct,
  FINANCE_VIEWS, VIEW_NAV_GROUPS, navKeyForView, isOverviewView, isViewKey, laborHeadline,
  snapshotStatusTone, phaseTone, varianceTone,
  type ViewKey,
} from "./viewModel";

describe("formatters — unavailable vs zero, no re-scaling", () => {
  it("money: null is unavailable (—), never 0", () => {
    expect(money(null)).toBe("—");
    expect(money(undefined)).toBe("—");
  });
  it("money: a true zero is $0 (distinct from unavailable)", () => {
    expect(money(0)).toBe("$0");
  });
  it("money: dollars are NOT re-scaled (cents conversion stays upstream)", () => {
    // Input is already dollars; money() only rounds+groups, it never divides by 100.
    expect(money(1234.56)).toBe("$1,235");
    expect(money(2850)).toBe("$2,850");
  });
  it("money: negatives render with a leading -$", () => {
    expect(money(-500)).toBe("-$500");
  });
  it("signedMoney always carries a direction sign", () => {
    expect(signedMoney(250)).toBe("+$250");
    expect(signedMoney(-250)).toBe("-$250");
    expect(signedMoney(0)).toBe("$0");
  });
  it("hrs / pct pass null straight to —", () => {
    expect(hrs(null)).toBe("—");
    expect(hrs(12)).toBe("12 h");
    expect(pct(null)).toBe("—");
    expect(pct(0.1234)).toBe("12%");
  });
});

describe("view keys + nav grouping", () => {
  it("every nav item is a valid view key", () => {
    for (const g of VIEW_NAV_GROUPS) {
      for (const v of g.items) expect((FINANCE_VIEWS as readonly string[]).includes(v)).toBe(true);
    }
  });
  it("the week/cycle period-lens aliases are NOT shown as separate nav rows (they alias Overview)", () => {
    const shown = VIEW_NAV_GROUPS.flatMap((g) => g.items);
    expect(shown).not.toContain("week");
    expect(shown).not.toContain("cycle");
  });
  it("every non-alias view is reachable from exactly one nav group", () => {
    const shown = VIEW_NAV_GROUPS.flatMap((g) => g.items);
    const aliases: ViewKey[] = ["week", "cycle"];
    const expected = FINANCE_VIEWS.filter((v) => !aliases.includes(v));
    expect([...shown].sort()).toEqual([...expected].sort());
    // no duplicates
    expect(new Set(shown).size).toBe(shown.length);
  });
  it("groups are the three analytical sections", () => {
    expect(VIEW_NAV_GROUPS.map((g) => g.label)).toEqual(["Overview", "Analysis", "Reconciliation"]);
  });
  it("navKeyForView lights Overview for its period-lens aliases", () => {
    expect(navKeyForView("week")).toBe("overview");
    expect(navKeyForView("cycle")).toBe("overview");
    expect(navKeyForView("projects")).toBe("projects");
    expect(navKeyForView("reconciliation")).toBe("reconciliation");
  });
  it("isOverviewView covers overview + its aliases only", () => {
    expect(isOverviewView("overview")).toBe(true);
    expect(isOverviewView("week")).toBe(true);
    expect(isOverviewView("cycle")).toBe(true);
    expect(isOverviewView("labor")).toBe(false);
  });
  it("isViewKey guards unknown values (deep links never 404 into overview silently via a bad key)", () => {
    expect(isViewKey("projects")).toBe(true);
    expect(isViewKey("week")).toBe(true);
    expect(isViewKey("bogus")).toBe(false);
    expect(isViewKey(undefined)).toBe(false);
  });
});

describe("laborHeadline — the audit's 'Labor (planned)' mismatch is resolved honestly", () => {
  it("shows ACTUAL and labels the basis Actual when timesheets priced out", () => {
    const lh = laborHeadline({ plannedCost: 1000, actualCost: 1200, rateStatus: "ACTUAL" });
    expect(lh.amount).toBe(1200);
    expect(lh.basis).toBe("actual");
    expect(lh.basisLabel).toBe("Actual");
    expect(lh.state.tone).toBe("positive");
  });
  it("falls back to PLANNED and labels it Planned (not yet actual) — never silently 'actual'", () => {
    const lh = laborHeadline({ plannedCost: 1000, actualCost: null, rateStatus: "ACTUAL" });
    expect(lh.amount).toBe(1000);
    expect(lh.basis).toBe("planned");
    expect(lh.state.tone).toBe("attention");
  });
  it("is Unavailable (not 0) when nothing priced out", () => {
    const lh = laborHeadline({ plannedCost: null, actualCost: null, rateStatus: "UNAVAILABLE" });
    expect(lh.amount).toBeNull();
    expect(lh.basis).toBe("unavailable");
    expect(lh.state.tone).toBe("neutral");
  });
});

describe("status → tone mappings (migrated onto the shared renderer)", () => {
  it("snapshot status", () => {
    expect(snapshotStatusTone("RECONCILED")).toBe("positive");
    expect(snapshotStatusTone("ESTIMATED")).toBe("info");
    expect(snapshotStatusTone("PROVISIONAL")).toBe("attention");
  });
  it("reconciliation phase", () => {
    expect(phaseTone("final")).toBe("positive");
    expect(phaseTone("revision")).toBe("attention");
    expect(phaseTone("snapshot")).toBe("neutral");
  });
  it("variance direction: unknown side → neutral, favorable → positive, unfavorable → critical", () => {
    expect(varianceTone(null)).toBe("neutral");
    expect(varianceTone(true)).toBe("positive");
    expect(varianceTone(false)).toBe("critical");
  });
});
