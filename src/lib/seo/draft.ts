// SEO Growth — the deterministic landing-page SCAFFOLDER. PURE (no DB, no I/O, no network), so it is fully
// unit-testable and reusable. "RULES CALCULATE, AI INTERPRETS": this builds the structure, the sourced facts,
// and explicit [NEEDS REVIEW: …] markers wherever a business-specific fact (pricing, inventory, guarantees,
// testimonials) would otherwise have to be invented. It NEVER fabricates those — the markers are what the
// quality checker turns into human-review flags, and what the (optional, dormant) LLM pass would fill in under
// review. The output is a structured proposal a human approves; it is never a live page.

import { ZOE_BRAND } from "./brand";
import { ZOE_PAGES } from "./zoe-pages";
import type {
  PageDraft,
  PageDraftBodyBlock,
  PageDraftInternalLink,
  PageDraftSources,
  SeoAction,
  SeoIntent,
  SeoMetrics,
  SeoMetricsSource,
  ZoePage,
} from "./types";

/** The explicit, machine-detectable marker the scaffolder inserts wherever a human must supply/verify a fact. */
export const REVIEW_MARKER = "[NEEDS REVIEW:";

export interface ScaffoldInput {
  keyword: string;
  intent: SeoIntent;
  location: string | null;
  category: string | null;
  relatedKeywords: string[];
  competitorRefs: string[];
  metrics: SeoMetrics | null;
  metricsSource: SeoMetricsSource;
  researchAt: string | null;
  /** The matcher's recommended action + matched page (drives IMPROVE vs CREATE framing + internal links). */
  action: SeoAction;
  matchedUrl: string | null;
}

/** The content the scaffolder produces — everything a PageDraft needs except persistence/review metadata. */
export interface ScaffoldedDraft {
  slug: string;
  action: SeoAction;
  templatePath: string | null;
  title: string;
  metaDescription: string;
  h1: string;
  canonicalUrl: string;
  outline: string[];
  body: PageDraftBodyBlock[];
  schema: Record<string, unknown>;
  internalLinks: PageDraftInternalLink[];
  sources: PageDraftSources;
}

const SMALL_WORDS = new Set(["a", "an", "and", "the", "or", "for", "to", "of", "in", "on", "near", "with"]);

/** Title-case a keyword for an H1/title, keeping small words lowercase unless first. */
export function titleCase(s: string): string {
  const words = s.trim().replace(/\s+/g, " ").split(" ");
  return words
    .map((w, i) => {
      const lower = w.toLowerCase();
      if (i > 0 && SMALL_WORDS.has(lower)) return lower;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ");
}

/** Normalize a keyword into a safe, lowercase, hyphen-separated URL path (leading slash, no trailing slash). */
export function toSlug(keyword: string): string {
  const body = keyword
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  return "/" + body;
}

/** Pick the structural template: the matched page, else a same-category page, else the home page. */
export function pickTemplate(input: ScaffoldInput, pages: ZoePage[]): ZoePage | null {
  if (input.matchedUrl) {
    const m = pages.find((p) => p.url === input.matchedUrl);
    if (m) return m;
  }
  if (input.category) {
    const cat = pages.find((p) => p.category === input.category && (p.kind === "category" || p.kind === "service"));
    if (cat) return cat;
  }
  return pages.find((p) => p.kind === "home") ?? pages[0] ?? null;
}

/** Up to `max` relevant internal links to REAL Zoe pages (never the draft's own slug). */
export function suggestInternalLinks(input: ScaffoldInput, pages: ZoePage[], ownSlug: string, max = 5): PageDraftInternalLink[] {
  const out: PageDraftInternalLink[] = [];
  const seen = new Set<string>([ownSlug]);
  const push = (p: ZoePage | undefined): void => {
    if (!p || seen.has(p.path)) return;
    seen.add(p.path);
    out.push({ anchor: p.h1 || p.title || p.topic, path: p.path });
  };
  // 1. The matched page (if improving/consolidating an existing one).
  if (input.matchedUrl) push(pages.find((p) => p.url === input.matchedUrl));
  // 2. Same-category pages.
  if (input.category) for (const p of pages.filter((p) => p.category === input.category)) push(p);
  // 3. Home + contact as anchors.
  push(pages.find((p) => p.kind === "home"));
  push(pages.find((p) => p.path === ZOE_BRAND.contactPath));
  return out.slice(0, max);
}

function researchNote(input: ScaffoldInput): string {
  if (input.metricsSource === "ubersuggest" && input.metrics) {
    const bits: string[] = [];
    if (input.metrics.volume != null) bits.push(`volume ≈ ${input.metrics.volume.toLocaleString("en-US")}/mo`);
    if (input.metrics.difficulty != null) bits.push(`difficulty ${input.metrics.difficulty}/100`);
    const when = input.researchAt ? ` (pulled ${input.researchAt.slice(0, 10)})` : "";
    return `Ubersuggest research attached${bits.length ? `: ${bits.join(", ")}` : ""}${when}. Estimates only — not a traffic or revenue promise.`;
  }
  return "No live Ubersuggest research attached — keyword demand/difficulty are UNKNOWN (not zero). Connect the Ubersuggest MCP and re-run discovery to attach research before publishing.";
}

/**
 * Build a structured landing-page draft from an approved opportunity + the site inventory. Deterministic.
 * The copy is a mix of SOURCED facts (brand name, DMV service area, the real rental process) and explicit
 * [NEEDS REVIEW: …] markers wherever a business-specific fact would be required — it invents nothing.
 */
export function scaffoldPageDraft(input: ScaffoldInput, pages: ZoePage[] = ZOE_PAGES): ScaffoldedDraft {
  const kwTitle = titleCase(input.keyword);
  const geo = input.location && input.location.toLowerCase() !== "dmv" ? input.location : null;
  const template = pickTemplate(input, pages);
  const slug = toSlug(input.keyword);
  const canonicalUrl = `${ZOE_BRAND.site}${slug}`;

  const h1 = geo ? `${kwTitle} in ${geo}` : kwTitle;
  // Title ≤ ~60 chars for SERPs: try the branded form, fall back to the bare H1 if too long.
  const branded = `${h1} | ${ZOE_BRAND.shortName}`;
  const title = branded.length <= 60 ? branded : h1.length <= 60 ? h1 : h1.slice(0, 57).trimEnd() + "...";
  const metaDescription =
    `${ZOE_BRAND.name} offers ${input.keyword.toLowerCase()} across ${ZOE_BRAND.serviceAreaShort}. ` +
    `Browse options and request a quote for your event in ${ZOE_BRAND.serviceArea}.`;

  const serviceAreaCopy = geo
    ? `We deliver to ${geo} and the surrounding area as part of our coverage across ${ZOE_BRAND.serviceArea}.`
    : `We serve events across ${ZOE_BRAND.serviceArea}.`;

  const body: PageDraftBodyBlock[] = [
    {
      heading: "Overview",
      level: 2,
      paragraphs: [
        `${h1} from ${ZOE_BRAND.name}. ${serviceAreaCopy}`,
        `${REVIEW_MARKER} add one to two sentences describing this specific offering using approved catalog details. Do not state prices, package contents, or quantities that are not confirmed.]`,
      ],
      sourced: false,
    },
    {
      heading: geo ? `${kwTitle} options in ${geo}` : `${kwTitle} options`,
      level: 2,
      paragraphs: [
        `${REVIEW_MARKER} list the specific ${input.category ?? "rental"} items Zoe actually stocks for this page. Do not invent inventory, sizes, colors, or quantities — pull them from the real catalog.]`,
      ],
      sourced: false,
    },
    {
      heading: "Serving the DMV",
      level: 2,
      paragraphs: [serviceAreaCopy, ZOE_BRAND.tagline],
      sourced: true,
    },
    {
      heading: "How the rental process works",
      level: 2,
      paragraphs: ZOE_BRAND.processSteps.map((s, i) => `${i + 1}. ${s.title}. ${s.body}`),
      sourced: true,
    },
    {
      heading: "Frequently asked questions",
      level: 2,
      paragraphs: [
        `${REVIEW_MARKER} add FAQs relevant to this keyword. Do not state delivery fees, pricing, minimums, or guarantees unless they are confirmed business facts.]`,
      ],
      sourced: false,
    },
    {
      heading: "Request a quote",
      level: 2,
      paragraphs: [
        `Tell us about your event and we will put together a quote. Start on our contact page to begin the rental process with ${ZOE_BRAND.name}.`,
      ],
      sourced: true,
    },
  ];

  const outline = body.map((b) => b.heading);

  // JSON-LD: only KNOWN fields. No price, no aggregateRating (those would be fabricated).
  const schema: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Service",
    name: h1,
    serviceType: input.category ? `${input.category} rental` : "event rental",
    areaServed: geo ? [geo, ...ZOE_BRAND.areaServed] : [...ZOE_BRAND.areaServed],
    provider: {
      "@type": "LocalBusiness",
      name: ZOE_BRAND.name,
      url: ZOE_BRAND.site,
      areaServed: [...ZOE_BRAND.areaServed],
    },
    url: canonicalUrl,
  };

  const internalLinks = suggestInternalLinks(input, pages, slug);

  const sources: PageDraftSources = {
    keyword: input.keyword,
    intent: input.intent,
    location: input.location,
    category: input.category,
    relatedKeywords: input.relatedKeywords,
    competitorRefs: input.competitorRefs,
    metrics: input.metrics,
    metricsSource: input.metricsSource,
    researchAt: input.researchAt,
    templatePath: template?.path ?? null,
    researchNote: researchNote(input),
  };

  return {
    slug,
    action: input.action,
    templatePath: template?.path ?? null,
    title,
    metaDescription,
    h1,
    canonicalUrl,
    outline,
    body,
    schema,
    internalLinks,
    sources,
  };
}

/** Flatten a draft's human-readable text (title + meta + headings + paragraphs) for claim/duplication scans. */
export function draftText(d: Pick<PageDraft | ScaffoldedDraft, "title" | "metaDescription" | "h1" | "body">): string {
  const parts: string[] = [d.title, d.metaDescription, d.h1];
  for (const b of d.body) {
    parts.push(b.heading);
    parts.push(...b.paragraphs);
  }
  return parts.join("\n");
}
