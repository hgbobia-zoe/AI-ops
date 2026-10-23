import { describe, expect, it } from "vitest";
import {
  buildImporterBookmarklet,
  buildBackfillBookmarklet,
  buildCreateBody,
  buildUpdateBody,
  buildTags,
  buildImageEntry,
  buildSearchBody,
  buildBackfillBody,
  pickZoeMatch,
  needsPhotos,
  gsSearchDate,
  findMissingCategories,
  UNPRICED_PRICING_MAP,
  type GroupCategory,
  type BackfillItem,
} from "./bookmarklets";
import type { PlannedItem } from "./importPlan";

// The Cloudflare image derivations (cdn-cgi/image) the verified entries carry, from a presign s3Url.
const S3URL = "https://s3.amazonaws.com/gs/tmp/x.jpg";
const CF_FULL = `https://pro.goodshuffle.com/cdn-cgi/image/width=760,height=428,quality=85,fit=pad,background=white,format=auto/${S3URL}`;
const CF_THUMB = `https://pro.goodshuffle.com/cdn-cgi/image/width=280,height=158,quality=85,fit=pad,background=white,format=auto/${S3URL}`;

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
  const entries = [buildImageEntry("vendors/1/x.jpg", S3URL, "x.jpg", 0, 800, 600)];
  const body = buildUpdateBody(created, item, entries, "Sofa,velvet", "Subrent from Staging Design DC.", UNPRICED_PRICING_MAP);

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
    expect(body.images).toEqual([
      {
        id: null,
        cloudflareUrl: CF_FULL,
        cloudflareThumbUrl: CF_THUMB,
        s3Path: "vendors/1/x.jpg",
        originalS3Path: S3URL,
        caption: "",
        viewOrder: 0,
        fileName: "x.jpg",
        isAnimatedGIF: false,
        rawWidth: 800,
        rawHeight: 600,
      },
    ]);
    expect(body.pricingMap).toBe(UNPRICED_PRICING_MAP);
  });

  it("ALSO sends every photo in temporaryImages[] — the attach trigger (fileName dropped, croppedNoPaddingPath added)", () => {
    expect(body.temporaryImages).toEqual([
      {
        id: null,
        originalS3Path: S3URL,
        s3Path: "vendors/1/x.jpg",
        cloudflareUrl: CF_FULL,
        cloudflareThumbUrl: CF_THUMB,
        croppedNoPaddingPath: S3URL,
        caption: "",
        isAnimatedGIF: false,
        viewOrder: 0,
        rawWidth: 800,
        rawHeight: 600,
      },
    ]);
    // the temporaryImages entry omits fileName (present only on the images[] entry)
    expect("fileName" in (body.temporaryImages as Record<string, unknown>[])[0]).toBe(false);
  });

  it("sends an empty temporaryImages array when there are no photos", () => {
    const empty = buildUpdateBody(created, item, [], "Sofa", "note", UNPRICED_PRICING_MAP);
    expect(empty.images).toEqual([]);
    expect(empty.temporaryImages).toEqual([]);
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

describe("buildImageEntry — the verified images[] + temporaryImages[] pair", () => {
  const pair = buildImageEntry("vendors/1/x.jpg", S3URL, "x.jpg", 2, 1024, 768);

  it("produces the images[] entry with the Cloudflare derivations and originalS3Path", () => {
    expect(pair.image).toEqual({
      id: null,
      cloudflareUrl: CF_FULL,
      cloudflareThumbUrl: CF_THUMB,
      s3Path: "vendors/1/x.jpg",
      originalS3Path: S3URL,
      caption: "",
      viewOrder: 2,
      fileName: "x.jpg",
      isAnimatedGIF: false,
      rawWidth: 1024,
      rawHeight: 768,
    });
  });

  it("produces the temporaryImages[] entry: images entry minus fileName, plus croppedNoPaddingPath", () => {
    expect(pair.temporaryImage).toEqual({
      id: null,
      originalS3Path: S3URL,
      s3Path: "vendors/1/x.jpg",
      cloudflareUrl: CF_FULL,
      cloudflareThumbUrl: CF_THUMB,
      croppedNoPaddingPath: S3URL,
      caption: "",
      isAnimatedGIF: false,
      viewOrder: 2,
      rawWidth: 1024,
      rawHeight: 768,
    });
    expect("fileName" in pair.temporaryImage).toBe(false);
    expect(pair.temporaryImage.croppedNoPaddingPath).toBe(S3URL);
  });

  it("derives originalS3Path == croppedNoPaddingPath == s3Url, and the cloudflare URLs from s3Url", () => {
    expect(pair.image.originalS3Path).toBe(S3URL);
    expect(pair.temporaryImage.croppedNoPaddingPath).toBe(S3URL);
    expect(pair.image.cloudflareUrl).toBe(`https://pro.goodshuffle.com/cdn-cgi/image/width=760,height=428,quality=85,fit=pad,background=white,format=auto/${S3URL}`);
    expect(pair.image.cloudflareThumbUrl).toBe(`https://pro.goodshuffle.com/cdn-cgi/image/width=280,height=158,quality=85,fit=pad,background=white,format=auto/${S3URL}`);
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

  it("is a two-step create (create body → inventoryItem → update body)", () => {
    expect(bm).toContain("buildCreateBody");
    expect(bm).toContain("buildUpdateBody");
    expect(bm).toContain("inventoryItem");
  });

  it("requires x-amz-acl on the S3 image PUT (or S3 403s)", () => {
    expect(bm).toContain("x-amz-acl");
    expect(bm).toContain("public-read");
  });

  it("carries the photo attach trigger: images[] + temporaryImages[] with the Cloudflare derivations", () => {
    expect(bm).toContain("temporaryImages"); //       the array the update body sends
    expect(bm).toContain("temporaryImage"); //        the serialized buildImageEntry pair key
    expect(bm).toContain("croppedNoPaddingPath"); //  only on the temporaryImages entry
    expect(bm).toContain("/cdn-cgi/image/"); //        cloudflareUrl base (concatenated with the size string)
    expect(bm).toContain("width=760,height=428"); //   cloudflareUrl derivation from s3Url
    expect(bm).toContain("width=280,height=158"); //   cloudflareThumbUrl derivation
    expect(bm).toContain("pres.s3Url"); //             the entry builder consumes the presign s3Url
  });

  it("paces requests through the 429 throttle and embeds the resolved category + cfg", () => {
    expect(bm).toContain("RATE_LIMIT_ABORT");
    expect(bm).toContain("retry-after");
    expect(bm).toContain('"primaryCategoryID":657'); // embedded cfg
    expect(bm).not.toContain("rootGroupID"); // create must not send a root group
  });
});

describe("gsSearchDate — Goodshuffle availability date format", () => {
  it('formats a date as "Mon D YYYY"', () => {
    expect(gsSearchDate(new Date(2026, 0, 1))).toBe("Jan 1 2026");
    expect(gsSearchDate(new Date(2026, 11, 25))).toBe("Dec 25 2026");
  });
});

describe("buildSearchBody — the verified searchInventoryItems POST shape (GET 400s)", () => {
  const body = buildSearchBody("Velvet Tufted Sofa", "Jan 1 2026", "Jan 31 2026");

  it("is a QUERY over PRODUCTs with no category/tag/tax filters and the title as searchText", () => {
    expect(body).toEqual({
      countOnly: false,
      searchMode: "QUERY",
      inventoryTypes: ["PRODUCT"],
      categoryIDs: [],
      tags: [],
      taxTypes: [],
      searchText: "Velvet Tufted Sofa",
      availabilityFromDate: "Jan 1 2026",
      availabilityToDate: "Jan 31 2026",
    });
  });
});

describe("pickZoeMatch — exact normalized-title match", () => {
  const results = [
    { id: 1, title: "Barstool" },
    { id: 2, title: "  Velvet   Tufted  Sofa " }, // whitespace / case differences must still match
  ];

  it("matches on normalized title (trim + lowercase + collapse whitespace)", () => {
    expect(pickZoeMatch(results, "velvet tufted sofa")?.id).toBe(2);
  });

  it("returns null when nothing matches, and tolerates a non-array", () => {
    expect(pickZoeMatch(results, "Chaise")).toBeNull();
    expect(pickZoeMatch(undefined, "x")).toBeNull();
  });
});

describe("needsPhotos — the idempotency gate (skip items that already have a photo)", () => {
  it("is true only when a matched item has no thumbImagePath", () => {
    expect(needsPhotos({ id: 1, thumbImagePath: null })).toBe(true);
    expect(needsPhotos({ id: 1 })).toBe(true);
    expect(needsPhotos({ id: 1, thumbImagePath: "" })).toBe(true);
  });

  it("is false when the item already has a photo, or there is no match", () => {
    expect(needsPhotos({ id: 1, thumbImagePath: "vendors/1/thumb.jpg" })).toBe(false);
    expect(needsPhotos(null)).toBe(false);
    expect(needsPhotos(undefined)).toBe(false);
  });
});

describe("buildBackfillBody — rebuild the matched Zoe item + attach photos (both arrays)", () => {
  const zoe = {
    id: 9001,
    uuid: "server-uuid",
    title: "Velvet Tufted Sofa",
    primaryCategoryID: 657,
    primaryCategoryName: "Sofas",
    rootGroupID: 123,
    rootGroupName: "Furniture",
    thumbImagePath: null,
  };
  const bItem: BackfillItem = {
    title: "Velvet Tufted Sofa",
    descriptionHtml: "<p>Deep seat.</p>",
    tags: ["velvet", "Subrental"],
    imageUrls: ["https://cdn/a.jpg"],
    baseTag: "Sofa",
  };
  const entries = [buildImageEntry("vendors/1/x.jpg", S3URL, "x.jpg", 0, 800, 600)];
  const body = buildBackfillBody(zoe, bItem, entries, "Sofa,velvet,Subrental", "Subrent from Staging Design DC.", UNPRICED_PRICING_MAP, TAX);

  it("preserves the server-assigned id/uuid/category/rootGroup from the SEARCH result", () => {
    expect(body.id).toBe(9001);
    expect(body.uuid).toBe("server-uuid");
    expect(body.primaryCategoryID).toBe(657);
    expect(body.primaryCategoryName).toBe("Sofas");
    expect(body.rootGroupID).toBe(123);
    expect(body.rootGroupName).toBe("Furniture");
  });

  it("is untracked + unpriced and OMITS quantityPosted entirely", () => {
    expect(body.quantityTracked).toBe(false);
    expect(body.pricingMap).toBe(UNPRICED_PRICING_MAP);
    expect("quantityPosted" in body).toBe(false);
    expect("quantitySetAside" in body).toBe(false);
  });

  it("sets the website copy, tags, provenance note and the live tax types", () => {
    expect(body.contract_description).toBe("<p>Deep seat.</p>");
    expect(body.web_description).toBe("<p>Deep seat.</p>");
    expect(body.useContractDescriptionForWeb).toBe(false);
    expect(body.tags).toBe("Sofa,velvet,Subrental");
    expect(body.internal_notes).toBe("Subrent from Staging Design DC.");
    expect(body.applied_tax_types).toBe(TAX);
  });

  it("sends the photo in BOTH images[] and temporaryImages[] (the attach trigger)", () => {
    expect((body.images as unknown[]).length).toBe(1);
    expect((body.temporaryImages as unknown[]).length).toBe(1);
    expect((body.images as Record<string, unknown>[])[0].fileName).toBe("x.jpg");
    expect((body.temporaryImages as Record<string, unknown>[])[0].croppedNoPaddingPath).toBe(S3URL);
  });
});

describe("buildBackfillBookmarklet — the photo-repair bookmarklet", () => {
  const backfillItem: BackfillItem = {
    title: "Velvet Tufted Sofa",
    descriptionHtml: "<p>Deep seat.</p>",
    tags: ["velvet", "Subrental"],
    imageUrls: ["https://cdn/a.jpg"],
    baseTag: "Sofa",
  };
  const bm = buildBackfillBookmarklet({ items: [backfillItem], internalNotes: "Subrent from Staging Design DC." });

  it("is a self-contained, syntactically valid javascript: bookmarklet", () => {
    expect(bm.startsWith("javascript:(function(){")).toBe(true);
    expect(bm.endsWith(");void 0")).toBe(true);
    expect(() => new Function(bm.slice("javascript:".length))).not.toThrow();
  });

  it("searches via POST searchInventoryItems and is idempotent (skips items that already have a photo)", () => {
    expect(bm).toContain("/app/inventory/searchInventoryItems");
    expect(bm).toContain("buildSearchBody");
    expect(bm).toContain("pickZoeMatch");
    expect(bm).toContain("needsPhotos");
    expect(bm).toContain("thumbImagePath"); // the idempotency gate, from serialized needsPhotos
  });

  it("attaches photos via saveRegularItem with the images[] + temporaryImages[] trigger + live tax", () => {
    expect(bm).toContain("/app/inventory/saveRegularItem");
    expect(bm).toContain("buildBackfillBody");
    expect(bm).toContain("temporaryImages");
    expect(bm).toContain("croppedNoPaddingPath");
    expect(bm).toContain("/app/taxType/list");
    expect(bm).toContain("x-amz-acl");
  });

  it("paces requests through the 429 throttle and embeds the source items", () => {
    expect(bm).toContain("RATE_LIMIT_ABORT");
    expect(bm).toContain("retry-after");
    expect(bm).toContain('"baseTag":"Sofa"'); // embedded cfg item
  });

  it("never creates items (no two-step create builders)", () => {
    expect(bm).not.toContain("buildCreateBody");
    expect(bm).not.toContain("findMissingCategories");
  });
});
