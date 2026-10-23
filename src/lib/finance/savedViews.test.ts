import { describe, it, expect } from "vitest";
import {
  listFinanceSavedViews,
  saveFinanceSavedView,
  deleteFinanceSavedView,
  sanitizeViewState,
  normalizeViewName,
  SAVED_VIEW_NAME_MAX,
} from "./savedViews";

// DATABASE_PATH is ":memory:" (vitest.config.ts) and the setup clears every table per file.
describe("finance saved views — store CRUD + idempotency", () => {
  it("saves, lists, and round-trips state (allowlisted keys only)", () => {
    const v = saveFinanceSavedView({
      name: "Q1 projects",
      state: { view: "projects", start: "2026-01-01", end: "2026-03-31", project: "P-1", junk: "nope" },
      actor: "Owner",
    });
    expect(v).not.toBeNull();
    expect(v!.createdBy).toBe("Owner");
    expect(v!.state).toEqual({ view: "projects", start: "2026-01-01", end: "2026-03-31", project: "P-1" }); // 'junk' dropped
    const list = listFinanceSavedViews();
    expect(list.map((x) => x.name)).toContain("Q1 projects");
  });

  it("is idempotent by name (case-insensitive) — re-saving updates in place, keeps the id", () => {
    const first = saveFinanceSavedView({ name: "My View", state: { view: "routes" } });
    const again = saveFinanceSavedView({ name: "my view", state: { view: "labor" } }); // different case
    expect(again!.id).toBe(first!.id); // same row, not a duplicate
    expect(again!.state).toEqual({ view: "labor" }); // updated
    expect(listFinanceSavedViews().filter((x) => x.id === first!.id)).toHaveLength(1);
  });

  it("rejects an invalid name", () => {
    expect(saveFinanceSavedView({ name: "   ", state: {} })).toBeNull();
    expect(saveFinanceSavedView({ name: "a".repeat(SAVED_VIEW_NAME_MAX + 1), state: {} })).toBeNull();
    expect(saveFinanceSavedView({ name: 42 as unknown, state: {} })).toBeNull();
  });

  it("deletes by id and by name, reporting whether a row was removed", () => {
    const v = saveFinanceSavedView({ name: "To Delete", state: { view: "variance" } })!;
    expect(deleteFinanceSavedView({ id: v.id })).toBe(true);
    expect(deleteFinanceSavedView({ id: v.id })).toBe(false); // already gone
    const byName = saveFinanceSavedView({ name: "By Name", state: {} })!;
    expect(deleteFinanceSavedView({ name: "BY NAME" })).toBe(true); // case-insensitive
    expect(listFinanceSavedViews().some((x) => x.id === byName.id)).toBe(false);
  });
});

describe("finance saved views — pure helpers", () => {
  it("normalizeViewName trims and bounds length", () => {
    expect(normalizeViewName("  hello  ")).toBe("hello");
    expect(normalizeViewName("")).toBeNull();
    expect(normalizeViewName("x".repeat(SAVED_VIEW_NAME_MAX))).toHaveLength(SAVED_VIEW_NAME_MAX);
    expect(normalizeViewName("x".repeat(SAVED_VIEW_NAME_MAX + 1))).toBeNull();
    expect(normalizeViewName(null)).toBeNull();
  });

  it("sanitizeViewState keeps only known string keys and trims them", () => {
    expect(sanitizeViewState({ view: " projects ", period: "thisCycle", bogus: 1, project: "" })).toEqual({
      view: "projects",
      period: "thisCycle",
    }); // empty 'project' and unknown 'bogus' dropped
    expect(sanitizeViewState(null)).toEqual({});
    expect(sanitizeViewState("not an object")).toEqual({});
  });
});
