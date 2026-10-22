import { describe, expect, it } from "vitest";
import { buildCaptureBookmarklet, buildImporterBookmarklet, buildSaveItemBody, buildImageEntry, findMissingGroupIds, parseCapture, type GroupIdSet } from "./bookmarklets";
import type { PlannedItem } from "./importPlan";

const ids: GroupIdSet = {
  primaryCategoryID: 42,
  primaryCategoryName: "Furniture",
  rootGroupID: 1001,
  rootGroupName: "Sofas",
  appliedTaxTypes: [{ name: "maryland", rate: 6 }],
  sampleTitle: "Sample Sofa",
};

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

describe("buildSaveItemBody — exact captured shapes", () => {
  const body = buildSaveItemBody(item, ids, "uuid-123", [buildImageEntry("s3/x.jpg", "x.jpg", 0, 800, 600)]);

  it("serializes tags as a COMMA-SEPARATED STRING (not an array)", () => {
    expect(body.tags).toBe("velvet,Subrental,Staging Design");
  });

  it("emits an UNPRICED pricingMap", () => {
    expect(body.pricingMap).toMatchObject({ unpriced: true, rateType: "UNPRICED", numberOfRates: 0, flatFeesByGeo: [], baseRate: null, pricedForPurchase: false });
  });

  it("marks quantity untracked", () => {
    expect(body.quantityTracked).toBe(false);
    expect(body.quantityPosted).toBeNull();
    expect(body.quantitySetAside).toBeNull();
  });

  it("sets website + marketplace visibility", () => {
    expect(body.website_wishlist_visible).toBe(true);
    expect(body.marketplace_visible).toBe(true);
  });

  it("carries the resolved category/group IDs and account tax types", () => {
    expect(body.primaryCategoryID).toBe(42);
    expect(body.primaryCategoryName).toBe("Furniture");
    expect(body.rootGroupID).toBe(1001);
    expect(body.rootGroupName).toBe("Sofas");
    expect(body.applied_tax_types).toEqual([{ name: "maryland", rate: 6 }]);
  });

  it("creates (id:null + uuid) and uses the Staging description as web copy", () => {
    expect(body.id).toBeNull();
    expect(body.uuid).toBe("uuid-123");
    expect(body.inventoryType).toEqual({ name: "PRODUCT" });
    expect(body.contract_description).toBe("<p>Deep seat.</p>");
    expect(body.web_description).toBe("<p>Deep seat.</p>");
    expect(body.useContractDescriptionForWeb).toBe(false);
  });

  it("passes the prepared images[] straight through", () => {
    expect(body.images).toEqual([{ id: null, s3Path: "s3/x.jpg", fileName: "x.jpg", viewOrder: 0, caption: null, isAnimatedGIF: false, rawWidth: 800, rawHeight: 600 }]);
  });

  it("honors trackQuantity:true when set", () => {
    const tracked = buildSaveItemBody({ ...item, trackQuantity: true }, ids, "u", []);
    expect(tracked.quantityTracked).toBe(true);
  });
});

describe("buildImageEntry", () => {
  it("produces the captured images[] entry shape", () => {
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

describe("findMissingGroupIds — fail closed", () => {
  const sofa: PlannedItem = { ...item, zoeGroup: "sofa-rentals" };
  const stool: PlannedItem = { ...item, zoeGroup: "stools-rentals" };

  it("reports a group with no resolved IDs", () => {
    expect(findMissingGroupIds([sofa, stool], { "sofa-rentals": ids })).toEqual(["stools-rentals"]);
  });

  it("is empty when every group resolves", () => {
    const stoolIds: GroupIdSet = { ...ids, rootGroupID: 2002, rootGroupName: "Stools" };
    expect(findMissingGroupIds([sofa, stool], { "sofa-rentals": ids, "stools-rentals": stoolIds })).toEqual([]);
  });

  it("treats a non-numeric id as missing", () => {
    const bad = { ...ids, rootGroupID: "nope" as unknown as number };
    expect(findMissingGroupIds([sofa], { "sofa-rentals": bad })).toEqual(["sofa-rentals"]);
  });
});

describe("parseCapture — read category/group IDs from a real item save", () => {
  const saveBody = (over: Record<string, unknown>) =>
    JSON.stringify({ rootGroupID: 1001, rootGroupName: "Sofas", primaryCategoryID: 42, primaryCategoryName: "Furniture", applied_tax_types: [{ name: "maryland" }], title: "Sample Sofa", ...over });

  it("extracts a GroupIdSet from a captured saveRegularItem request", () => {
    const capture = JSON.stringify([
      { method: "POST", url: "https://pro.goodshuffle.com/app/inventory/saveRegularItem", contentType: "application/json", bodyText: saveBody({}) },
      { method: "GET", url: "https://pro.goodshuffle.com/app/image/getPresignedUploadURL?fileName=x.jpg", bodyText: null }, // ignored
    ]);
    const res = parseCapture(capture);
    expect(res.ok).toBe(true);
    expect(res.sets).toHaveLength(1);
    expect(res.sets![0]).toMatchObject({ rootGroupID: 1001, rootGroupName: "Sofas", primaryCategoryID: 42, primaryCategoryName: "Furniture", sampleTitle: "Sample Sofa" });
    expect(res.sets![0].appliedTaxTypes).toEqual([{ name: "maryland" }]);
  });

  it("dedupes by rootGroupID and keeps distinct groups", () => {
    const capture = JSON.stringify([
      { method: "POST", url: "https://pro.goodshuffle.com/app/inventory/saveRegularItem", bodyText: saveBody({}) },
      { method: "POST", url: "https://pro.goodshuffle.com/app/inventory/saveRegularItem", bodyText: saveBody({ title: "Another Sofa" }) }, // same group → dedup
      { method: "POST", url: "https://pro.goodshuffle.com/app/inventory/saveRegularItem", bodyText: saveBody({ rootGroupID: 2002, rootGroupName: "Stools", primaryCategoryID: 43 }) },
    ]);
    const res = parseCapture(capture);
    expect(res.sets!.map((s) => s.rootGroupID).sort()).toEqual([1001, 2002]);
  });

  it("accepts a { requests: [...] } wrapper and a raw pasted item body", () => {
    expect(parseCapture(JSON.stringify({ requests: [{ url: "/app/inventory/saveRegularItem", method: "POST", bodyText: saveBody({}) }] })).ok).toBe(true);
    expect(parseCapture(saveBody({})).ok).toBe(true); // raw single item object
  });

  it("errors on invalid JSON and on a capture with no item save", () => {
    expect(parseCapture("not json").ok).toBe(false);
    expect(parseCapture(JSON.stringify([{ url: "https://pro.goodshuffle.com/app/route/getRoute", method: "GET" }])).ok).toBe(false);
  });

  it("skips a body missing the required numeric IDs", () => {
    const capture = JSON.stringify([{ method: "POST", url: "/app/inventory/saveRegularItem", bodyText: JSON.stringify({ rootGroupName: "Sofas" }) }]);
    expect(parseCapture(capture).ok).toBe(false);
  });
});

describe("bookmarklet builders", () => {
  it("builds a static capture bookmarklet", () => {
    const bm = buildCaptureBookmarklet();
    expect(bm.startsWith("javascript:")).toBe(true);
    expect(bm).toContain("zoe_gs_capture_v1");
  });

  it("builds an importer that embeds the plan, IDs, known endpoints and serialized builders", () => {
    const bm = buildImporterBookmarklet({ plan: [item], groupIds: { "sofa-rentals": ids }, zoeToken: "TOK" });
    expect(bm.startsWith("javascript:(function(){")).toBe(true);
    expect(bm.endsWith(");void 0")).toBe(true);
    expect(bm).toContain("/app/inventory/saveRegularItem");
    expect(bm).toContain("getPresignedUploadURL");
    expect(bm).toContain("buildSaveItemBody");
    expect(bm).toContain("findMissingGroupIds");
    expect(bm).toContain('"rootGroupID":1001'); // embedded cfg
  });
});
