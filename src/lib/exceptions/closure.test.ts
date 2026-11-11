import { describe, it, expect } from "vitest";
import { sourceClosure } from "./closure";

const TODAY = "2026-11-10";

describe("sourceClosure (close only on what the source recorded)", () => {
  it("a risk the engine cleared before its day reads as fixed", () => {
    const c = sourceClosure({ kind: "risk", status: "RESOLVED", date: "2026-11-14", resolvedAt: "2026-11-12T15:00:00Z" }, TODAY)!;
    expect(c.as).toBe("resolved");
    expect(c.disposition).toMatch(/closed this risk as fixed/);
  });

  it("an undated risk that was resolved reads as fixed", () => {
    expect(sourceClosure({ kind: "risk", status: "RESOLVED", date: null, resolvedAt: "2026-11-09T15:00:00Z" }, TODAY)!.as).toBe("resolved");
  });

  it("a risk closed because its day passed is set aside, not called fixed", () => {
    const c = sourceClosure({ kind: "risk", status: "RESOLVED", date: "2026-11-01", resolvedAt: "2026-11-02T11:00:00Z" }, TODAY)!;
    expect(c.as).toBe("disposed");
    expect(c.disposition).toMatch(/2026-11-01\) has passed/);
  });

  it("a risk still open but past its day is set aside", () => {
    expect(sourceClosure({ kind: "risk", status: "OPEN", date: "2026-11-01", resolvedAt: null }, TODAY)!.as).toBe("disposed");
  });

  it("a risk a person dismissed on the board is closed as their decision", () => {
    const c = sourceClosure({ kind: "risk", status: "DISMISSED", date: "2026-11-20", resolvedAt: null }, TODAY)!;
    expect(c.as).toBe("disposed");
    expect(c.by).toBe("Event Risk board");
  });

  it("a risk still open for a future day stays with a person", () => {
    expect(sourceClosure({ kind: "risk", status: "OPEN", date: "2026-11-20", resolvedAt: null }, TODAY)).toBeNull();
  });

  it("a dead-lettered write-back that later landed is resolved; one still dead is not", () => {
    expect(sourceClosure({ kind: "dead_letter", status: "done", updatedAt: null }, TODAY)!.as).toBe("resolved");
    expect(sourceClosure({ kind: "dead_letter", status: "dead", updatedAt: null }, TODAY)).toBeNull();
  });

  it("a write-back a person dismissed is set aside, not called fixed", () => {
    const c = sourceClosure({ kind: "dead_letter", status: "dismissed", updatedAt: null }, TODAY)!;
    expect(c.as).toBe("disposed");
    expect(c.by).toBe("Write-back outbox");
  });

  it("a missing source record never closes anything", () => {
    expect(sourceClosure({ kind: "missing" }, TODAY)).toBeNull();
  });

  it("closure text has no dashes", () => {
    const all = [
      sourceClosure({ kind: "risk", status: "RESOLVED", date: null, resolvedAt: null }, TODAY),
      sourceClosure({ kind: "risk", status: "OPEN", date: "2026-11-01", resolvedAt: null }, TODAY),
      sourceClosure({ kind: "risk", status: "DISMISSED", date: null, resolvedAt: null }, TODAY),
      sourceClosure({ kind: "dead_letter", status: "done", updatedAt: null }, TODAY),
    ];
    for (const c of all) expect(c!.disposition).not.toMatch(/[—–]| - /);
  });
});
