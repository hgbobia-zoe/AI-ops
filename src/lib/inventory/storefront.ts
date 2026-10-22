// Goodshuffle storefront data API — the READ source for the Inventory Automation blade.
//
// Unlike pro.goodshuffle.com (behind Cloudflare, datacenter-blocked), the storefront data API at
// data.goodshuffle.com is PUBLIC and reachable server-side with a plain GET — no auth, no session.
// It exposes a vendor's published catalog by category/group. We use it two ways:
//   • pull a PARTNER's catalog (the items we want to sub-rent and copy), and
//   • pull ZOE's own catalog for the target groups (so we can dedupe against what we already carry).
//
// TOLERANT PARSE: a storefront payload is third-party and may drift, so every field is read defensively
// and a single malformed item never throws — it degrades to empty strings / empty arrays. HONEST WHEN
// UNOBSERVABLE: a network error or timeout is returned as { ok:false, error } with an empty item list,
// never a thrown exception and never a faked success.

const BASE = "https://data.goodshuffle.com";
const DEFAULT_SIZE = 200;
const DEFAULT_TIMEOUT_MS = 15_000;
// A browser-ish UA so a WAF/CDN doesn't 403 a bare client (which would read as a false "empty catalog").
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36 ZoeInventoryAutomation/1.0";

/** One normalized image for a copied item. `raw` is the full-resolution URL we'll replay to GSPRO. */
export interface NormalizedImage {
  raw: string; //        full-resolution source URL to copy (rawImagePath, falling back to imagePath / cropped)
  full: string; //       imagePath (web-sized), kept for reference/preview
  thumb: string; //      thumbImagePath, for a light preview grid
  primary: boolean; //   the item's primary/cover image
  viewOrder: number; //  display order (ascending); primary sorts first regardless
  fileName: string; //   original file name, if the storefront gave one
}

/** One of the storefront groups an item belongs to (used for group discovery + mapping selection). */
export interface NormalizedGroup {
  slug: string; //  the group slug (last path segment, e.g. "sofa-rentals") — what the groups filter uses
  name: string; //  display name, e.g. "Sofas"
}

/** A storefront item normalized into the clean shape the planner + importer consume. */
export interface NormalizedItem {
  sourceId: string; //        the partner's item id (provenance only; we never reuse it as Zoe's id)
  title: string; //           item title (trimmed; "" when the storefront omitted it)
  descriptionHtml: string; // description, as the storefront HTML (copied verbatim)
  tags: string[]; //          source tags (case preserved, empties dropped)
  images: NormalizedImage[]; // sorted primary-first, then by viewOrder
  groups: NormalizedGroup[]; //the storefront groups this item is filed under (slug + name)
}

export interface StorefrontResult {
  ok: boolean; //       true only when the fetch returned a usable JSON body
  total: number; //     the storefront's reported total (may exceed items.length when a page cap applies)
  items: NormalizedItem[];
  error: string | null; // honest failure reason when !ok ("HTTP 503", "timeout after 15000ms", "unreachable", "bad json")
}

export interface StorefrontQuery {
  token: string; //        the vendor's public storefront token
  category: string; //     e.g. "furniture-rentals"
  groups: string[]; //     group slugs, e.g. ["sofa-rentals","settee-rentals"]
  size?: number; //        page size (default 200)
  timeoutMs?: number;
}

const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Build the storefront inventory URL. The `groups` filter is space-separated, URL-encoded as %20. */
export function storefrontUrl(q: StorefrontQuery): string {
  const size = q.size && q.size > 0 ? q.size : DEFAULT_SIZE;
  const groups = q.groups.filter(Boolean).map(encodeURIComponent).join("%20");
  const parts = [`categories=${encodeURIComponent(q.category)}`];
  if (groups) parts.push(`groups=${groups}`);
  parts.push(`size=${size}`);
  return `${BASE}/vendor/${encodeURIComponent(q.token)}/inventory?${parts.join("&")}`;
}

/** Normalize one raw storefront image. Never throws. */
function normalizeImage(raw: unknown): NormalizedImage {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const rawPath = str(o.rawImagePath) || str(o.imagePath) || str(o.croppedNoPaddingPath);
  return {
    raw: rawPath,
    full: str(o.imagePath) || rawPath,
    thumb: str(o.thumbImagePath) || str(o.croppedNoPaddingPath) || rawPath,
    primary: o.primaryImage === true,
    viewOrder: num(o.viewOrder),
    fileName: str(o.fileName),
  };
}

/** Derive a group slug from a storefront group object: prefer the last segment of `path`, else slugify the
 *  name. Tolerant — a malformed group degrades to "". */
function groupSlug(o: Record<string, unknown>): string {
  const path = str(o.path).trim();
  if (path) {
    const seg = path.replace(/\/+$/, "").split("/").filter(Boolean).pop();
    if (seg) return seg.toLowerCase();
  }
  return str(o.name).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Normalize one raw storefront item. Never throws; a bad field degrades to empty. */
export function normalizeItem(raw: unknown): NormalizedItem {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const tags = Array.isArray(o.tags)
    ? o.tags.map((t) => str(t).trim()).filter(Boolean)
    : [];
  const images = (Array.isArray(o.images) ? o.images : [])
    .map(normalizeImage)
    .filter((img) => img.raw) //                    drop images with no usable URL
    .sort((a, b) => (a.primary === b.primary ? a.viewOrder - b.viewOrder : a.primary ? -1 : 1));
  const groups = (Array.isArray(o.groups) ? o.groups : [])
    .map((g) => (g && typeof g === "object" ? (g as Record<string, unknown>) : {}))
    .map((g) => ({ slug: groupSlug(g), name: str(g.name).trim() }))
    .filter((g) => g.slug);
  return {
    sourceId: str(o.id),
    title: str(o.title).trim(),
    descriptionHtml: str(o.description),
    tags,
    images,
    groups,
  };
}

/**
 * Fetch + normalize a vendor's storefront inventory for the given category/groups. Server-side, bounded
 * by a timeout, and NEVER throws — every failure is returned as { ok:false, error, items:[] }.
 */
export async function fetchStorefrontInventory(q: StorefrontQuery): Promise<StorefrontResult> {
  const timeoutMs = q.timeoutMs && q.timeoutMs > 0 ? q.timeoutMs : DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(storefrontUrl(q), {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
      headers: { "user-agent": USER_AGENT, accept: "application/json" },
    });
    if (!res.ok) return { ok: false, total: 0, items: [], error: `HTTP ${res.status}` };
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { ok: false, total: 0, items: [], error: "bad json" };
    }
    const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
    const items = (Array.isArray(b.items) ? b.items : []).map(normalizeItem);
    return { ok: true, total: num(b.total) || items.length, items, error: null };
  } catch (e) {
    const aborted = e instanceof Error && (e.name === "AbortError" || /abort/i.test(e.message));
    return { ok: false, total: 0, items: [], error: aborted ? `timeout after ${timeoutMs}ms` : "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}
