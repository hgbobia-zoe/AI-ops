// Partner-token resolver for the Inventory Automation "add partner" flow.
//
// The operator pastes "the partner's rental inventory link". That can be any of three things, and we handle
// all of them, degrading gracefully:
//   1) a data.goodshuffle.com/vendor/<token> link  → extract the token directly (source: "dataUrl")
//   2) a bare vendor token                         → use it as-is (source: "token")
//   3) a storefront PAGE url (e.g. the partner's homepage) → fetch the HTML server-side and regex the token
//      out of it (source: "url"). This WORKS for WordPress/most hosts (the vendor token is in the page), but
//      FAILS for Wix (the token is injected by JS and never in the static HTML). On a miss we return a helpful
//      `reason` so the UI can prompt for the data link / token instead.
//
// NEVER THROWS: a network error, timeout, or non-200 all return { ok:false, reason } — never an exception.

export type ResolveSource = "url" | "dataUrl" | "token" | "none";

export interface ResolveResult {
  ok: boolean;
  token?: string;
  source: ResolveSource;
  reason?: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36 ZoeInventoryAutomation/1.0";

// The vendor token as it appears inside a data-API URL anywhere in a string / page.
const TOKEN_IN_URL = /data\.goodshuffle\.com\/vendor\/([A-Za-z0-9]+)/;
// A bare vendor token: a run of alphanumerics, long enough not to catch a stray word (real tokens are ~30).
const BARE_TOKEN = /^[A-Za-z0-9]{20,}$/;

const PASTE_HINT =
  "Couldn't read it from that page. Paste the partner's Goodshuffle data link (data.goodshuffle.com/vendor/...) or token.";

/**
 * Synchronous extraction for the two cases that need no network: a data-API URL (or any string containing
 * one) and a bare token. Returns null when the input needs a page fetch to resolve. PURE.
 */
export function extractTokenSync(input: string): ResolveResult | null {
  const s = (input ?? "").trim();
  if (!s) return null;
  const m = s.match(TOKEN_IN_URL);
  if (m) return { ok: true, token: m[1], source: "dataUrl" };
  if (BARE_TOKEN.test(s)) return { ok: true, token: s, source: "token" };
  return null;
}

/** Default page fetcher: server-side GET, bounded by a timeout, returns the body text or throws. */
async function defaultFetchHtml(url: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      cache: "no-store",
      redirect: "follow",
      signal: controller.signal,
      headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

export interface ResolveDeps {
  fetchHtml?: (url: string, timeoutMs: number) => Promise<string>;
  timeoutMs?: number;
}

/**
 * Resolve a pasted input into a storefront vendor token. Handles data-URL, bare token, and (via a page
 * fetch) a storefront page URL. NEVER throws — every failure comes back as { ok:false, reason }.
 */
export async function resolvePartnerToken(input: string, deps: ResolveDeps = {}): Promise<ResolveResult> {
  try {
    const s = (input ?? "").trim();
    if (!s) return { ok: false, source: "none", reason: "Enter a storefront link or token." };

    const sync = extractTokenSync(s);
    if (sync) return sync;

    // Only attempt a fetch for something that plausibly resolves to a URL.
    const looksLikeUrl = /^https?:\/\//i.test(s) || /^[\w-]+(\.[\w-]+)+/.test(s);
    if (!looksLikeUrl) return { ok: false, source: "none", reason: PASTE_HINT };

    const url = /^https?:\/\//i.test(s) ? s : `https://${s}`;
    const fetchHtml = deps.fetchHtml ?? defaultFetchHtml;
    const html = await fetchHtml(url, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const m = (html ?? "").match(TOKEN_IN_URL);
    if (m) return { ok: true, token: m[1], source: "url" };
    return { ok: false, source: "none", reason: PASTE_HINT };
  } catch {
    return { ok: false, source: "none", reason: PASTE_HINT };
  }
}
