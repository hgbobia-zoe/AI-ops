import { describe, expect, it } from "vitest";
import {
  buildMergePatch,
  dedupeStats,
  findDuplicateGroups,
  formsOneGroup,
  missingAfterMerge,
  phoneKey,
  pickSurvivor,
  type QuoContact,
} from "./quoContactsDedupe";

function c(id: string, o: {
  first?: string;
  last?: string;
  company?: string;
  phones?: string[];
  emails?: string[];
  createdAt?: string;
  externalId?: string;
  custom?: QuoContact["customFields"];
} = {}): QuoContact {
  return {
    id,
    externalId: o.externalId ?? null,
    createdAt: o.createdAt ?? "2025-01-01T00:00:00Z",
    defaultFields: {
      firstName: o.first ?? null,
      lastName: o.last ?? null,
      company: o.company ?? null,
      phoneNumbers: (o.phones ?? []).map((value, i) => ({ name: "mobile", value, id: `${id}-p${i}` })),
      emails: (o.emails ?? []).map((value, i) => ({ name: "primary", value, id: `${id}-e${i}` })),
    },
    customFields: o.custom ?? [],
  };
}

describe("phoneKey", () => {
  it("normalizes US formats to the last 10 digits", () => {
    expect(phoneKey("+1 (301) 555-0101")).toBe("3015550101");
    expect(phoneKey("301.555.0101")).toBe("3015550101");
    expect(phoneKey("13015550101")).toBe("3015550101");
  });
  it("rejects short numbers", () => {
    expect(phoneKey("555-0101")).toBeNull();
    expect(phoneKey(null)).toBeNull();
  });
});

describe("findDuplicateGroups", () => {
  it("groups contacts that share a phone in different formats", () => {
    const g = findDuplicateGroups([
      c("a", { first: "Pat", last: "Smith", phones: ["+13015550101"] }),
      c("b", { first: "Pat", last: "Smith", phones: ["(301) 555-0101"] }),
      c("x", { first: "Lee", last: "Jones", phones: ["+12025550199"] }),
    ]);
    expect(g).toHaveLength(1);
    expect(g[0].contactIds).toEqual(["a", "b"]);
    expect(g[0].confidence).toBe("exact");
    expect(g[0].sharedPhones).toEqual(["3015550101"]);
  });

  it("groups on a shared email regardless of case", () => {
    const g = findDuplicateGroups([
      c("a", { first: "Pat", emails: ["Pat@Example.com"] }),
      c("b", { first: "Pat", emails: ["pat@example.com"] }),
    ]);
    expect(g).toHaveLength(1);
    expect(g[0].sharedEmails).toEqual(["pat@example.com"]);
  });

  it("links transitively (A~B by phone, B~C by email)", () => {
    const g = findDuplicateGroups([
      c("a", { first: "Pat", phones: ["3015550101"] }),
      c("b", { first: "Pat", phones: ["3015550101"], emails: ["pat@example.com"] }),
      c("c", { first: "Pat", emails: ["pat@example.com"] }),
    ]);
    expect(g).toHaveLength(1);
    expect(g[0].contactIds).toEqual(["a", "b", "c"]);
  });

  it("treats a nameless copy as an exact duplicate of the named contact", () => {
    const g = findDuplicateGroups([c("a", { first: "Pat", last: "Smith", phones: ["3015550101"] }), c("b", { phones: ["3015550101"] })]);
    expect(g[0].confidence).toBe("exact");
  });

  it("ignores spacing and case differences in names", () => {
    const g = findDuplicateGroups([
      c("a", { first: "Pat", last: "Smith", phones: ["3015550101"] }),
      c("b", { first: "pat ", last: " SMITH", phones: ["3015550101"] }),
    ]);
    expect(g[0].confidence).toBe("exact");
  });

  it("flags different names on a shared number for review", () => {
    const g = findDuplicateGroups([
      c("a", { first: "Pat", last: "Smith", phones: ["3015550101"] }),
      c("b", { first: "Sam", last: "Smith", phones: ["3015550101"] }),
    ]);
    expect(g[0].confidence).toBe("review");
    expect(g[0].names).toEqual(["Pat Smith", "Sam Smith"]);
  });

  it("never groups on name alone", () => {
    const g = findDuplicateGroups([
      c("a", { first: "John", last: "Smith", phones: ["3015550101"] }),
      c("b", { first: "John", last: "Smith", phones: ["2025550199"] }),
    ]);
    expect(g).toHaveLength(0);
  });

  it("lists exact groups before review groups", () => {
    const g = findDuplicateGroups([
      c("r1", { first: "A", phones: ["3015550101"] }),
      c("r2", { first: "B", phones: ["3015550101"] }),
      c("e1", { first: "C", phones: ["2025550199"] }),
      c("e2", { first: "C", phones: ["2025550199"] }),
    ]);
    expect(g.map((x) => x.confidence)).toEqual(["exact", "review"]);
  });
});

describe("pickSurvivor", () => {
  it("keeps the most complete contact", () => {
    const s = pickSurvivor([
      c("thin", { phones: ["3015550101"], createdAt: "2020-01-01T00:00:00Z" }),
      c("rich", { first: "Pat", last: "Smith", phones: ["3015550101"], emails: ["pat@example.com"], createdAt: "2024-01-01T00:00:00Z" }),
    ]);
    expect(s.id).toBe("rich");
  });
  it("breaks ties with the oldest contact", () => {
    const s = pickSurvivor([
      c("new", { first: "Pat", phones: ["3015550101"], createdAt: "2024-01-01T00:00:00Z" }),
      c("old", { first: "Pat", phones: ["3015550101"], createdAt: "2021-01-01T00:00:00Z" }),
    ]);
    expect(s.id).toBe("old");
  });
});

describe("buildMergePatch", () => {
  const survivor = c("keep", {
    first: "Pat",
    last: "Smith",
    phones: ["+13015550101"],
    emails: ["pat@example.com"],
    custom: [
      { name: "Lead source", key: "lead_source", id: "cf1", type: "string", value: "Website" },
      { name: "Notes", key: "notes", id: "cf2", type: "string", value: null },
    ],
  });
  const copy = c("copy", {
    company: "Smith Events",
    phones: ["(301) 555-0101", "202-555-0199"],
    emails: ["PAT@EXAMPLE.COM", "pat.work@example.com"],
    externalId: "zap-123",
    custom: [
      { name: "Lead source", key: "lead_source", id: "cf1", type: "string", value: "Yelp" },
      { name: "Notes", key: "notes", id: "cf2", type: "string", value: "Prefers text" },
    ],
  });
  const patch = buildMergePatch(survivor, [copy]);

  it("keeps every distinct phone and email, survivor entries first with their ids", () => {
    expect(patch.defaultFields.phoneNumbers).toEqual([
      { name: "mobile", value: "+13015550101", id: "keep-p0" },
      { name: "mobile", value: "202-555-0199" },
    ]);
    expect(patch.defaultFields.emails).toEqual([
      { name: "primary", value: "pat@example.com", id: "keep-e0" },
      { name: "primary", value: "pat.work@example.com" },
    ]);
  });

  it("keeps survivor names and fills blanks from the copy", () => {
    expect(patch.defaultFields.firstName).toBe("Pat");
    expect(patch.defaultFields.lastName).toBe("Smith");
    expect(patch.defaultFields.company).toBe("Smith Events");
  });

  it("carries the copy's external id when the survivor has none", () => {
    expect(patch.externalId).toBe("zap-123");
  });

  it("keeps the survivor's custom values and fills empty ones", () => {
    expect(patch.customFields).toEqual([
      { id: "cf1", key: "lead_source", value: "Website" },
      { id: "cf2", key: "notes", value: "Prefers text" },
    ]);
  });
});

describe("missingAfterMerge", () => {
  it("reports details the survivor lost", () => {
    const group = [c("a", { phones: ["3015550101"], emails: ["a@x.com"] }), c("b", { phones: ["2025550199"] })];
    const after = c("a", { phones: ["3015550101"] });
    expect(missingAfterMerge(after, group)).toEqual({ phones: ["2025550199"], emails: ["a@x.com"] });
  });
  it("is empty when everything landed", () => {
    const group = [c("a", { phones: ["3015550101"] }), c("b", { phones: ["+1 301 555 0101"] })];
    expect(missingAfterMerge(c("a", { phones: ["3015550101"] }), group)).toEqual({ phones: [], emails: [] });
  });
});

describe("formsOneGroup", () => {
  const list = [
    c("a", { first: "Pat", phones: ["3015550101"] }),
    c("b", { first: "Pat", phones: ["3015550101"] }),
    c("x", { first: "Lee", phones: ["2025550199"] }),
  ];
  it("accepts a real duplicate group", () => {
    expect(formsOneGroup(list, ["a", "b"])?.contactIds).toEqual(["a", "b"]);
  });
  it("refuses unrelated contacts", () => {
    expect(formsOneGroup(list, ["a", "x"])).toBeNull();
    expect(formsOneGroup(list, ["a", "b", "x"])).toBeNull();
  });
  it("refuses ids that are not present", () => {
    expect(formsOneGroup(list, ["a", "missing"])).toBeNull();
  });
});

describe("dedupeStats", () => {
  it("counts groups and removable copies", () => {
    const contacts = [
      c("a", { first: "Pat", phones: ["3015550101"] }),
      c("b", { first: "Pat", phones: ["3015550101"] }),
      c("c", { phones: ["3015550101"] }),
      c("r1", { first: "A", phones: ["2025550199"] }),
      c("r2", { first: "B", phones: ["2025550199"] }),
      c("lonely"),
    ];
    const s = dedupeStats(contacts, findDuplicateGroups(contacts));
    expect(s).toEqual({
      totalContacts: 6,
      groups: 2,
      exactGroups: 1,
      reviewGroups: 1,
      duplicateContacts: 3,
      exactDuplicateContacts: 2,
      noPhoneOrEmail: 1,
    });
  });
});
