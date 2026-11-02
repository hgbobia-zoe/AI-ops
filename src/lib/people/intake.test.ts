import { describe, it, expect } from "vitest";
import { displayNameFor, gustoFields, normalizeIntake, toE164 } from "./intake";

const good = {
  legalFirstName: "Jordan", legalLastName: "Rivera", preferredName: "Jo", personalEmail: "JO@Example.com",
  phone: "(301) 555-0100", dateOfBirth: "1999-04-02", street: "1 Main St", city: "Laurel", state: "md", zip: "20707",
  payType: "hourly", payRate: "18.5",
};

describe("hire intake", () => {
  it("normalizes a complete intake", () => {
    const r = normalizeIntake(good, "2026-11-02");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.intake.phone).toBe("+13015550100");
    expect(r.intake.state).toBe("MD");
    expect(r.intake.personalEmail).toBe("jo@example.com");
    expect(r.intake.payRate).toBe(18.5);
    expect(r.intake.jobTitle).toBe("Sales Associate");
    expect(displayNameFor(r.intake)).toBe("Jo Rivera");
  });
  it("lists every missing field in plain words", () => {
    const r = normalizeIntake({ legalFirstName: "A" }, "2026-11-02");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join(" ")).toMatch(/last name.*personal email.*phone.*birth.*street.*State.*ZIP.*Pay rate/s);
  });
  it("rejects a bad phone and an under 16 birth date", () => {
    const r = normalizeIntake({ ...good, phone: "555", dateOfBirth: "2015-01-01" }, "2026-11-02");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join(" ")).toMatch(/10 digit.*under 16/s);
    expect(toE164("13015550100")).toBe("+13015550100");
  });
  it("gives Gusto fields with self onboarding on and never asks for SSN or bank", () => {
    const r = normalizeIntake(good, "2026-11-02");
    if (!r.ok) throw new Error("bad");
    const f = gustoFields(r.intake, "jordan.rivera@zoeeventsdmv.com", "2026-11-10");
    expect(f.find(([k]) => k === "Pay")?.[1]).toBe("$18.50 per hour");
    expect(f.at(-1)?.[1]).toMatch(/self onboarding|SSN/i);
    expect(JSON.stringify(r.intake)).not.toMatch(/ssn|bank/i);
  });
});
