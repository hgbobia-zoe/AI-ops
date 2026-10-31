import { describe, it, expect } from "vitest";
import { gsDate, gsTime, gsClientContact } from "./format";
import { createIntake, updateIntake, getIntake } from "./store";

// gsDate / gsTime produce the EXACT formats saveEventDetails expects (captured + verified live 2026-10-31):
// dates as "MMM D YYYY", times as "h:mm AM/PM". A wrong format silently drops the date/time on the shell.
describe("gsDate (saveEventDetails date format)", () => {
  it("formats a YYYY-MM-DD date as 'MMM D YYYY'", () => {
    expect(gsDate("2026-09-25")).toBe("Sep 25 2026");
    expect(gsDate("2027-01-05")).toBe("Jan 5 2027");
    expect(gsDate("2026-12-31")).toBe("Dec 31 2026");
  });
  it("returns '' for a missing or malformed date, never a guess", () => {
    expect(gsDate("")).toBe("");
    expect(gsDate("09/25/2026")).toBe("");
    expect(gsDate("2026-13-01")).toBe(""); // month out of range
  });
});

describe("gsTime (saveEventDetails time format)", () => {
  it("formats 24h HH:mm as 'h:mm AM/PM'", () => {
    expect(gsTime("15:00")).toBe("3:00 PM");
    expect(gsTime("09:30")).toBe("9:30 AM");
    expect(gsTime("00:15")).toBe("12:15 AM");
    expect(gsTime("12:00")).toBe("12:00 PM");
  });
  it("returns '' for a missing or malformed time", () => {
    expect(gsTime("")).toBe("");
    expect(gsTime("3pm")).toBe("");
  });
});

describe("gsClientContact (saveNewContact payload)", () => {
  function ready(): string {
    const i = createIntake();
    updateIntake(i.id, { firstName: "Pat", lastName: "Smith", phone: "5555550111", email: "pat@example.com" });
    return i.id;
  }

  it("builds the client contact from the captured customer fields", () => {
    const i = getIntake(ready())!;
    expect(gsClientContact(i)).toEqual({ firstName: "Pat", lastName: "Smith", email: "pat@example.com", mobilePhone: "5555550111" });
  });

  it("returns null when there is no name and no way to reach the customer (shell still carries notes)", () => {
    const i = getIntake(createIntake().id)!; // blank intake
    expect(gsClientContact(i)).toBeNull();
  });

  it("is usable with only a phone (email optional, and vice versa)", () => {
    const i = createIntake();
    updateIntake(i.id, { phone: "5555550199" });
    const got = gsClientContact(getIntake(i.id)!);
    expect(got).not.toBeNull();
    expect(got!.mobilePhone).toBe("5555550199");
    expect(got!.email).toBe("");
  });
});
