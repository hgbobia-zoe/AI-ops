import { describe, expect, it } from "vitest";
import {
  coerceInventoryPartners,
  coerceZoeCategories,
  getInventoryPartner,
  slugify,
  zoeCategoryIndex,
  DEFAULT_INVENTORY_PARTNERS,
  DEFAULT_ZOE_CATEGORIES,
  type InventoryPartner,
} from "./partners";

describe("slugify", () => {
  it("lowercases, replaces non-alnum runs with a single dash, trims dashes", () => {
    expect(slugify("Staging Design DC")).toBe("staging-design-dc");
    expect(slugify("  Sofas & Settees!  ")).toBe("sofas-settees");
  });
});

describe("coerceZoeCategories", () => {
  it("keeps valid {name, id}, drops no-name / non-finite-id rows, de-dupes by lowercased name", () => {
    const out = coerceZoeCategories(
      [
        { name: "Sofas", primaryCategoryID: 657 },
        { name: "Stools", primaryCategoryID: "661" }, // numeric string coerces
        { name: "", primaryCategoryID: 5 }, // no name → dropped
        { name: "Chairs", primaryCategoryID: "x" }, // non-finite → dropped
        { name: "sofas", primaryCategoryID: 999 }, // dup name → dropped
      ],
      [],
    );
    expect(out).toEqual([
      { name: "Sofas", primaryCategoryID: 657 },
      { name: "Stools", primaryCategoryID: 661 },
    ]);
  });

  it("returns the fallback only when the input is not an array", () => {
    expect(coerceZoeCategories(null, DEFAULT_ZOE_CATEGORIES)).toBe(DEFAULT_ZOE_CATEGORIES);
    expect(coerceZoeCategories("nope", DEFAULT_ZOE_CATEGORIES)).toBe(DEFAULT_ZOE_CATEGORIES);
    expect(coerceZoeCategories([], DEFAULT_ZOE_CATEGORIES)).toEqual([]); // explicit empty array is respected
  });
});

describe("coerceInventoryPartners", () => {
  it("derives a missing id/key/label, drops partners with no valid mapping, de-dupes by id", () => {
    const out = coerceInventoryPartners(
      [
        {
          name: "Staging Design DC",
          vendorToken: "TOK",
          internalNote: "Subrent.",
          storefrontUrl: "https://stagingdesigndc.com",
          mappings: [{ sourceGroups: ["sofa-rentals"], targetCategory: "Sofas", baseTag: "Sofa" }],
        },
        { name: "No Mappings", mappings: [] }, // no valid mapping → dropped
        { name: "", mappings: [{ sourceGroups: ["x"], targetCategory: "Y", baseTag: "Z" }] }, // no name → dropped
        {
          id: "staging-design-dc", // dup of the first partner's derived id → dropped
          name: "Dupe",
          mappings: [{ sourceGroups: ["a"], targetCategory: "B", baseTag: "C" }],
        },
      ],
      [],
    );
    expect(out).toHaveLength(1);
    const p = out[0];
    expect(p.id).toBe("staging-design-dc"); // derived by slugifying the name
    expect(p.vendorToken).toBe("TOK");
    expect(p.mappings[0].label).toBe("sofa-rentals"); // derived from the first source group when no label given
    expect(p.mappings[0].key).toBe("sofa-rentals"); // derived by slugifying the label
    expect(p.mappings[0].sourceGroups).toEqual(["sofa-rentals"]);
    expect(p.mappings[0].targetCategory).toBe("Sofas");
  });

  it("drops a mapping with no source groups but keeps a partner that still has a valid one", () => {
    const out = coerceInventoryPartners(
      [
        {
          name: "P",
          mappings: [
            { sourceGroups: [], targetCategory: "Sofas", baseTag: "Sofa" }, // dropped
            { sourceGroups: ["stools-rentals"], targetCategory: "Stools", baseTag: "Barstool" },
          ],
        },
      ],
      [],
    );
    expect(out).toHaveLength(1);
    expect(out[0].mappings).toHaveLength(1);
    expect(out[0].mappings[0].targetCategory).toBe("Stools");
  });

  it("returns the fallback only when the input is not an array", () => {
    expect(coerceInventoryPartners(undefined, DEFAULT_INVENTORY_PARTNERS)).toBe(DEFAULT_INVENTORY_PARTNERS);
  });

  it("round-trips the seed Staging Design preset unchanged", () => {
    const out = coerceInventoryPartners(DEFAULT_INVENTORY_PARTNERS, []);
    expect(out).toEqual(DEFAULT_INVENTORY_PARTNERS);
  });
});

describe("zoeCategoryIndex — the registry lookup the importer resolves against (fail closed)", () => {
  const index = zoeCategoryIndex(DEFAULT_ZOE_CATEGORIES);

  it("resolves a seeded category id, case-insensitively", () => {
    expect(index.get("sofas")).toBe(657);
    expect(index.get("stools")).toBe(661);
  });

  it("returns undefined for a category NOT in the registry — so the importer fails closed", () => {
    expect(index.get("chandeliers")).toBeUndefined();
  });
});

describe("getInventoryPartner", () => {
  const partners: InventoryPartner[] = DEFAULT_INVENTORY_PARTNERS;
  it("finds by id, or null", () => {
    expect(getInventoryPartner(partners, "staging-design")?.name).toBe("Staging Design DC");
    expect(getInventoryPartner(partners, "nope")).toBeNull();
  });
});
