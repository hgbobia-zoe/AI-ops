import { describe, expect, it } from "vitest";
import {
  dedupeStats,
  findDuplicateGroups,
  formsOneGroup,
  hubKeys,
  lostOnDelete,
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

describe("lostOnDelete", () => {
  const keep = c("keep", {
    first: "Pat",
    phones: ["+13015550101"],
    emails: ["pat@example.com"],
    custom: [{ name: "Lead source", key: "lead_source", id: "cf1", type: "string", value: "Website" }],
  });
  it("is empty when the copies carry nothing new (format and case differences ignored)", () => {
    const copy = c("copy", { first: "Pat", phones: ["(301) 555-0101"], emails: ["PAT@EXAMPLE.COM"] });
    expect(lostOnDelete(keep, [copy])).toEqual([]);
  });
  it("lists phones, emails, company and custom values only a copy holds", () => {
    const copy = c("copy", {
      company: "Smith Events",
      phones: ["3015550101", "202-555-0199"],
      emails: ["pat.work@example.com"],
      custom: [{ name: "Lead source", key: "lead_source", id: "cf1", type: "string", value: "Yelp" }],
    });
    expect(lostOnDelete(keep, [copy])).toEqual([
      "phone 2025550199",
      "email pat.work@example.com",
      "company Smith Events",
      "Lead source",
    ]);
  });
  it("ignores empty custom values on a copy", () => {
    const copy = c("copy", { phones: ["3015550101"], custom: [{ name: "Notes", key: "notes", id: "cf2", type: "string", value: null }] });
    expect(lostOnDelete(keep, [copy])).toEqual([]);
  });
});

describe("delete-only merges", () => {
  it("marks a group deleteOnly when the kept contact already holds everything (live Yfatwork case)", () => {
    // The kept contact has phone + email; the Zap copies only the phone. Merging = delete the copies.
    const g = findDuplicateGroups([
      c("hub", { first: "Yfatwork", last: "Lulu", phones: ["2029898603"], emails: ["yafe@example.com"] }),
      c("z1", { first: "Yfatwork", last: "Lulu", phones: ["2029898603"] }),
      c("z2", { first: "Yfatwork", last: "Lulu", phones: ["2029898603"] }),
    ]);
    expect(g[0].survivorId).toBe("hub");
    expect(g[0].deleteOnly).toBe(true);
    expect(g[0].keptLacks).toEqual([]);
  });
  it("prefers a member that covers everything over a merely 'more complete' one", () => {
    // "rich" ranks first (older, extra external id) but lacks the second phone that "cover" holds.
    const g = findDuplicateGroups([
      c("rich", { first: "Pat", last: "Smith", externalId: "x1", phones: ["3015550101"], createdAt: "2020-01-01T00:00:00Z" }),
      c("cover", { first: "Pat", last: "Smith", phones: ["3015550101", "2025550199"], createdAt: "2024-01-01T00:00:00Z" }),
    ]);
    expect(g[0].survivorId).toBe("cover");
    expect(g[0].deleteOnly).toBe(true);
  });
  it("flags a group for a hand merge when no member holds everything", () => {
    const g = findDuplicateGroups([
      c("a", { first: "Pat", phones: ["3015550101"], emails: ["a@example.com"] }),
      c("b", { first: "Pat", phones: ["3015550101"], emails: ["b@example.com"] }),
    ]);
    expect(g[0].deleteOnly).toBe(false);
    expect(g[0].keptLacks).toEqual(["email b@example.com"]);
  });
});

describe("hub keys", () => {
  it("never links customers through Zoe's own addresses (live: admin@ chained 166 people)", () => {
    const g = findDuplicateGroups([
      c("a", { first: "Anna", last: "Allshouse", emails: ["admin@zoeeventsdmv.com"] }),
      c("b", { first: "Ashley", last: "Garcia", emails: ["admin@zoeeventsdmv.com"] }),
      c("s", { first: "Bea", emails: ["form-submission@squarespace.info"] }),
      c("t", { first: "Cal", emails: ["form-submission@squarespace.info"] }),
    ]);
    expect(g).toHaveLength(0);
  });
  it("ignores a phone carried by 3+ different names (a shared office or venue line)", () => {
    const contacts = [
      c("a", { first: "Ann", phones: ["3012915296"] }),
      c("b", { first: "Bob", phones: ["3012915296"] }),
      c("c", { first: "Cat", phones: ["3012915296"] }),
    ];
    expect(hubKeys(contacts).has("p:3012915296")).toBe(true);
    expect(findDuplicateGroups(contacts)).toHaveLength(0);
  });
  it("still groups real duplicates that also carry a hub address", () => {
    const g = findDuplicateGroups([
      c("a", { first: "Pat", phones: ["3015550101"], emails: ["hello@zoeeventsdmv.com"] }),
      c("b", { first: "Pat", phones: ["3015550101"], emails: ["hello@zoeeventsdmv.com"] }),
      c("x", { first: "Lee", phones: ["2025550199"], emails: ["hello@zoeeventsdmv.com"] }),
    ]);
    expect(g).toHaveLength(1);
    expect(g[0].contactIds).toEqual(["a", "b"]);
    expect(g[0].sharedEmails).toEqual([]); // the hub address is not reported as a link
  });
  it("keeps a couple sharing a home phone (2 names) as a review group", () => {
    const g = findDuplicateGroups([
      c("a", { first: "Pat", last: "Smith", phones: ["3015550101"] }),
      c("b", { first: "Sam", last: "Smith", phones: ["3015550101"] }),
    ]);
    expect(g[0].confidence).toBe("review");
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
      readyGroups: 1,
      readyCopies: 2,
      handMergeGroups: 0,
      noPhoneOrEmail: 1,
    });
  });
});
