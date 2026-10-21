import { describe, it, expect } from "vitest";
import { matchesQuery, matchesState, filterProjects, normalizeQuery, type SearchableProject } from "./search";

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

describe("salesos search — matchesState (the state-filter predicate)", () => {
  it("matches everything when no state filter is set (default = all)", () => {
    expect(matchesState("new", null)).toBe(true);
    expect(matchesState("quote_sent", null)).toBe(true);
    expect(matchesState("action_needed", undefined)).toBe(true);
    expect(matchesState("signed", "")).toBe(true);
    expect(matchesState(null, null)).toBe(true); // a row with no status still shows under "All"
  });

  it("matches only the selected board status (exact)", () => {
    expect(matchesState("new", "new")).toBe(true);
    expect(matchesState("quote_sent", "quote_sent")).toBe(true);
    expect(matchesState("action_needed", "action_needed")).toBe(true);
    expect(matchesState("signed", "signed")).toBe(true);
  });

  it("excludes rows whose status differs from the filter", () => {
    expect(matchesState("new", "quote_sent")).toBe(false);
    expect(matchesState("quote_sent", "signed")).toBe(false);
    expect(matchesState("follow_up", "action_needed")).toBe(false);
  });

  it("a row with no status is excluded once a specific state is selected", () => {
    expect(matchesState(null, "new")).toBe(false);
    expect(matchesState(undefined, "signed")).toBe(false);
  });

  it("composes with matchesQuery (both must pass to keep a row)", () => {
    // carter is Quote Sent — passes a 'quote_sent' filter + a 'dulles' query, fails a 'signed' filter.
    const keep = (statusFilter: string | null, q: string): boolean => matchesQuery(carter, q) && matchesState("quote_sent", statusFilter);
    expect(keep("quote_sent", "dulles")).toBe(true);
    expect(keep(null, "dulles")).toBe(true);
    expect(keep("signed", "dulles")).toBe(false); // state filter rejects
    expect(keep("quote_sent", "nguyen")).toBe(false); // query rejects
  });
});

describe("salesos board — state filter narrows CARDS, never collapses COLUMNS", () => {
  // Mirrors SalesBoard's `visible` memo: the board keeps ALL columns and filters each column's cards by
  // matchesState(card.status) && matchesQuery(card). A state filter must leave every column present
  // (Jira-style) with only the matching-status column populated — NOT switch to a single-column view.
  const columns = ["new", "quote_sent", "action_needed", "signed"] as const;
  type Card = { id: string; status: (typeof columns)[number]; name: string };
  const cardsByColumn: Record<string, Card[]> = {
    new: [{ id: "1", status: "new", name: "Alpha" }],
    quote_sent: [
      { id: "2", status: "quote_sent", name: "Bravo" },
      { id: "3", status: "quote_sent", name: "Charlie" },
    ],
    action_needed: [{ id: "4", status: "action_needed", name: "Delta" }],
    signed: [{ id: "5", status: "signed", name: "Echo" }],
  };
  const visibleByColumn = (stateFilter: string | null, q: string): Record<string, Card[]> => {
    const out: Record<string, Card[]> = {};
    for (const col of columns) {
      out[col] = cardsByColumn[col].filter((c) => matchesState(c.status, stateFilter) && matchesQuery({ id: c.id, eventName: c.name }, q));
    }
    return out;
  };

  it("keeps every column present when a state is selected (board never collapses)", () => {
    const v = visibleByColumn("quote_sent", "");
    expect(Object.keys(v)).toEqual(["new", "quote_sent", "action_needed", "signed"]);
  });

  it("populates only the matching-status column; the others empty out", () => {
    const v = visibleByColumn("quote_sent", "");
    expect(v.quote_sent.map((c) => c.id)).toEqual(["2", "3"]);
    expect(v.new).toEqual([]);
    expect(v.action_needed).toEqual([]);
    expect(v.signed).toEqual([]);
  });

  it("shows all columns' cards when the filter is cleared (All)", () => {
    const v = visibleByColumn(null, "");
    expect(v.new).toHaveLength(1);
    expect(v.quote_sent).toHaveLength(2);
    expect(v.action_needed).toHaveLength(1);
    expect(v.signed).toHaveLength(1);
  });

  it("composes with search — both the state filter and the query narrow the cards", () => {
    const v = visibleByColumn("quote_sent", "charlie");
    expect(v.quote_sent.map((c) => c.id)).toEqual(["3"]); // Bravo dropped by the query
    expect(v.new).toEqual([]);
  });

  it("honest shown/total counts: shown = visible cards across ALL columns, total = every card", () => {
    const total = columns.reduce((n, col) => n + cardsByColumn[col].length, 0);
    const v = visibleByColumn("quote_sent", "");
    const shown = columns.reduce((n, col) => n + v[col].length, 0);
    expect(total).toBe(5);
    expect(shown).toBe(2); // only the two Quote Sent cards
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
