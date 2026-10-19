// SEO Growth — DETERMINISTIC page-quality checks. PURE (no DB, no I/O, no LLM): given a page draft and the
// site inventory it returns a list of findings (error | warn | info) covering title/meta length, heading
// structure, URL/canonical rules, JSON-LD schema, internal links, UNSUPPORTED FACTUAL CLAIMS, duplication
// against the existing site, and accessibility basics. "RULES CALCULATE": no finding is a model judgment.
//
// These checks are a REVIEWER AID, never an auto-publish gate — `passedStructural` only means "no error-level
// findings"; a human still approves every draft. The factual-claim checks are the honesty backbone: any
// pricing / guarantee / inventory-count / testimonial language, and every [NEEDS REVIEW] marker, is surfaced
// so a person verifies it before the copy is trusted.

import { REVIEW_MARKER, draftText } from "./draft";
import { ZOE_PAGES } from "./zoe-pages";
import type { PageDraft, SeoQualityFinding, SeoQualityReport, ZoePage } from "./types";

// ── factual-claim patterns ──────────────────────────────────────────────────────────────────────────
// Language that asserts a business-specific fact the model must NOT state without a verified source.
const CLAIM_PATTERNS: { id: string; label: string; re: RegExp }[] = [
  { id: "pricing", label: "pricing", re: /(\$\s?\d|\bprices?\b|\bpricing\b|\bper (?:day|hour|person|guest)\b|\bstarting at\b|\bfrom \$|\bfees?\b|\bdeposit\b|\bminimum (?:order|spend)\b)/i },
  { id: "superlative", label: "guarantee / superlative", re: /(\bguarantee\w*\b|\bbest\b|\b#\s?1\b|\bnumber one\b|\blowest price\b|\btop[- ]rated\b|\baward[- ]winning\b|\bvoted\b|\b5[- ]star\b|\bunbeatable\b|\bcheapest\b)/i },
  { id: "inventory", label: "specific inventory count", re: /\b\d{2,}\+?\s+(?:tents?|tables?|chairs?|linens?|items?|pieces?|units?|products?)\b/i },
  { id: "testimonial", label: "testimonial / quote", re: /(\btestimonials?\b|\bclients? say\b|\breviews? say\b|“[^”]{15,}”|"[^"]{15,}")/i },
];

/** Strip [NEEDS REVIEW: …] markers before scanning copy so a review placeholder is not itself read as a claim. */
function stripMarkers(text: string): string {
  // Remove "[NEEDS REVIEW: ... ]" spans (they are counted separately).
  return text.replace(/\[NEEDS REVIEW:[^\]]*\]/gi, " ");
}

// ── token helpers for duplication ─────────────────────────────────────────────────────────────────────
const STOP = new Set(["the", "a", "an", "and", "or", "for", "to", "of", "in", "on", "with", "your", "our", "we", "you", "is", "are", "this", "that", "from", "at", "it", "as", "by", "be"]);

function tokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/\[needs review:[^\]]*\]/gi, " ")
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

function pageBag(p: ZoePage): string {
  return [p.title ?? "", p.h1 ?? "", p.headings.join(" "), p.excerpt ?? "", p.topic].join(" ");
}

const WEAK_ANCHORS = new Set(["click here", "here", "read more", "learn more", "this page", "link"]);

/**
 * Run every deterministic quality check on a draft against the site inventory. Returns all findings plus a
 * summary. Pure + deterministic.
 */
export function runQualityChecks(draft: PageDraft, pages: ZoePage[] = ZOE_PAGES): SeoQualityReport {
  const f: SeoQualityFinding[] = [];
  const add = (id: string, category: string, severity: SeoQualityFinding["severity"], message: string, field?: string): void => {
    f.push({ id, category, severity, message, field });
  };

  // ── Title ──
  const titleLen = draft.title.trim().length;
  if (titleLen === 0) add("title.empty", "Title", "error", "Title is empty.", "title");
  else if (titleLen > 65) add("title.length", "Title", "error", `Title is ${titleLen} chars; keep it under ~60 so it is not truncated in search results.`, "title");
  else if (titleLen < 20) add("title.short", "Title", "warn", `Title is only ${titleLen} chars; consider a fuller, descriptive title (~50-60).`, "title");
  else if (titleLen > 60) add("title.long", "Title", "warn", `Title is ${titleLen} chars; aim for ~60 or fewer.`, "title");

  // ── Meta description ──
  const metaLen = draft.metaDescription.trim().length;
  if (metaLen === 0) add("meta.empty", "Meta", "error", "Meta description is empty.", "metaDescription");
  else if (metaLen < 70) add("meta.short", "Meta", "warn", `Meta description is ${metaLen} chars; aim for 70-160.`, "metaDescription");
  else if (metaLen > 160) add("meta.long", "Meta", "warn", `Meta description is ${metaLen} chars; keep it under 160 to avoid truncation.`, "metaDescription");

  // ── Headings ──
  if (!draft.h1 || draft.h1.trim().length === 0) add("heading.h1", "Headings", "error", "Page has no H1.", "h1");
  if (draft.outline.length < 3) add("heading.outline", "Headings", "warn", `Only ${draft.outline.length} section(s); a landing page usually needs at least 3 well-structured sections.`, "outline");
  if (draft.body.some((b) => !b.heading.trim())) add("heading.empty", "Headings", "error", "A body section has an empty heading.", "body");
  // No skipped levels: an H3 must follow an H2 (the body never starts at H3).
  if (draft.body.length > 0 && draft.body[0].level !== 2) add("heading.firstlevel", "Headings", "warn", "First section is not an H2; start the body at H2 beneath the H1.", "body");

  // ── URL / slug ──
  const slug = draft.slug;
  if (!slug.startsWith("/")) add("url.leadingslash", "URL", "error", "Slug must start with '/'.", "slug");
  if (/[A-Z]/.test(slug)) add("url.case", "URL", "error", "Slug contains uppercase letters; use lowercase.", "slug");
  if (/[^a-z0-9/-]/.test(slug)) add("url.chars", "URL", "error", "Slug contains characters other than lowercase letters, numbers and hyphens.", "slug");
  if (/--/.test(slug)) add("url.doubledash", "URL", "warn", "Slug has a double hyphen.", "slug");
  if (slug.length > 1 && slug.endsWith("/")) add("url.trailingslash", "URL", "warn", "Slug has a trailing slash.", "slug");

  // ── Canonical ──
  if (!draft.canonicalUrl || !/^https:\/\//.test(draft.canonicalUrl)) add("canonical.missing", "Schema", "error", "Canonical URL is missing or not an absolute https URL.", "canonicalUrl");

  // ── JSON-LD schema ──
  const s = draft.schema;
  if (!s) add("schema.missing", "Schema", "warn", "No JSON-LD structured data attached.", "schema");
  else {
    if (!s["@context"] || !s["@type"]) add("schema.shape", "Schema", "error", "JSON-LD is missing @context or @type.", "schema");
    if (s["@type"] === "Service" && !s["name"]) add("schema.name", "Schema", "warn", "Service schema has no name.", "schema");
    if (s["@type"] === "Service" && !s["provider"]) add("schema.provider", "Schema", "warn", "Service schema has no provider.", "schema");
    if ("aggregateRating" in s || "review" in s || "offers" in s || "price" in s) {
      add("schema.unverified", "Schema", "error", "Schema contains ratings/reviews/price — do not publish fabricated structured data; only include verified values.", "schema");
    }
  }

  // ── Internal links ──
  const pagesByPath = new Map(pages.map((p) => [p.path, p]));
  if (draft.internalLinks.length < 2) add("links.few", "Internal links", "warn", `Only ${draft.internalLinks.length} internal link(s); add links to related Zoe pages.`, "internalLinks");
  for (const l of draft.internalLinks) {
    if (!l.path.startsWith("/")) add("links.external", "Internal links", "warn", `Internal link "${l.anchor}" is not a site-relative path.`, l.path);
    else if (!pagesByPath.has(l.path) && l.path !== draft.slug) add("links.missing", "Internal links", "warn", `Internal link target ${l.path} is not in the known site inventory.`, l.path);
    if (WEAK_ANCHORS.has(l.anchor.trim().toLowerCase())) add("links.anchor", "Accessibility", "warn", `Link anchor "${l.anchor}" is not descriptive; use meaningful link text.`, l.path);
    if (!l.anchor.trim()) add("links.emptyanchor", "Accessibility", "error", `Internal link to ${l.path} has empty anchor text.`, l.path);
  }

  // ── Factual claims (the honesty backbone) ──
  let unsupportedClaims = 0;
  // 1. Every [NEEDS REVIEW] marker = a deliberate "human must supply/verify this" placeholder.
  const text = draftText(draft);
  const markerCount = (text.match(/\[NEEDS REVIEW:/gi) ?? []).length;
  if (markerCount > 0) {
    unsupportedClaims += markerCount;
    add("claims.markers", "Factual claims", "info", `${markerCount} section(s) need a human to supply or verify business details before publishing (marked "${REVIEW_MARKER} …]").`, "body");
  }
  // 2. Any claim LANGUAGE that slipped into non-marker copy (chiefly guards an LLM enrichment pass).
  const scan = stripMarkers(text);
  for (const c of CLAIM_PATTERNS) {
    if (c.re.test(scan)) {
      unsupportedClaims += 1;
      add(`claims.${c.id}`, "Factual claims", "error", `Copy contains ${c.label} language; this is a business-specific claim that must be verified by a human (never invent pricing, inventory, guarantees, or testimonials).`, "body");
    }
  }
  // 3. Flag any body block that is marked sourced but still carries a marker (internal consistency).
  for (const b of draft.body) {
    if (b.sourced && b.paragraphs.some((p) => p.includes(REVIEW_MARKER))) {
      add("claims.mislabeled", "Factual claims", "warn", `Section "${b.heading}" is marked sourced but contains a review marker.`, b.heading);
    }
  }

  // ── Duplication against the existing site (avoid thin/near-duplicate pages) ──
  const bag = tokens(text);
  let worst: { path: string; sim: number } | null = null;
  for (const p of pages) {
    if (p.path === draft.slug) continue; // the IMPROVE target itself is expected to overlap
    const sim = jaccard(bag, tokens(pageBag(p)));
    if (!worst || sim > worst.sim) worst = { path: p.path, sim };
  }
  if (worst && worst.sim >= 0.8) add("dupe.near", "Duplication", "warn", `Draft is very similar (${Math.round(worst.sim * 100)}%) to existing page ${worst.path}; make sure this is not a thin near-duplicate.`, worst.path);
  // A CREATE whose slug already exists would duplicate a live page — it should be an IMPROVE instead.
  if (draft.action === "CREATE" && pagesByPath.has(draft.slug)) {
    add("dupe.slug", "Duplication", "error", `A page already exists at ${draft.slug}; this should improve the existing page, not create a duplicate.`, "slug");
  }

  // ── Accessibility basics ──
  if (metaLen === 0) add("a11y.meta", "Accessibility", "warn", "Missing meta description also hurts link previews/accessibility.", "metaDescription");
  // (Image alt-text is enforced when an image block type is added; no image blocks exist in the scaffold yet.)

  const errors = f.filter((x) => x.severity === "error").length;
  const warnings = f.filter((x) => x.severity === "warn").length;
  return { findings: f, errors, warnings, passedStructural: errors === 0, unsupportedClaims };
}
