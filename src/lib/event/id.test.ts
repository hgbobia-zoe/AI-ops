import { describe, it, expect } from "vitest";
import { canonicalEventId, eventIdEquals, isEventId } from "./id";

describe("canonicalEventId", () => {
  it("normalizes a numeric id to its decimal string", () => {
    expect(canonicalEventId(62232)).toBe("62232");
  });

  it("collapses the three aliases (number, string, +/leading-zeros) to ONE key", () => {
    // booking_id (string) == stops.tx_id (number) == event_id (zero-padded) — all the same GS id.
    const a = canonicalEventId("62232");
    const b = canonicalEventId(62232);
    const c = canonicalEventId("062232");
    const d = canonicalEventId("+62232");
    expect(a).toBe("62232");
    expect(b).toBe("62232");
    expect(c).toBe("62232");
    expect(d).toBe("62232");
  });

  it("trims surrounding whitespace on string ids", () => {
    expect(canonicalEventId("  62232 ")).toBe("62232");
  });

  it("preserves precision on very large integer ids via BigInt", () => {
    const big = "900719925474099100"; // beyond Number.MAX_SAFE_INTEGER
    expect(canonicalEventId(big)).toBe(big);
  });

  it("returns null for unresolvable inputs (never fabricated)", () => {
    expect(canonicalEventId(null)).toBeNull();
    expect(canonicalEventId(undefined)).toBeNull();
    expect(canonicalEventId("")).toBeNull();
    expect(canonicalEventId("   ")).toBeNull();
    expect(canonicalEventId(NaN)).toBeNull();
    expect(canonicalEventId(Infinity)).toBeNull();
    expect(canonicalEventId(12.5)).toBeNull();
    expect(canonicalEventId(-5)).toBeNull();
  });

  it("keeps a non-integer string as its trimmed self (so it still matches itself, not reshaped)", () => {
    expect(canonicalEventId("abc-123")).toBe("abc-123");
    expect(canonicalEventId("  abc-123  ")).toBe("abc-123");
  });
});

describe("eventIdEquals", () => {
  it("matches across aliases", () => {
    expect(eventIdEquals("62232", 62232)).toBe(true);
    expect(eventIdEquals("062232", "+62232")).toBe(true);
  });

  it("does not match different ids", () => {
    expect(eventIdEquals("62232", "62233")).toBe(false);
  });

  it("two unresolvable inputs are NOT equal (can't assert identity on null)", () => {
    expect(eventIdEquals(null, null)).toBe(false);
    expect(eventIdEquals("", undefined)).toBe(false);
  });
});

describe("isEventId", () => {
  it("is true only for a value that normalizes to itself", () => {
    expect(isEventId("62232")).toBe(true);
    expect(isEventId("062232")).toBe(false); // normalizes to "62232", not itself
    expect(isEventId(62232)).toBe(false); // not a string
    expect(isEventId("")).toBe(false);
  });
});
