import { describe, expect, it } from "vitest";
import { normalizePhone, parseDayOfContact } from "./dayOfContact";

describe("parseDayOfContact", () => {
  it("pulls name + phone from a labeled line", () => {
    expect(parseDayOfContact("Day of Contact: Jane Doe 240-555-1234")).toEqual({
      name: "Jane Doe",
      phone: "+12405551234",
    });
  });

  it("handles label variants and formatting", () => {
    expect(parseDayOfContact("Day-of Coordinator - John Smith (555) 123-4567")).toEqual({
      name: "John Smith",
      phone: "+15551234567",
    });
    expect(parseDayOfContact("day of poc: 301.555.9000")).toEqual({
      name: undefined,
      phone: "+13015559000",
    });
  });

  it("finds the field inside a multi-line description", () => {
    const notes = "Event: Wedding\nSetup by 2pm\nDay of Contact: Priya 202-555-0000\nNotes: fragile";
    expect(parseDayOfContact(notes)).toEqual({ name: "Priya", phone: "+12025550000" });
  });

  it("returns just a name when there is no phone", () => {
    expect(parseDayOfContact("Day of Contact: Site Manager")).toEqual({
      name: "Site Manager",
      phone: undefined,
    });
  });

  it("returns null when the label is absent or the text is empty", () => {
    expect(parseDayOfContact("Customer: Acme Co, 555-111-2222")).toBeNull();
    expect(parseDayOfContact("")).toBeNull();
    expect(parseDayOfContact(null)).toBeNull();
  });
});

describe("normalizePhone", () => {
  it("promotes US numbers to E.164", () => {
    expect(normalizePhone("240-555-1234")).toBe("+12405551234");
    expect(normalizePhone("(240) 555-1234")).toBe("+12405551234");
    expect(normalizePhone("1 240 555 1234")).toBe("+12405551234");
  });

  it("leaves non-standard input untouched", () => {
    expect(normalizePhone("ext 400")).toBe("ext 400");
  });
});
