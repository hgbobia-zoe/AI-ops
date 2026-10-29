// Payroll nav URL helpers — deep-link + period preservation + active-state (the sidebar sub-nav contract).

import { describe, it, expect } from "vitest";
import { clampWeeksAgo, periodQS, payrollSubHref, payrollSubActive, periodNavHref } from "./nav";

describe("clampWeeksAgo", () => {
  it("defaults to 1 and clamps to 1–8", () => {
    expect(clampWeeksAgo(undefined)).toBe(1);
    expect(clampWeeksAgo(null)).toBe(1);
    expect(clampWeeksAgo("0")).toBe(1);
    expect(clampWeeksAgo("3")).toBe(3);
    expect(clampWeeksAgo("99")).toBe(8);
    expect(clampWeeksAgo("abc")).toBe(1);
    expect(clampWeeksAgo(2.7)).toBe(2);
  });
});

describe("payrollSubHref — preserves destination + selected period", () => {
  it("overview is the bare path (default period) and carries the period otherwise", () => {
    expect(payrollSubHref("/payroll", "overview", 1)).toBe("/payroll");
    expect(payrollSubHref("/payroll", "overview", 3)).toBe("/payroll?weeksAgo=3");
  });
  it("a tab section encodes the tab and carries the period", () => {
    expect(payrollSubHref("/payroll", "review", 1)).toBe("/payroll?tab=review");
    expect(payrollSubHref("/payroll", "review", 2)).toBe("/payroll?tab=review&weeksAgo=2");
    expect(payrollSubHref("/payroll", "settings", 4)).toBe("/payroll?tab=settings&weeksAgo=4");
  });
  it("periodQS is empty for the default week", () => {
    expect(periodQS(1)).toBe("");
    expect(periodQS(5)).toBe("weeksAgo=5");
  });
});

describe("payrollSubActive — only lit on the blade path with the matching tab", () => {
  it("bare path ⇒ overview active", () => {
    expect(payrollSubActive("/payroll", null, "/payroll", "overview")).toBe(true);
    expect(payrollSubActive("/payroll", null, "/payroll", "review")).toBe(false);
  });
  it("tab param drives the active sub-section", () => {
    expect(payrollSubActive("/payroll", "review", "/payroll", "review")).toBe(true);
    expect(payrollSubActive("/payroll", "review", "/payroll", "overview")).toBe(false);
  });
  it("never active on a different blade path", () => {
    expect(payrollSubActive("/people", "overview", "/payroll", "overview")).toBe(false);
  });
});

describe("periodNavHref — period selector / history preserves the tab", () => {
  it("omits weeksAgo for the default week and keeps the tab", () => {
    expect(periodNavHref("overview", 1)).toBe("/payroll?tab=overview");
    expect(periodNavHref("review", 1)).toBe("/payroll?tab=review");
    expect(periodNavHref("review", 3)).toBe("/payroll?tab=review&weeksAgo=3");
  });
});
