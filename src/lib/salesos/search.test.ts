import { describe, it, expect } from "vitest";
import { matchesQuery, filterProjects, normalizeQuery, type SearchableProject } from "./search";

const carter: SearchableProject = {
  id: "101",
  clientName: "Abby Carter",
  eventName: "Carter - Dulles Town Center",
  value: 4200,
  stage: "Quote Sent",
  venue: "Dulles Town Center",
  location: "21100 Dulles Town Cir, Sterling VA",
};
const nguyen: SearchableProject = {
  id: "102",
  clientName: "Binh Nguyen",
  eventName: "Nguyen Wedding",
  value: 18750,
  stage: "Need Follow-up",
  venue: "Lansdowne Resort",
  location: null,
};
const sparse: SearchableProject = { id: "103", clientName: null, eventName: null, value: null };

const all = [carter, nguyen, sparse];

describe("salesos search — matchesQuery", () => {
  it("matches on client name (case-insensitive)", () => {
    expect(matchesQuery(carter, "abby")).toBe(true);
    expect(matchesQuery(carter, "ABBY CARTER")).toBe(true);
    expect(matchesQuery(carter, "nguyen")).toBe(false);
  });

  it("matches on project / event label", () => {
    expect(matchesQuery(carter, "dulles town center")).toBe(true);
    expect(matchesQuery(nguyen, "wedding")).toBe(true);
  });

  it("matches on address (venue and location)", () => {
    expect(matchesQuery(carter, "sterling")).toBe(true); // location
    expect(matchesQuery(nguyen, "lansdowne")).toBe(true); // venue
  });

  it("matches on value, both raw and formatted", () => {
    expect(matchesQuery(carter, "4200")).toBe(true);
    expect(matchesQuery(carter, "4,200")).toBe(true);
    expect(matchesQuery(carter, "$4,200")).toBe(true);
    expect(matchesQuery(carter, "9999")).toBe(false);
  });

  it("matches on stage label", () => {
    expect(matchesQuery(carter, "quote sent")).toBe(true);
    expect(matchesQuery(nguyen, "follow-up")).toBe(true);
  });

  it("requires every whitespace-separated term to match (AND across terms)", () => {
    expect(matchesQuery(carter, "carter dulles")).toBe(true); // spans event label
    expect(matchesQuery(carter, "abby lansdowne")).toBe(false); // lansdowne is the other lead
  });

  it("treats an empty or whitespace-only query as matching everything", () => {
    expect(matchesQuery(carter, "")).toBe(true);
    expect(matchesQuery(sparse, "   ")).toBe(true);
    expect(matchesQuery(sparse, "\t \n")).toBe(true);
  });

  it("trims surrounding whitespace before matching", () => {
    expect(matchesQuery(carter, "   abby   ")).toBe(true);
    expect(matchesQuery(carter, "  dulles  ")).toBe(true);
  });

  it("never matches text that isn't present", () => {
    expect(matchesQuery(carter, "zzz-no-such-thing")).toBe(false);
  });

  it("handles projects with null/absent fields without throwing", () => {
    expect(matchesQuery(sparse, "anything")).toBe(false);
    expect(matchesQuery(sparse, "")).toBe(true);
  });
});

describe("salesos search — filterProjects", () => {
  it("empty query returns ALL projects (same reference contents, order preserved)", () => {
    expect(filterProjects(all, "")).toEqual(all);
    expect(filterProjects(all, "   ")).toEqual(all);
  });

  it("a no-match query returns none", () => {
    expect(filterProjects(all, "zzz-no-such-thing")).toEqual([]);
  });

  it("filters to the matching subset and preserves input order", () => {
    expect(filterProjects(all, "dulles")).toEqual([carter]);
    expect(filterProjects(all, "VA")).toEqual([carter]); // case-insensitive location token
  });

  it("is case-insensitive end to end", () => {
    expect(filterProjects(all, "NGUYEN")).toEqual([nguyen]);
  });
});

describe("salesos search — normalizeQuery", () => {
  it("trims and lowercases", () => {
    expect(normalizeQuery("  Abby CARTER ")).toBe("abby carter");
  });
  it("collapses a whitespace-only query to empty", () => {
    expect(normalizeQuery("   \t\n ")).toBe("");
  });
});
