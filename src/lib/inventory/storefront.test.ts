import { describe, expect, it } from "vitest";
import { normalizeItem, storefrontUrl } from "./storefront";

// A representative storefront payload item (trimmed to the fields we read), used to verify the tolerant
// normalize. No network is touched.
const FIXTURE = {
  id: "abc123",
  title: "  Velvet Tufted Sofa  ",
  description: "<p>Deep seat, brass legs.</p>",
  tags: ["velvet", " ", "sofa"],
  price: { base: 250 },
  quantity: { available: 3 },
  images: [
    { fileName: "front.jpg", viewOrder: 1, primaryImage: false, rawImagePath: "https://cdn/raw/front.jpg", imagePath: "https://cdn/web/front.jpg", thumbImagePath: "https://cdn/thumb/front.jpg" },
    { fileName: "hero.jpg", viewOrder: 0, primaryImage: true, rawImagePath: "https://cdn/raw/hero.jpg", imagePath: "https://cdn/web/hero.jpg", thumbImagePath: "https://cdn/thumb/hero.jpg" },
    { fileName: "nourl.jpg", viewOrder: 2, primaryImage: false }, // no usable URL → dropped
  ],
};

describe("storefrontUrl", () => {
  it("space-separates groups as %20 and encodes the category", () => {
    const url = storefrontUrl({ token: "TOK", category: "furniture-rentals", groups: ["sofa-rentals", "settee-rentals"] });
    expect(url).toBe("https://data.goodshuffle.com/vendor/TOK/inventory?categories=furniture-rentals&groups=sofa-rentals%20settee-rentals&size=200");
  });
  it("omits the groups param when none are given and honors size", () => {
    const url = storefrontUrl({ token: "TOK", category: "furniture-rentals", groups: [], size: 500 });
    expect(url).toBe("https://data.goodshuffle.com/vendor/TOK/inventory?categories=furniture-rentals&size=500");
  });
});

describe("normalizeItem", () => {
  it("trims the title, keeps description HTML, drops blank tags", () => {
    const n = normalizeItem(FIXTURE);
    expect(n.sourceId).toBe("abc123");
    expect(n.title).toBe("Velvet Tufted Sofa");
    expect(n.descriptionHtml).toBe("<p>Deep seat, brass legs.</p>");
    expect(n.tags).toEqual(["velvet", "sofa"]);
  });

  it("sorts images primary-first then by viewOrder, picks rawImagePath, and drops images with no URL", () => {
    const n = normalizeItem(FIXTURE);
    expect(n.images).toHaveLength(2); // the URL-less image is dropped
    expect(n.images[0].primary).toBe(true);
    expect(n.images.map((i) => i.raw)).toEqual(["https://cdn/raw/hero.jpg", "https://cdn/raw/front.jpg"]);
  });

  it("falls back from rawImagePath to imagePath to cropped", () => {
    const n = normalizeItem({ images: [{ imagePath: "https://cdn/web/only.jpg", primaryImage: true, viewOrder: 0 }] });
    expect(n.images[0].raw).toBe("https://cdn/web/only.jpg");
  });

  it("never throws on a malformed item — degrades to empty", () => {
    expect(normalizeItem(null)).toEqual({ sourceId: "", title: "", descriptionHtml: "", tags: [], images: [] });
    expect(normalizeItem({ title: 42, tags: "nope", images: "nope" })).toEqual({ sourceId: "", title: "42", descriptionHtml: "", tags: [], images: [] });
  });
});
