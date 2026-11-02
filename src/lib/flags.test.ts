import { afterEach, describe, expect, it } from "vitest";
import { flagOn } from "./flags";

afterEach(() => {
  delete process.env.TEST_FLAG_X;
});

describe("flagOn", () => {
  it("is ON when unset (a shipped feature needs no arming)", () => {
    expect(flagOn("TEST_FLAG_X")).toBe(true);
  });
  it("stays on for true / 1 / anything else", () => {
    for (const v of ["true", "1", "on", "yes", ""]) {
      process.env.TEST_FLAG_X = v;
      expect(flagOn("TEST_FLAG_X")).toBe(true);
    }
  });
  it("false / 0 / off / no turn it off, any case", () => {
    for (const v of ["false", "0", "off", "no", " FALSE "]) {
      process.env.TEST_FLAG_X = v;
      expect(flagOn("TEST_FLAG_X")).toBe(false);
    }
  });
});
