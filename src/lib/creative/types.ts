// Creative Engine — PURE shapes + option sets shared by the server stores and the client surfaces.
// No DB import (client-safe; mirrors the postevent types.ts split). FACTS + rules only.
//
// The module runs a professional creative-production pipeline for Zoe Events. Platform law applies:
// AI CREATES. RULES CONSTRAIN. AI EVALUATES. HUMANS APPROVE. The user defines WHAT to make; the system
// (Visual DNA + Art Director) determines HOW, so every image reads like the same in-house photography
// team. Never fabricate: a mock generation is always labelled a placeholder, never a real Zoe photo.

// ── Asset type ──────────────────────────────────────────────────────────────────────────────────────
export type AssetType =
  | "hero"
  | "product"
  | "lifestyle"
  | "detail"
  | "editorial"
  | "social"
  | "email"
  | "advertising";

export const ASSET_TYPES: AssetType[] = ["hero", "product", "lifestyle", "detail", "editorial", "social", "email", "advertising"];

export const ASSET_TYPE_LABEL: Record<AssetType, string> = {
  hero: "Hero / banner",
  product: "Product",
  lifestyle: "Lifestyle",
  detail: "Detail",
  editorial: "Editorial",
  social: "Social",
  email: "Email",
  advertising: "Advertising",
};

// ── Source mode ─────────────────────────────────────────────────────────────────────────────────────
// How the pixels originate. Upload / pick an existing Zoe image = a real photo anchors the result
// (reference-first: it is the source of truth for PRESERVE). Scratch = generated from the brief alone.
export type SourceMode = "upload" | "existing" | "scratch";
export const SOURCE_MODES: SourceMode[] = ["upload", "existing", "scratch"];
export const SOURCE_MODE_LABEL: Record<SourceMode, string> = {
  upload: "Upload a photo",
  existing: "Use an existing Zoe image",
  scratch: "Generate from scratch",
};
export const SOURCE_MODE_HELP: Record<SourceMode, string> = {
  upload: "Start from a real Zoe photo you provide. It anchors what must be preserved.",
  existing: "Reuse a photo already in the Creative library as the source of truth.",
  scratch: "No source photo. The brief alone directs a fully generated image.",
};
/** A real photo anchors the result → PRESERVE constraints apply. */
export function isReferenceFirst(mode: SourceMode): boolean {
  return mode === "upload" || mode === "existing";
}

// ── Aspect ratio ────────────────────────────────────────────────────────────────────────────────────
export type AspectRatio = "16:9" | "4:3" | "3:2" | "1:1" | "4:5" | "9:16";
export const ASPECT_RATIOS: AspectRatio[] = ["16:9", "4:3", "3:2", "1:1", "4:5", "9:16"];
export const ASPECT_RATIO_LABEL: Record<AspectRatio, string> = {
  "16:9": "16:9 — wide / hero",
  "4:3": "4:3 — classic",
  "3:2": "3:2 — photographic",
  "1:1": "1:1 — square / social",
  "4:5": "4:5 — portrait / feed",
  "9:16": "9:16 — vertical / story",
};
/** Pixel box for a ratio (used to size the placeholder canvas). */
export function aspectDimensions(ratio: AspectRatio): { w: number; h: number } {
  const map: Record<AspectRatio, { w: number; h: number }> = {
    "16:9": { w: 1600, h: 900 },
    "4:3": { w: 1600, h: 1200 },
    "3:2": { w: 1620, h: 1080 },
    "1:1": { w: 1200, h: 1200 },
    "4:5": { w: 1080, h: 1350 },
    "9:16": { w: 900, h: 1600 },
  };
  return map[ratio];
}

// ── Lifecycle status ────────────────────────────────────────────────────────────────────────────────
// The asset's position is ALWAYS visible. draft → queued → generating → qa → (needs_revision loop) →
// awaiting_approval → approved → published. rejected is terminal (human killed it).
export type JobStatus =
  | "draft"
  | "queued"
  | "generating"
  | "qa"
  | "needs_revision"
  | "awaiting_approval"
  | "approved"
  | "rejected"
  | "published";

export const JOB_STATUS_ORDER: JobStatus[] = [
  "draft",
  "queued",
  "generating",
  "qa",
  "needs_revision",
  "awaiting_approval",
  "approved",
  "published",
];

export const JOB_STATUS_LABEL: Record<JobStatus, string> = {
  draft: "Draft",
  queued: "Queued",
  generating: "Generating",
  qa: "Quality control",
  needs_revision: "Needs revision",
  awaiting_approval: "Awaiting approval",
  approved: "Approved",
  rejected: "Rejected",
  published: "Saved asset",
};

// Tailwind token classes for the state pill (dark, restrained — matches the app's pill styling).
export const JOB_STATUS_PILL: Record<JobStatus, string> = {
  draft: "border-white/15 bg-white/5 text-muted-foreground",
  queued: "border-sky-500/30 bg-sky-500/10 text-sky-200",
  generating: "border-sky-500/40 bg-sky-500/10 text-sky-200",
  qa: "border-indigo-500/40 bg-indigo-500/10 text-indigo-200",
  needs_revision: "border-amber-500/40 bg-amber-500/10 text-amber-200",
  awaiting_approval: "border-amber-500/30 bg-amber-500/10 text-amber-200",
  approved: "border-emerald-500/40 bg-emerald-500/10 text-emerald-200",
  rejected: "border-rose-500/40 bg-rose-500/10 text-rose-200",
  published: "border-emerald-500/50 bg-emerald-500/15 text-emerald-100",
};

/** The lifecycle steps shown as a progress rail on the job detail (the position is always visible). */
export const LIFECYCLE_STEPS: { key: string; label: string; statuses: JobStatus[] }[] = [
  { key: "define", label: "Define asset", statuses: ["draft"] },
  { key: "direct", label: "Art direction", statuses: ["queued"] },
  { key: "generate", label: "Generate", statuses: ["generating"] },
  { key: "qc", label: "Quality control", statuses: ["qa", "needs_revision"] },
  { key: "review", label: "Human review", statuses: ["awaiting_approval"] },
  { key: "approve", label: "Approve", statuses: ["approved"] },
  { key: "save", label: "Save asset", statuses: ["published"] },
];

// ── Generation status ───────────────────────────────────────────────────────────────────────────────
export type GenerationStatus = "generating" | "pass" | "fail" | "error" | "approved" | "rejected";
export const GENERATION_STATUS_LABEL: Record<GenerationStatus, string> = {
  generating: "Generating",
  pass: "QC passed",
  fail: "QC failed",
  error: "Error",
  approved: "Approved",
  rejected: "Rejected",
};

// ── Reference-first PRESERVE / TRANSFORM ────────────────────────────────────────────────────────────
// When a real Zoe photo is the source it is the source of truth for PRESERVE items. AI may TRANSFORM the
// listed aspects but must NOT casually invent rental equipment. These are first-class, editable arrays.
export const PRESERVABLE = [
  "Tent structure and framing",
  "Furniture (tables, chairs, lounge)",
  "Flooring / staging",
  "Product appearance and finish",
  "Physical configuration and layout",
  "Proportions and scale",
  "Venue architecture",
  "Inventory count (no added equipment)",
] as const;

export const TRANSFORMABLE = [
  "Lighting and atmosphere",
  "Weather and sky",
  "Landscaping and greenery",
  "Guests and people",
  "Styling and decor accents",
  "Background and surroundings",
  "Color grade and tone",
  "Clutter removal / cleanup",
  "Composition and crop",
  "Perceived production quality",
] as const;

/** Sensible default PRESERVE list for a job, by source mode + asset type. Scratch has nothing physical to
 *  preserve (nothing real anchors it); reference-first preserves the equipment + structure by default. */
export function defaultPreserve(mode: SourceMode, assetType: AssetType): string[] {
  if (!isReferenceFirst(mode)) return [];
  const base = ["Tent structure and framing", "Furniture (tables, chairs, lounge)", "Flooring / staging", "Physical configuration and layout", "Proportions and scale", "Inventory count (no added equipment)"];
  if (assetType === "product" || assetType === "detail") return ["Product appearance and finish", "Proportions and scale", "Inventory count (no added equipment)"];
  return base;
}

/** Sensible default TRANSFORM list for a job, by asset type. */
export function defaultTransform(assetType: AssetType): string[] {
  const common = ["Lighting and atmosphere", "Color grade and tone", "Background and surroundings", "Perceived production quality"];
  if (assetType === "lifestyle" || assetType === "editorial" || assetType === "hero") return [...common, "Weather and sky", "Landscaping and greenery", "Guests and people", "Styling and decor accents", "Composition and crop"];
  if (assetType === "product" || assetType === "detail") return ["Lighting and atmosphere", "Color grade and tone", "Background and surroundings", "Clutter removal / cleanup"];
  return common;
}

// ── Zoe Visual DNA ──────────────────────────────────────────────────────────────────────────────────
// The CENTRALIZED, reusable house look — never buried in individual prompts. Stored in the settings KV;
// this is the code default (the "Initial direction" from the spec). Owner/admin editable.
export interface ZoeVisualDNA {
  photographyStyle: string[];
  lighting: string[];
  colorGrade: string[];
  cameraStyle: string[];
  lensPreferences: string[];
  compositionRules: string[];
  environmentalStyle: string[];
  peopleStyle: string[];
  luxuryLevel: number; // 0..100
  realismLevel: number; // 0..100
  warmthLevel: number; // 0..100
  editorialLevel: number; // 0..100
  corporateLevel: number; // 0..100
  prohibitedCharacteristics: string[];
  brandRules: string[];
}

export const DEFAULT_VISUAL_DNA: ZoeVisualDNA = {
  photographyStyle: [
    "Premium commercial event photography",
    "Luxury editorial sensibility",
    "Realistic full-frame look",
    "Documentary honesty (real events, not staged stock)",
  ],
  lighting: [
    "Natural daylight",
    "Golden hour warmth",
    "Warm architectural lighting",
    "Sophisticated evening ambiance",
    "Practical / in-scene light sources",
  ],
  colorGrade: [
    "Deep, clean blacks",
    "Warm-neutral whites",
    "Restrained gold accents",
    "Natural skin tones",
    "Cinematic but realistic contrast",
  ],
  cameraStyle: ["Full-frame perspective", "Natural depth of field", "Steady, intentional framing"],
  lensPreferences: ["35mm environmental", "50mm natural", "85mm portrait compression", "24mm architectural wide"],
  compositionRules: [
    "Architectural wide establishing shots",
    "Environmental portraits",
    "Guest-perspective framing",
    "Detail and texture studies",
    "Leading lines",
    "Negative space for text",
    "Event-documentary moments",
  ],
  environmentalStyle: [
    "Elevated DMV event venues",
    "Manicured outdoor settings",
    "Refined tented environments",
    "Uncluttered, intentional staging",
  ],
  peopleStyle: [
    "Natural, candid guests",
    "Diverse and authentic",
    "Well-dressed, unforced",
    "Never the primary subject over the rentals",
  ],
  luxuryLevel: 80,
  realismLevel: 90,
  warmthLevel: 70,
  editorialLevel: 65,
  corporateLevel: 45,
  prohibitedCharacteristics: [
    "Neon / obviously-AI color casts",
    "Excessive HDR",
    "Surreal color casts",
    "Fake glow / bloom",
    "Plastic or waxy surfaces",
    "Centered stock-photo framing",
    "Excessive symmetry",
    "Impossible camera positions",
    "Distorted or warped architecture",
    "Invented rental equipment not in the source",
  ],
  brandRules: [
    "Every image should feel like the same Zoe photography team shot it.",
    "The rentals are the hero, not the people.",
    "Realistic first: believable before beautiful.",
    "Never misrepresent inventory Zoe does not own.",
  ],
};

export const DNA_LEVELS: { key: keyof ZoeVisualDNA; label: string }[] = [
  { key: "luxuryLevel", label: "Luxury" },
  { key: "realismLevel", label: "Realism" },
  { key: "warmthLevel", label: "Warmth" },
  { key: "editorialLevel", label: "Editorial" },
  { key: "corporateLevel", label: "Corporate" },
];

export const DNA_LISTS: { key: keyof ZoeVisualDNA; label: string; help: string }[] = [
  { key: "photographyStyle", label: "Photography style", help: "The overall genre and sensibility." },
  { key: "lighting", label: "Lighting", help: "Preferred light qualities and sources." },
  { key: "colorGrade", label: "Color grade", help: "Tonality and color treatment." },
  { key: "cameraStyle", label: "Camera style", help: "Sensor / perspective feel." },
  { key: "lensPreferences", label: "Lens preferences", help: "Focal lengths that read as Zoe." },
  { key: "compositionRules", label: "Composition rules", help: "Framing approaches to prefer." },
  { key: "environmentalStyle", label: "Environmental style", help: "Settings and staging." },
  { key: "peopleStyle", label: "People / guests", help: "How people appear, if at all." },
  { key: "prohibitedCharacteristics", label: "Prohibited characteristics", help: "Never-do list (becomes negative constraints)." },
  { key: "brandRules", label: "Brand rules", help: "Non-negotiable house principles." },
];

// ── Image Brief (the Art Director's structured output) ──────────────────────────────────────────────
// We NEVER send raw user input to the image model. The Art Director deterministically assembles this from
// the job + Visual DNA; an optional LLM pass may refine the concept/prompt when a key is configured.
export interface ImageBrief {
  creativeConcept: string;
  subject: string;
  environment: string;
  camera: string;
  lens: string;
  lighting: string;
  composition: string;
  colorGrade: string;
  peopleDirection: string;
  preserve: string[];
  transform: string[];
  negativeConstraints: string[];
  imagePrompt: string;
  briefSource: "rules" | "ai_refined"; // honesty: how the concept/prompt were produced
  builtAt: string;
}

// ── QA report (deterministic; a real vision model plugs in later) ───────────────────────────────────
export interface QaCheck {
  label: string;
  pass: boolean;
  note: string;
  critical: boolean;
}
export interface QaReport {
  score: number; // 0..100
  verdict: "pass" | "fail";
  method: "rules"; // honesty: rules-based today (no pixels inspected); vision QA is future
  summary: string;
  checks: QaCheck[];
}

// ── CreativeJob (the workflow row) ──────────────────────────────────────────────────────────────────
export interface CreativeJob {
  id: string;
  title: string;
  campaign: string | null;
  page: string | null;
  section: string | null;
  assetType: AssetType;
  product: string | null;
  productCategory: string | null;
  sourceMode: SourceMode;
  sourceImageId: string | null;
  referenceImageIds: string[];
  aspectRatio: AspectRatio;
  targetAudience: string | null;
  objective: string | null;
  season: string | null;
  locationContext: string | null;
  visualDirection: string | null;
  preserve: string[];
  transform: string[];
  status: JobStatus;
  selectedModel: string | null;
  generationCount: number;
  qaScore: number | null;
  imageBrief: ImageBrief | null;
  approvedGenerationId: string | null;
  approvedAssetPath: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreativeJobInput {
  title?: string;
  campaign?: string | null;
  page?: string | null;
  section?: string | null;
  assetType?: AssetType;
  product?: string | null;
  productCategory?: string | null;
  sourceMode?: SourceMode;
  sourceImageId?: string | null;
  referenceImageIds?: string[];
  aspectRatio?: AspectRatio;
  targetAudience?: string | null;
  objective?: string | null;
  season?: string | null;
  locationContext?: string | null;
  visualDirection?: string | null;
  preserve?: string[];
  transform?: string[];
}

// ── Image records (uploaded / existing / generated) ─────────────────────────────────────────────────
export type ImageKind = "upload" | "existing" | "generated";
export interface CreativeImage {
  id: string;
  kind: ImageKind;
  name: string | null;
  path: string; // served URL (e.g. /api/creative/image/<id>)
  mime: string | null;
  width: number | null;
  height: number | null;
  placeholder: boolean; // true = a generated placeholder, NOT a real Zoe photo
  jobId: string | null;
  createdBy: string | null;
  createdAt: string;
}

// ── Generation attempt ──────────────────────────────────────────────────────────────────────────────
export interface Generation {
  id: string;
  jobId: string;
  attempt: number;
  provider: string;
  model: string | null;
  briefSnapshot: ImageBrief | null;
  imageId: string | null;
  resultPath: string | null;
  placeholder: boolean;
  resultMeta: Record<string, unknown> | null;
  qaScore: number | null;
  qaReport: QaReport | null;
  status: GenerationStatus;
  createdAt: string;
}

// ── Attributed lifecycle event (audit) ──────────────────────────────────────────────────────────────
export interface CreativeEvent {
  id: string;
  jobId: string;
  kind: string;
  fromStatus: JobStatus | null;
  toStatus: JobStatus | null;
  actor: string | null;
  note: string | null;
  ts: string;
}

// ── Image-provider status (client-safe view; never carries a key value) ─────────────────────────────
export interface CreativeProviderStatus {
  id: string;
  label: string;
  configured: boolean;
  selected: boolean;
  active: boolean;
  keySet: boolean;
  requiresKey: boolean;
}

// ── Validators ──────────────────────────────────────────────────────────────────────────────────────
export function isAssetType(x: unknown): x is AssetType {
  return typeof x === "string" && (ASSET_TYPES as string[]).includes(x);
}
export function isSourceMode(x: unknown): x is SourceMode {
  return typeof x === "string" && (SOURCE_MODES as string[]).includes(x);
}
export function isAspectRatio(x: unknown): x is AspectRatio {
  return typeof x === "string" && (ASPECT_RATIOS as string[]).includes(x);
}
