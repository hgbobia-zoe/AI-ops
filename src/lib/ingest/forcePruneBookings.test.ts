import { describe, it, expect, beforeEach } from "vitest";
import { getDb } from "@/lib/db";
import { armBookingsForcePrune, consumeBookingsForcePrune, isBookingsForcePruneArmed } from "./forcePruneBookings";

// The one-shot flag lives in the settings table; clear it between cases so each starts disarmed.
beforeEach(() => {
  getDb().prepare("DELETE FROM settings WHERE key = 'bookings_force_prune_once'").run();
});

describe("bookings force-prune one-shot flag", () => {
  it("starts disarmed", () => {
    expect(isBookingsForcePruneArmed()).toBe(false);
    expect(consumeBookingsForcePrune()).toBe(false);
  });

  it("arm then consume true once; a second consume is false (one-shot)", () => {
    armBookingsForcePrune();
    expect(isBookingsForcePruneArmed()).toBe(true);
    expect(consumeBookingsForcePrune()).toBe(true);
    expect(isBookingsForcePruneArmed()).toBe(false); // consuming disarmed it
    expect(consumeBookingsForcePrune()).toBe(false);
  });

  it("isArmed does not consume the flag", () => {
    armBookingsForcePrune();
    expect(isBookingsForcePruneArmed()).toBe(true);
    expect(isBookingsForcePruneArmed()).toBe(true); // still armed — a status read is non-destructive
    expect(consumeBookingsForcePrune()).toBe(true);
  });
});
