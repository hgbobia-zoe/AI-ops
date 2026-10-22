import { describe, expect, it } from "vitest";
import { extractTokenSync, resolvePartnerToken } from "./resolvePartner";

describe("extractTokenSync — no-network cases", () => {
  it("extracts a token from a data.goodshuffle.com/vendor/<token> URL (source: dataUrl)", () => {
    expect(extractTokenSync("https://data.goodshuffle.com/vendor/fuEHaRKBUIx6FjSFoniRdvWRBi6ESA/inventory?size=200")).toEqual({
      ok: true,
      token: "fuEHaRKBUIx6FjSFoniRdvWRBi6ESA",
      source: "dataUrl",
    });
  });

  it("accepts a bare token (source: token)", () => {
    expect(extractTokenSync("fuEHaRKBUIx6FjSFoniRdvWRBi6ESA")).toEqual({
      ok: true,
      token: "fuEHaRKBUIx6FjSFoniRdvWRBi6ESA",
      source: "token",
    });
  });

  it("returns null for a plain page URL (needs a page fetch)", () => {
    expect(extractTokenSync("https://stagingdesigndc.com")).toBeNull();
    expect(extractTokenSync("zoeeventsdmv.com")).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(extractTokenSync("")).toBeNull();
    expect(extractTokenSync("   ")).toBeNull();
  });
});

describe("resolvePartnerToken — async with the page-fetch fallback", () => {
  it("resolves a data-URL without any fetch", async () => {
    let fetched = false;
    const r = await resolvePartnerToken("data.goodshuffle.com/vendor/ABC123def456GHI789jkl012/inventory", {
      fetchHtml: async () => {
        fetched = true;
        return "";
      },
    });
    expect(r).toEqual({ ok: true, token: "ABC123def456GHI789jkl012", source: "dataUrl" });
    expect(fetched).toBe(false);
  });

  it("resolves a bare token without any fetch", async () => {
    const r = await resolvePartnerToken("y2lcwfwX40RpfPiD6jorw7ipHI6gUK");
    expect(r).toEqual({ ok: true, token: "y2lcwfwX40RpfPiD6jorw7ipHI6gUK", source: "token" });
  });

  it("finds the token in fetched page HTML (WordPress/most hosts) with source: url", async () => {
    const html = `<html><script>var api="https://data.goodshuffle.com/vendor/PAGEtoken1234567890abcd/inventory";</script></html>`;
    const r = await resolvePartnerToken("https://zoeeventsdmv.com", { fetchHtml: async () => html });
    expect(r).toEqual({ ok: true, token: "PAGEtoken1234567890abcd", source: "url" });
  });

  it("prefixes a bare domain with https:// before fetching", async () => {
    let seen = "";
    const html = `data.goodshuffle.com/vendor/XyZ0123456789abcdefghij/inventory`;
    const r = await resolvePartnerToken("example-partner.com", {
      fetchHtml: async (url) => {
        seen = url;
        return html;
      },
    });
    expect(seen).toBe("https://example-partner.com");
    expect(r.ok).toBe(true);
    expect(r.source).toBe("url");
  });

  it("returns a helpful reason when the page has no token (e.g. Wix injects it via JS)", async () => {
    const r = await resolvePartnerToken("https://stagingdesigndc.com", { fetchHtml: async () => "<html>no token here</html>" });
    expect(r.ok).toBe(false);
    expect(r.source).toBe("none");
    expect(r.reason).toMatch(/paste/i);
  });

  it("never throws when the fetch errors — returns a reason instead", async () => {
    const r = await resolvePartnerToken("https://unreachable.example", {
      fetchHtml: async () => {
        throw new Error("network down");
      },
    });
    expect(r.ok).toBe(false);
    expect(r.source).toBe("none");
    expect(r.reason).toBeTruthy();
  });

  it("rejects empty / non-URL junk with a reason (no fetch attempted)", async () => {
    const empty = await resolvePartnerToken("   ");
    expect(empty.ok).toBe(false);
    expect(empty.reason).toBeTruthy();

    let fetched = false;
    const junk = await resolvePartnerToken("not a url", {
      fetchHtml: async () => {
        fetched = true;
        return "";
      },
    });
    expect(junk.ok).toBe(false);
    expect(fetched).toBe(false);
  });
});
