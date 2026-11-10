import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildOfficePullScript } from "@/lib/gsPull";

// The /pricing "Push delivery fee to Goodshuffle" op (set_delivery_fee) is drained in the browser by two
// copies of the same code: the Auto-Pull extension and the office bookmarklet. Both carry the helpers
// zoeFindDeliveryLines + zoeDeliveryFeeBody. These tests pull the SHIPPED helper text out of each drainer
// and run it, so what is tested is what runs in Goodshuffle.

const extSrc = readFileSync(fileURLToPath(new URL("../../../extension/pull-injected.js", import.meta.url)), "utf8");
const bmSrc = buildOfficePullScript("https://zoe-dispatch.fly.dev");

/** Source of `function <name>(...) {...}` from a script, by brace matching (the helpers hold no braces in strings). */
function extractFn(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  let depth = 0;
  for (let i = src.indexOf("{", start); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`${name} not closed`);
}

type Node = Record<string, unknown>;
type FindFn = (tree: unknown) => Node[];
type BodyFn = (init: unknown, tx: string | number, gid: number, amount: number) => Record<string, unknown> | null;

const DRAINERS = [
  { name: "extension", src: extSrc },
  { name: "bookmarklet", src: bmSrc },
].map((d) => ({
  ...d,
  find: new Function(`${extractFn(d.src, "zoeFindDeliveryLines")}; return zoeFindDeliveryLines;`)() as FindFn,
  body: new Function(`${extractFn(d.src, "zoeDeliveryFeeBody")}; return zoeDeliveryFeeBody;`)() as BodyFn,
}));

// Line shapes as loadContractLineItemGroup returns them (trimmed). Item 392868144 is the base delivery item;
// its current name is "Delivery fee", and lines added before the rename keep the title "Standard Delivery".
const line = (id: number, itemId: number, itemTitle: string, itemName: string, marker: string | null, rateType = "FLAT_FEE_WITH_MILEAGE"): Node => ({
  id, itemTitle, rateType, eventTimeLineMarker: marker ?? undefined, quantityBooked: 1,
  item: { id: itemId, title: itemName, inventoryType: "SERVICE" },
});
const deliveryFeeDrop = line(101, 392868144, "Delivery fee", "Delivery fee", "DROP_OFF");
const deliveryFeePick = line(102, 392868144, "Delivery fee", "Delivery fee", "PICK_UP");
const standardDrop = line(201, 392868144, "Standard Delivery", "Delivery fee", "DROP_OFF");
const standardPick = line(202, 392868144, "Standard Delivery", "Delivery fee", "PICK_UP");
// Lines that are NOT the base delivery fee and must never be repriced.
const premiumWindow = line(301, 785075146, "PIN POINT EXACT TIME", "Premium Window (2-Hour Delivery)", "DROP_OFF");
const exactTime = line(302, 1206113729, "Exact Time (30 mins - Delivery Arrival Window)", "Exact Time (30 mins - Delivery Arrival Window)", null, "FLAT_FEE");
const customerPickup = line(303, 392869314, "Pickup", "Pickup", "PICK_UP", "UNPRICED");
const tent = line(304, 632249293, "10' x 10' High Peak Frame Marquee Tent / Canopy", "10' x 10' High Peak Frame Marquee Tent / Canopy", null, "FLAT_FEE");

const group = (...lineItems: Node[]) => ({ lineItemGroup: { id: 9, logisticsContainer: true, lineItems } });
const ids = (nodes: Node[]) => nodes.map((n) => n.id).sort();

describe("both drainers carry the same delivery fee helpers", () => {
  it("the helper text is identical in the extension and the bookmarklet", () => {
    const norm = (s: string) => s.replace(/\s+/g, " ");
    for (const fn of ["zoeFindDeliveryLines", "zoeDeliveryFeeBody"]) {
      expect(norm(extractFn(extSrc, fn))).toBe(norm(extractFn(bmSrc, fn)));
    }
  });

  it("both drainers save through the editor flow, not the old 500ing body", () => {
    for (const src of [extSrc, bmSrc]) {
      expect(src).toContain("/app/transactionItemRelation/initAddEditLineItemSection?inventoryInjection=false");
      expect(src).toContain("/app/transactionItemRelation/saveInventoryTrackedLineItemEdit");
      expect(src).toMatch(/zoeDeliveryFeeBody\(init,\s*tx,\s*L\.gid,\s*amount\)/);
      expect(src).not.toMatch(/ymd\(n\.rawStartDate\)/);
    }
  });
});

describe.each(DRAINERS)("$name: zoeFindDeliveryLines", ({ find }) => {
  it('finds both legs of a "Delivery fee" line', () => {
    expect(ids(find(group(deliveryFeeDrop, deliveryFeePick, premiumWindow)))).toEqual([101, 102]);
  });

  it('finds both legs of an older "Standard Delivery" line', () => {
    expect(ids(find(group(standardDrop, standardPick, exactTime)))).toEqual([201, 202]);
  });

  it("matches by title on a delivery leg if the item is ever re-created under a new id", () => {
    const recreatedDrop = line(401, 999000111, "Delivery fee", "Delivery fee", "DROP_OFF");
    const recreatedPick = line(402, 999000111, "Standard Delivery", "Standard Delivery", "PICK_UP");
    expect(ids(find(group(recreatedDrop, recreatedPick)))).toEqual([401, 402]);
    // A same-named line that is not on a drop-off or pickup leg is not a delivery leg.
    expect(find(group(line(403, 999000111, "Delivery fee", "Delivery fee", null, "FLAT_FEE")))).toEqual([]);
  });

  it("returns nothing when the project has no delivery line (premium window, pickup, rentals only)", () => {
    expect(find(group(premiumWindow, exactTime, customerPickup, tent))).toEqual([]);
    expect(find({ lineItemGroup: { lineItems: [] } })).toEqual([]);
    expect(find(null)).toEqual([]);
  });

  it("returns each line once even if the response repeats it", () => {
    expect(ids(find([group(deliveryFeeDrop), { again: deliveryFeeDrop }]))).toEqual([101]);
  });
});

// initAddEditLineItemSection response for a delivery leg (trimmed, from the TEST 1 capture; venue is generic).
const TAX = [{ id: 228186759, name: "maryland", rowState: { name: "ACTIVE" }, taxRates: [{ id: 228391088, rate: 0.06, state: "VA" }] }];
const initFor = (over: Record<string, unknown> = {}) => ({
  relation: {
    id: 234703344, relationType: null, eventTimeLineMarker: "PICK_UP", itemTitle: "Standard Delivery", quantity: 1,
    lineItemDescription: "", rateType: "FLAT_FEE_WITH_MILEAGE", internalNotes: "Use the calculator", unitPrice: 0,
    discountDollarAmount: 15, discountPercentage: 0, unitPriceOverridden: false, showItemDescription: true, showItemAttributes: false,
    item: { id: 392868144, inventoryType: "SERVICE" },
    targetLocation: { venueName: "Sample Venue", streetAddressLine1: "1 Main St", streetAddressLine2: null, city: "Rockville", state: "MD", zipCode: "20852", county: "Montgomery County", country: "US", latitude: 39.08, longitude: -77.15 },
  },
  itemStartDate: "Dec 10 2026", itemStartTime: 900, itemEndDate: "Dec 10 2026", itemEndTime: "2000",
  selectedRateType: "FLAT_FEE_WITH_MILEAGE", selectedTaxTypes: TAX,
  ...over,
});

describe.each(DRAINERS)("$name: zoeDeliveryFeeBody", ({ body }) => {
  it("builds the editor's save body, changing only the price", () => {
    const b = body(initFor(), "231791813", 1201706758, 85)!;
    expect(b).toMatchObject({
      inventoryInjection: false, itemID: 392868144, fulfillment: null, transactionID: 231791813, lineItemGroupID: 1201706758,
      relationID: 234703344, inventoryTypeStr: "SERVICE", rateType: "FLAT_FEE_WITH_MILEAGE", title: "Standard Delivery",
      internalNotes: "Use the calculator", showItemDescription: true, showItemAttributes: false, quantity: 1,
      unitPriceOverridden: true, unitPrice: "85", mileageFee: 0, discountDollarAmount: 0, discountPercentage: 0,
      itemStartDate: "Dec 10 2026", itemStartTime: 900, itemEndDate: "Dec 10 2026", itemEndTime: 2000,
      eventTimeLineMarker: "PICK_UP", venueName: "Sample Venue", venueAddress: "1 Main St", venueAddress_line2: null,
      venueAddress_city: "Rockville", venueAddress_zipCode: "20852", venueAddress_latitude: "39.08", venueAddress_longitude: "-77.15",
    });
    // The line keeps its current tax types (the old body sent [] and would have dropped the tax).
    expect(b.selectedTaxTypes).toEqual(TAX);
  });

  it("keeps a midnight time and fills a missing end date from the start", () => {
    const b = body(initFor({ itemStartTime: 0, itemEndDate: null, itemEndTime: null }), 7, 9, 40.5)!;
    expect(b).toMatchObject({ itemStartTime: 0, itemEndDate: "Dec 10 2026", itemEndTime: null, unitPrice: "40.5" });
  });

  it("refuses to build a body without the line or its date, so nothing half-filled is saved", () => {
    expect(body(null, 1, 2, 85)).toBeNull();
    expect(body({ relation: null }, 1, 2, 85)).toBeNull();
    expect(body(initFor({ itemStartDate: null }), 1, 2, 85)).toBeNull();
  });
});
