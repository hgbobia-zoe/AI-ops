import { describe, expect, it } from "vitest";
import {
  buildImporterBookmarklet,
  buildCreateBody,
  buildUpdateBody,
  buildTags,
  buildImageEntry,
  findMissingCategories,
  UNPRICED_PRICING_MAP,
  type GroupCategory,
} from "./bookmarklets";
import type { PlannedItem } from "./importPlan";

const cat: GroupCategory = { primaryCategoryID: 657, primaryCategoryName: "Sofas", baseTag: "Sofa" };

const item: PlannedItem = {
  sourceId: "src1",
  title: "Velvet Tufted Sofa",
  descriptionHtml: "<p>Deep seat.</p>",
  tags: ["velvet", "Subrental", "Staging Design"],
  zoeGroup: "sofa-rentals",
  imageUrls: ["https://cdn/a.jpg"],
  unpriced: true,
  trackQuantity: false,
};

const TAX = [{ name: "maryland", autoAppliedToProducts: true, taxRates: [{ rate: 6 }] }];

describe("buildCreateBody — the verified MINIMAL create shape", () => {
  const body = buildCreateBody(item, cat, TAX, UNPRICED_PRICING_MAP);

  it("is untracked and OMITS quantityPosted entirely (sending null 400s)", () => {
    expect(body.quantityTracked).toBe(false);
    expect("quantityPosted" in body).toBe(false);
    expect("quantitySetAside" in body).toBe(false);
  });

  it("sends NO id, NO uuid, NO rootGroup (the server derives the root group from the category)", () => {
    expect("id" in body).toBe(false);
    expect("uuid" in body).toBe(false);
    expect("rootGroupID" in body).toBe(false);
    expect("rootGroupName" in body).toBe(false);
  });

  it("carries the resolved category and the minimal unpriced pricingMap", () => {
    expect(body.primaryCategoryID).toBe(657);
    expect(body.primaryCategoryName).toBe("Sofas");
    expect(body.pricingMap).toEqual({
      flatFeesByGeo: [],
      rateType: "UNPRICED",
      unpriced: true,
      flatFee: null,
      dailyPriceVisibleOnECommerce: true,
      hourlyPriceVisibleOnECommerce: true,
      flatFeePriceVisibleOnECommerce: true,
      purchasePriceVisibleOnECommerce: true,
    });
  });

  it("uses the LIVE-fetched tax types verbatim (never hardcoded)", () => {
    expect(body.applied_tax_types).toBe(TAX);
    expect(body.applied_tax_types).toEqual([{ name: "maryland", autoAppliedToProducts: true, taxRates: [{ rate: 6 }] }]);
  });

  it("is a PRODUCT, website + marketplace visible, with empty images on create", () => {
    expect(body.inventoryType).toEqual({ name: "PRODUCT" });
    expect(body.originalInventoryType).toBe("PRODUCT");
    expect(body.marketplace_visible).toBe(true);
    expect(body.website_wishlist_visible).toBe(true);
    expect(body.useContractDescriptionForWeb).toBe(true);
    expect(body.images).toEqual([]);
    expect(body.attributes).toEqual([]);
  });

  it("tolerates a non-array tax list", () => {
    expect(buildCreateBody(item, cat, undefined as unknown as unknown[], UNPRICED_PRICING_MAP).applied_tax_types).toEqual([]);
  });
});

describe("buildUpdateBody — step two: content merged onto the created item", () => {
  const created = {
    id: 9001,
    uuid: "server-uuid",
    rootGroupID: 123,
    rootGroupName: "Furniture",
    quantityPosted: 5, //       untracked: must be DELETED by the update, not carried through
    quantitySetAside: 2,
    title: "Velvet Tufted Sofa",
  };
  const images = [buildImageEntry("vendors/1/x.jpg", "x.jpg", 0, 800, 600)];
  const body = buildUpdateBody(created, item, images, "Sofa,velvet", "Subrent from Staging Design DC.", UNPRICED_PRICING_MAP);

  it("keeps the server-assigned id/uuid/rootGroup from the created item", () => {
    expect(body.id).toBe(9001);
    expect(body.uuid).toBe("server-uuid");
    expect(body.rootGroupID).toBe(123);
    expect(body.rootGroupName).toBe("Furniture");
  });

  it("DELETES quantityPosted / quantitySetAside for an untracked item", () => {
    expect(body.quantityTracked).toBe(false);
    expect("quantityPosted" in body).toBe(false);
    expect("quantitySetAside" in body).toBe(false);
  });

  it("sets the website copy to the source HTML (not the contract description)", () => {
    expect(body.contract_description).toBe("<p>Deep seat.</p>");
    expect(body.web_description).toBe("<p>Deep seat.</p>");
    expect(body.useContractDescriptionForWeb).toBe(false);
  });

  it("stamps the provenance note, the tags string and the prepared images", () => {
    expect(body.internal_notes).toBe("Subrent from Staging Design DC.");
    expect(body.tags).toBe("Sofa,velvet");
    expect(body.images).toEqual([{ id: null, s3Path: "vendors/1/x.jpg", fileName: "x.jpg", viewOrder: 0, caption: null, isAnimatedGIF: false, rawWidth: 800, rawHeight: 600 }]);
    expect(body.pricingMap).toBe(UNPRICED_PRICING_MAP);
  });

  it("does not mutate the created object passed in", () => {
    expect("quantityPosted" in created).toBe(true); // still there on the original
  });
});

describe("buildTags — CSV string with base tag, normalization and drops", () => {
  it("starts with the base tag and keeps carried tags, as a comma string", () => {
    expect(buildTags(["velvet", "Subrental"], "Sofa")).toBe("Sofa,velvet,Subrental");
  });

  it('normalizes "Bar stool" → "Barstool" and de-dupes case-insensitively', () => {
    expect(buildTags(["Bar stool", "barstool", "GOLD"], "Barstool")).toBe("Barstool,GOLD");
  });

  it("drops the partner's Staging-internal grouping tags", () => {
    expect(buildTags(["group sofas", "Event Rental", "eventrental", "Modern"], "Sofa")).toBe("Sofa,Modern");
  });

  it("is robust to an empty / non-array tag list", () => {
    expect(buildTags([], "Sofa")).toBe("Sofa");
    expect(buildTags(undefined as unknown as string[], "Barstool")).toBe("Barstool");
  });
});

describe("buildImageEntry", () => {
  it("produces the verified images[] entry shape", () => {
    expect(buildImageEntry("vendors/1/x.jpg", "x.jpg", 2, null, null)).toEqual({
      id: null,
      s3Path: "vendors/1/x.jpg",
      fileName: "x.jpg",
      viewOrder: 2,
      caption: null,
      isAnimatedGIF: false,
      rawWidth: null,
      rawHeight: null,
    });
  });
});

describe("findMissingCategories — fail closed", () => {
  const sofa: PlannedItem = { ...item, zoeGroup: "sofa-rentals" };
  const stool: PlannedItem = { ...item, zoeGroup: "stools-rentals" };
  const stoolCat: GroupCategory = { primaryCategoryID: 661, primaryCategoryName: "Stools", baseTag: "Barstool" };

  it("reports a group with no resolved category", () => {
    expect(findMissingCategories([sofa, stool], { "sofa-rentals": cat })).toEqual(["stools-rentals"]);
  });

  it("is empty when every group resolves", () => {
    expect(findMissingCategories([sofa, stool], { "sofa-rentals": cat, "stools-rentals": stoolCat })).toEqual([]);
  });

  it("treats a non-numeric category id as missing", () => {
    const bad = { ...cat, primaryCategoryID: "nope" as unknown as number };
    expect(findMissingCategories([sofa], { "sofa-rentals": bad })).toEqual(["sofa-rentals"]);
  });
});

describe("buildImporterBookmarklet — embeds the verified two-step payloads", () => {
  const bm = buildImporterBookmarklet({
    plan: [item],
    categories: { "sofa-rentals": cat },
    zoeToken: "TOK",
    internalNotes: "Subrent from Staging Design DC.",
  });

  it("is a self-contained javascript: bookmarklet", () => {
    expect(bm.startsWith("javascript:(function(){")).toBe(true);
    expect(bm.endsWith(");void 0")).toBe(true);
  });

  it("is syntactically valid JS (serialized builders + runtime compile)", () => {
    // Strip the "javascript:" scheme and confirm the whole payload parses (catches a bad serialized builder).
    expect(() => new Function(bm.slice("javascript:".length))).not.toThrow();
  });

  it("wires the known endpoints and the LIVE tax fetch (never hardcoded)", () => {
    expect(bm).toContain("/app/inventory/saveRegularItem");
    expect(bm).toContain("getPresignedUploadURL");
    expect(bm).toContain("/app/taxType/list");
    expect(bm).toContain("autoAppliedToProducts");
  });

  it("tags each auto-applied tax object with selected:true + translatedAutoAppliedString (create 400s without selected)", () => {
    expect(bm).toContain("selected: true");
    expect(bm).toContain("translatedAutoAppliedString");
  });

  it("sends the API version headers on every Goodshuffle request (server 400s a body without Accept-version)", () => {
    expect(bm).toContain("Accept-version");
    expect(bm).toContain("v3.2");
    expect(bm).toContain("X-Requested-With");
  });

  it("is a two-step create (create body → inventoryItem → update body)", () => {
    expect(bm).toContain("buildCreateBody");
    expect(bm).toContain("buildUpdateBody");
    expect(bm).toContain("inventoryItem");
  });

  it("requires x-amz-acl on the S3 image PUT (or S3 403s)", () => {
    expect(bm).toContain("x-amz-acl");
    expect(bm).toContain("public-read");
  });

  it("paces requests through the 429 throttle and embeds the resolved category + cfg", () => {
    expect(bm).toContain("RATE_LIMIT_ABORT");
    expect(bm).toContain("retry-after");
    expect(bm).toContain('"primaryCategoryID":657'); // embedded cfg
    expect(bm).not.toContain("rootGroupID"); // create must not send a root group
  });
});
