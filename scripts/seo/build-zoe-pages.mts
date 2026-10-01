/**
 * Build the committed Zoe page-inventory snapshot that the SEO matcher reads at runtime.
 *
 * WHY A SNAPSHOT: the deployed server (Fly) cannot read the website repo (C:\git\zer\website) at runtime,
 * so we parse the repo's committed SEO crawl here, offline, and emit a committed TypeScript snapshot
 * (src/lib/seo/zoe-pages.ts). The matcher imports that — no filesystem access, no network, fully portable.
 *
 * SOURCE: the website repo's `seo-migration-data.md` — a structured crawl of the live zoeeventsdmv.com
 * site (titles, meta, headings, body summaries, and the complete discovered sitemap). FACTS ONLY: we only
 * record pages that actually exist; nothing here is a metric or an estimate.
 *
 * REGEN:  npx tsx scripts/seo/build-zoe-pages.mts [path-to-website-repo]
 *   (defaults: $ZOE_WEBSITE_DIR, then ../website, then C:/git/zer/website)
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AIOPS_ROOT = resolve(__dirname, "..", "..");

// ── canonical Zoe category per live URL slug (aligned with the discovery seed categories) ───────────
const CATEGORY_BY_SLUG: Record<string, string> = {
  arches: "decor",
  backdrop: "decor",
  centerpieces: "decor",
  signage: "decor",
  sofas: "lounge",
  seating: "seating",
  barstool: "seating",
  children: "seating",
  "dining-chairs": "chairs",
  tables: "tables",
  "table-top": "tableware",
  tents: "tents",
  dancefloors: "dance floors",
  textiles: "linens",
  bars: "bars",
  "generator-and-power-equipment-rentals": "power",
  "staging-rentals": "staging",
  "heating-equipment-rentals": "heating & cooling",
  "crowd-control-equipment": "crowd control",
  "pipe-and-drapes-rentals": "pipe and drape",
  "flooring-equipment": "flooring",
  "audio-equipment-rentals": "audio",
  "audio-visual-equipment-rentals": "av",
  "event-extras-rentals": "extras",
};

type Intent = "informational" | "commercial" | "transactional" | "navigational" | "unknown";
type Kind = "home" | "service" | "category" | "blog" | "info" | "other";

interface ZoePage {
  path: string;
  url: string;
  title: string | null;
  h1: string | null;
  headings: string[];
  category: string | null;
  topic: string;
  intent: Intent;
  location: string | null;
  excerpt: string | null;
  kind: Kind;
}

function resolveWebsiteDir(): string {
  const candidates = [process.argv[2], process.env.ZOE_WEBSITE_DIR, resolve(AIOPS_ROOT, "..", "website"), "C:/git/zer/website"].filter(
    (x): x is string => !!x,
  );
  for (const c of candidates) {
    if (existsSync(join(c, "seo-migration-data.md"))) return c;
  }
  throw new Error(
    `Could not find the Zoe website repo (seo-migration-data.md). Tried: ${candidates.join(", ")}.\n` +
      `Pass the repo path: npx tsx scripts/seo/build-zoe-pages.mts <path-to-website>`,
  );
}

const cleanTitle = (t: string): string => t.replace(/\s*--\s*Zoe Event Rentals\s*$/i, "").trim();
const unset = (v: string): boolean => /not set|not explicitly set|empty\/not set|^\(.*\)$/i.test(v.trim());

function pathToTopic(path: string): string {
  if (path === "/") return "home";
  return path.replace(/^\/+/, "").replace(/\/+$/, "").split("/").join(" ").replace(/-/g, " ");
}

function titleCaseSlug(slug: string): string {
  return slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// Intent + kind for the known main/service/info pages; categories default to transactional.
function classify(path: string): { intent: Intent; kind: Kind; category: string | null } {
  if (path === "/") return { intent: "commercial", kind: "home", category: null };
  const slug = path.replace(/^\/+/, "");
  if (slug in CATEGORY_BY_SLUG) return { intent: "transactional", kind: "category", category: CATEGORY_BY_SLUG[slug] };
  if (["weddings", "corporate-events", "social-events"].includes(slug)) {
    const category = slug === "weddings" ? "weddings" : slug === "corporate-events" ? "corporate" : "social";
    return { intent: "commercial", kind: "service", category };
  }
  if (slug === "inventory" || slug === "rental-search" || slug === "our-offerings") return { intent: "transactional", kind: "other", category: null };
  if (slug === "faq") return { intent: "informational", kind: "info", category: null };
  if (slug === "about") return { intent: "navigational", kind: "info", category: null };
  if (slug === "contact") return { intent: "navigational", kind: "info", category: null };
  if (slug === "blog") return { intent: "informational", kind: "blog", category: null };
  if (slug.startsWith("blog/")) return { intent: "informational", kind: "blog", category: slug.includes("tent") ? "tents" : null };
  return { intent: "unknown", kind: "other", category: null };
}

// ── parse the detailed "## PAGE N:" blocks ──────────────────────────────────────────────────────────
function parseDetailedPages(md: string): Map<string, ZoePage> {
  const out = new Map<string, ZoePage>();
  const blocks = md.split(/\n##\s+PAGE\s+\d+:/).slice(1);
  for (const block of blocks) {
    const urlM = block.match(/\*\*URL:\*\*\s*(\S+)/);
    if (!urlM) continue;
    let url = urlM[1].trim();
    const path = url.replace(/^https?:\/\/[^/]+/, "") || "/";
    url = `https://zoeeventsdmv.com${path === "/" ? "" : path}` || "https://zoeeventsdmv.com/";

    const titleM = block.match(/\*\*Title:\*\*\s*(.+)/);
    const title = titleM && !unset(titleM[1]) ? cleanTitle(titleM[1]) : null;

    const metaM = block.match(/\*\*Meta Description:\*\*\s*(.+)/);
    let excerpt = metaM && !unset(metaM[1]) ? metaM[1].trim() : null;

    // Headings: the numbered list under "### Headings".
    const headings: string[] = [];
    let h1: string | null = null;
    const headM = block.match(/###\s+Headings[^\n]*\n([\s\S]*?)(?:\n###|\n\*\*NOTE|\n---|$)/);
    if (headM) {
      for (const line of headM[1].split("\n")) {
        const m = line.match(/^\s*\d+\.\s*(.+?)\s*$/);
        if (!m) continue;
        const raw = m[1];
        const quoted = raw.match(/"([^"]+)"/);
        const label = raw.match(/\b(H[1-6])\b/i);
        const text = (quoted ? quoted[1] : raw.replace(/^H[1-6][^:]*:\s*/i, "")).trim();
        if (!text) continue;
        headings.push(text);
        if (!h1 && label && label[1].toUpperCase() === "H1") h1 = text;
      }
    }

    // Body summary as the excerpt fallback.
    if (!excerpt) {
      const bodyM = block.match(/###\s+Body Content(?:\s+Summary)?\s*\n([\s\S]*?)(?:\n###|\n---|$)/);
      if (bodyM) excerpt = bodyM[1].replace(/\n+/g, " ").trim().slice(0, 300) || null;
    }

    const c = classify(path);
    out.set(path, {
      path,
      url,
      title,
      h1,
      headings,
      category: c.category,
      topic: pathToTopic(path),
      intent: c.intent,
      location: "DMV",
      excerpt,
      kind: c.kind,
    });
  }
  return out;
}

// ── parse the "COMPLETE SITEMAP" URL list for every discovered page ──────────────────────────────────
function parseSitemapPaths(md: string): string[] {
  const start = md.indexOf("## COMPLETE SITEMAP");
  const region = start >= 0 ? md.slice(start) : md;
  const paths = new Set<string>();
  for (const m of region.matchAll(/https?:\/\/zoeeventsdmv\.com(\/[^\s)]*)?/g)) {
    let path = (m[1] ?? "/").trim();
    // Skip thin archive / query pages — not useful matching targets.
    if (path.startsWith("/blog/tag/")) continue;
    if (path.includes("?")) continue;
    path = path.replace(/\/+$/, "") || "/";
    paths.add(path);
  }
  return [...paths];
}

function synthPage(path: string): ZoePage {
  const slug = path.replace(/^\/+/, "");
  const c = classify(path);
  const label = c.category ? titleCaseSlug(c.category) : titleCaseSlug(slug || "home");
  const isCategory = c.kind === "category";
  return {
    path,
    url: `https://zoeeventsdmv.com${path === "/" ? "" : path}`,
    title: isCategory ? `${label} Rentals | Zoe Events & Party Rental` : titleCaseSlug(slug || "Home"),
    h1: null,
    headings: [],
    category: c.category,
    topic: pathToTopic(path),
    intent: c.intent,
    location: "DMV",
    excerpt: isCategory ? `${label} rental inventory from Zoe Events, serving DC, Maryland and Virginia.` : null,
    kind: c.kind,
  };
}

function main(): void {
  const websiteDir = resolveWebsiteDir();
  const md = readFileSync(join(websiteDir, "seo-migration-data.md"), "utf8");

  const detailed = parseDetailedPages(md);
  const allPaths = parseSitemapPaths(md);

  const byPath = new Map<string, ZoePage>(detailed);
  for (const path of allPaths) {
    if (!byPath.has(path)) byPath.set(path, synthPage(path));
  }
  // Make sure the homepage is present even if the sitemap regex missed the bare root.
  if (!byPath.has("/")) byPath.set("/", synthPage("/"));

  const pages = [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));

  const header = `// GENERATED FILE — do not edit by hand.
// Zoe website page inventory snapshot for the SEO matcher. Regenerate with:
//   npx tsx scripts/seo/build-zoe-pages.mts [path-to-website-repo]
// Source: <website-repo>/seo-migration-data.md (live zoeeventsdmv.com crawl). FACTS ONLY — real pages only.
//
// Generated: ${new Date().toISOString()}
// Source file: seo-migration-data.md
// Page count: ${pages.length}

import type { ZoePage } from "./types";

export const ZOE_PAGES_GENERATED_AT = ${JSON.stringify(new Date().toISOString())};
export const ZOE_PAGES_SOURCE = "seo-migration-data.md (zoeeventsdmv.com crawl)";

export const ZOE_PAGES: ZoePage[] = ${JSON.stringify(pages, null, 2)};
`;

  const outPath = join(AIOPS_ROOT, "src", "lib", "seo", "zoe-pages.ts");
  writeFileSync(outPath, header, "utf8");
  console.log(`Wrote ${pages.length} pages → ${outPath}`);
  console.log(`  detailed: ${detailed.size}, synthesized: ${pages.length - detailed.size}`);
  console.log(`  categories: ${[...new Set(pages.map((p) => p.category).filter(Boolean))].sort().join(", ")}`);
}

main();
