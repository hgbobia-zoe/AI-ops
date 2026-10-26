import { describe, it, expect } from "vitest";
import { coerceSlackApprovers, approversFromEnv, approverIds, isSlackUserId } from "./approvers";

describe("isSlackUserId", () => {
  it("accepts U/W member ids and rejects junk", () => {
    expect(isSlackUserId("U09FK6KJ7GS")).toBe(true);
    expect(isSlackUserId("WABCDEF12")).toBe(true);
    expect(isSlackUserId("UAPP")).toBe(true); // short but validly shaped
    expect(isSlackUserId("hermann@zoe.com")).toBe(false);
    expect(isSlackUserId("John Smith")).toBe(false);
    expect(isSlackUserId("C123CHANNEL")).toBe(false); // channel id, not a user
    expect(isSlackUserId("")).toBe(false);
    expect(isSlackUserId(null)).toBe(false);
  });
});

describe("coerceSlackApprovers", () => {
  it("accepts bare id strings, keeping only valid ones", () => {
    expect(coerceSlackApprovers(["U111AAA", "nope", "U222BBB"], [])).toEqual([
      { id: "U111AAA", name: "" },
      { id: "U222BBB", name: "" },
    ]);
  });
  it("accepts { id, name } objects and trims the name", () => {
    expect(coerceSlackApprovers([{ id: "U111AAA", name: "  Hermann  " }], [])).toEqual([
      { id: "U111AAA", name: "Hermann" },
    ]);
  });
  it("de-dupes by id, first entry (and its name) wins", () => {
    const out = coerceSlackApprovers([{ id: "U1AAAA", name: "First" }, { id: "U1AAAA", name: "Dup" }], []);
    expect(out).toEqual([{ id: "U1AAAA", name: "First" }]);
  });
  it("drops objects without a valid id", () => {
    expect(coerceSlackApprovers([{ id: "", name: "x" }, { name: "y" }, { id: "bad id" }], [])).toEqual([]);
  });
  it("returns the fallback when the value is not an array", () => {
    const fb = [{ id: "U9ZZZZ", name: "" }];
    expect(coerceSlackApprovers(null, fb)).toBe(fb);
    expect(coerceSlackApprovers("U1,U2", fb)).toBe(fb);
  });
  it("an explicit empty array clears the list (nobody) — not the fallback", () => {
    expect(coerceSlackApprovers([], [{ id: "U9ZZZZ", name: "" }])).toEqual([]);
  });
});

describe("approversFromEnv", () => {
  it("parses a comma-separated id list, dropping blanks and junk", () => {
    expect(approversFromEnv("U111AAA, U222BBB , , not-an-id")).toEqual([
      { id: "U111AAA", name: "" },
      { id: "U222BBB", name: "" },
    ]);
  });
  it("is empty for unset/empty", () => {
    expect(approversFromEnv(undefined)).toEqual([]);
    expect(approversFromEnv("")).toEqual([]);
  });
});

describe("approverIds", () => {
  it("extracts just the ids", () => {
    expect(approverIds([{ id: "U1AAAA", name: "A" }, { id: "U2BBBB", name: "B" }])).toEqual(["U1AAAA", "U2BBBB"]);
  });
});
