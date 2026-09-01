import { describe, expect, it } from "vitest";
import type { Stop } from "@/lib/types";
import { greetName } from "./fanout";

function stop(over: Partial<Stop>): Stop {
  return {
    stopId: "s1",
    routeId: "r1",
    customerId: "c1",
    sequence: 1,
    state: "Waiting",
    custName: "",
    custPhone: "",
    address: "",
    ...over,
  };
}

describe("greetName", () => {
  it("uses the renter's real first name when present", () => {
    // The event/display name is a last-name label; the greeting must not use it.
    expect(greetName(stop({ custFirstName: "Dave", custName: "Lebensohn - Wedding" }))).toBe("Dave");
  });

  it("takes only the first token of a full first name", () => {
    expect(greetName(stop({ custFirstName: "Mary Jane" }))).toBe("Mary");
  });

  it("falls back to the first token of custName when no first name", () => {
    expect(greetName(stop({ custName: "Kadzo Mwangi" }))).toBe("Kadzo");
  });

  it("degrades to a friendly default when nothing is known", () => {
    expect(greetName(stop({}))).toBe("there");
  });
});
