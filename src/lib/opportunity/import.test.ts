import { describe, it, expect } from "vitest";
import { parseCsv, rowToRaw } from "./import";

describe("parseCsv", () => {
  it("parses a header + rows into objects", () => {
    const rows = parseCsv("name,city\nAlpha,Washington\nBeta,Bethesda");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ name: "Alpha", city: "Washington" });
  });
  it("handles quoted fields with commas and escaped quotes", () => {
    const rows = parseCsv('name,categories\n"Gala, Annual","tent,chairs"\n"He said ""hi""",tables');
    expect(rows[0].name).toBe("Gala, Annual");
    expect(rows[0].categories).toBe("tent,chairs");
    expect(rows[1].name).toBe('He said "hi"');
  });
  it("returns empty for a header-only or blank input", () => {
    expect(parseCsv("name,city")).toEqual([]);
    expect(parseCsv("")).toEqual([]);
  });
  it("lowercases headers", () => {
    expect(parseCsv("Name,SOURCE_URL\nX,http://y").at(0)).toEqual({ name: "X", source_url: "http://y" });
  });
});

describe("rowToRaw", () => {
  it("maps an event row with categories + contact into a RawOpportunity", () => {
    const raw = rowToRaw({ name: "DMV Summit 2027", kind: "event", date: "2027-05-14", city: "Washington", state: "DC", categories: "tent, chairs", contact_name: "Dana Reyes", contact_email: "d@x.org", contact_role: "planner" });
    expect(raw).not.toBeNull();
    expect(raw!.kind).toBe("EVENT");
    expect(raw!.estimatedDate).toBe("2027-05-14");
    expect(raw!.zoeCategoriesHint).toEqual(["tent", "chairs"]);
    expect(raw!.entities?.[0]).toMatchObject({ name: "Dana Reyes", role: "EVENT_PLANNER", isPrimaryTarget: true, email: "d@x.org" });
  });
  it("defaults kind to EVENT and drops unknown categories", () => {
    const raw = rowToRaw({ name: "X", categories: "tent, spaceship" });
    expect(raw!.kind).toBe("EVENT");
    expect(raw!.zoeCategoriesHint).toEqual(["tent"]);
  });
  it("maps a procurement row with an agency buyer", () => {
    const raw = rowToRaw({ name: "County RFP", kind: "procurement", agency: "Montgomery County", deadline: "2027-01-10" });
    expect(raw!.kind).toBe("PROCUREMENT");
    expect(raw!.deadline).toBe("2027-01-10");
    expect(raw!.entities?.some((e) => e.role === "DIRECT_BUYER")).toBe(true);
  });
  it("returns null without a name", () => {
    expect(rowToRaw({ city: "Washington" })).toBeNull();
  });
  it("ignores an invalid date", () => {
    expect(rowToRaw({ name: "X", date: "May 2027" })!.estimatedDate).toBeNull();
  });
});
