// New Creative Job — PURE form logic for the focused creation flow. No React, no DB, client-safe, and
// unit-tested without a database (mirrors jobView.ts). The NewJobForm component is a thin shell over
// these: the step model, the required/optional contract, validation, the default PRESERVE/TRANSFORM
// sync, the contextual summary, and the create payload all live here.
//
// Platform law: this NEVER fabricates. It only shapes the user's real inputs into the CreativeJobInput
// the /api/creative/jobs POST already accepts, and it is explicit that creating a job composes the Image
// Brief only — it does not generate or publish an image.

import {
  isReferenceFirst,
  defaultPreserve,
  defaultTransform,
  type SourceMode,
  type AssetType,
  type AspectRatio,
  type CreativeJobInput,
} from "./types";

// ── The field set the form holds (a single source of truth so entered work survives step changes) ────
export interface NewJobFields {
  title: string;
  assetType: AssetType;
  aspectRatio: AspectRatio;
  page: string;
  section: string;
  product: string;
  productCategory: string;
  targetAudience: string;
  campaign: string;
  season: string;
  locationContext: string;
  objective: string;
  visualDirection: string;
  sourceMode: SourceMode;
  sourceImageId: string | null;
  preserve: string[];
  transform: string[];
}

// Sensible, VISIBLE defaults (real selected values, not placeholders): a from-scratch job of the most
// common asset type at the photographic ratio. The default source mode has nothing physical to preserve.
export const INITIAL_FIELDS: NewJobFields = {
  title: "",
  assetType: "lifestyle",
  aspectRatio: "3:2",
  page: "",
  section: "",
  product: "",
  productCategory: "",
  targetAudience: "",
  campaign: "",
  season: "",
  locationContext: "",
  objective: "",
  visualDirection: "",
  sourceMode: "scratch",
  sourceImageId: null,
  preserve: defaultPreserve("scratch", "lifestyle"),
  transform: defaultTransform("lifestyle"),
};

// ── The step model ────────────────────────────────────────────────────────────────────────────────
// Source FIRST (it decides whether PRESERVE applies at all), then what/where, then the essential brief,
// then the optional creative direction. Steps, not one long undifferentiated form — but every field is
// always mounted in state, so moving between steps (or a failed submit) never drops entered work.
export type StepId = "source" | "asset" | "brief" | "direction";

export interface StepDef {
  id: StepId;
  label: string;
  help: string;
  /** Marks the step as fully optional in the rail (nothing here is required to create the job). */
  optional?: boolean;
}

export const STEPS: StepDef[] = [
  { id: "source", label: "Source", help: "Where the pixels come from" },
  { id: "asset", label: "Asset & use", help: "What you're making and where it lives" },
  { id: "brief", label: "Brief", help: "The essentials the Art Director needs" },
  { id: "direction", label: "Creative direction", help: "Optional — fine-tune the house look", optional: true },
];

export function stepIndex(id: StepId): number {
  return STEPS.findIndex((s) => s.id === id);
}

// ── Validation ───────────────────────────────────────────────────────────────────────────────────
// Only two things are genuinely required: a findable title, and — when a real photo anchors the result
// (upload / existing) — the source image itself. Everything else is optional with a sensible default.
// Each error names the field, the step it lives on (so the UI can jump there), and how to resolve it.
export interface FieldError {
  field: keyof NewJobFields;
  step: StepId;
  message: string;
}

export function validateNewJob(f: NewJobFields): FieldError[] {
  const errors: FieldError[] = [];
  if (!f.title.trim()) {
    errors.push({
      field: "title",
      step: "brief",
      message: "Give the asset a title so it's findable in the library.",
    });
  }
  if (isReferenceFirst(f.sourceMode) && !f.sourceImageId) {
    errors.push({
      field: "sourceImageId",
      step: "source",
      message:
        f.sourceMode === "upload"
          ? "Upload the source photo first — it anchors what must be preserved."
          : "Select an existing Zoe image as the source of truth.",
    });
  }
  return errors;
}

/** The earliest step that has a validation error (so a failed submit lands the user on the right one). */
export function firstErrorStep(errors: FieldError[]): StepId | null {
  if (errors.length === 0) return null;
  return [...errors].sort((a, b) => stepIndex(a.step) - stepIndex(b.step))[0].step;
}

// ── The create payload ───────────────────────────────────────────────────────────────────────────
// Shapes the fields into the exact CreativeJobInput the POST already accepts. The server normalises empty
// strings to null (nullableStr), so blanks are safe. A from-scratch job carries no source image: nothing
// physical anchors it, so sourceImageId is dropped regardless of what a prior reference-first pick held.
export function buildJobPayload(f: NewJobFields): CreativeJobInput {
  const referenceFirst = isReferenceFirst(f.sourceMode);
  return {
    title: f.title,
    assetType: f.assetType,
    page: f.page,
    section: f.section,
    product: f.product,
    productCategory: f.productCategory,
    aspectRatio: f.aspectRatio,
    targetAudience: f.targetAudience,
    campaign: f.campaign,
    season: f.season,
    locationContext: f.locationContext,
    objective: f.objective,
    visualDirection: f.visualDirection,
    sourceMode: f.sourceMode,
    sourceImageId: referenceFirst ? f.sourceImageId : null,
    preserve: f.preserve,
    transform: f.transform,
  };
}

// ── Default PRESERVE/TRANSFORM sync ────────────────────────────────────────────────────────────────
/** The default PRESERVE/TRANSFORM pair for a mode + asset type. Used to keep the two lists in step with
 *  the chosen source/asset UNTIL the user hand-edits them (after which their edits are the truth). */
export function defaultsFor(mode: SourceMode, assetType: AssetType): { preserve: string[]; transform: string[] } {
  return { preserve: defaultPreserve(mode, assetType), transform: defaultTransform(assetType) };
}

// ── Contextual summary ───────────────────────────────────────────────────────────────────────────
// The read-back the summary rail shows. Deterministic over the real fields only — a blank field is
// reported as a blank (dash), never invented. This is display, not persistence.
export interface SummaryLine {
  label: string;
  value: string;
}

const dash = (v: string): string => (v.trim() ? v.trim() : "—");

export function summaryLines(f: NewJobFields): SummaryLine[] {
  return [
    { label: "Product", value: dash(f.product) },
    { label: "Category", value: dash(f.productCategory) },
    { label: "Audience", value: dash(f.targetAudience) },
    { label: "Campaign", value: dash(f.campaign) },
    { label: "Season", value: dash(f.season) },
    { label: "Location", value: dash(f.locationContext) },
    { label: "Objective", value: dash(f.objective) },
  ];
}

/** How many of the optional brief fields the user has actually filled (for an honest "N of M" readout). */
export function filledBriefCount(f: NewJobFields): { filled: number; total: number } {
  const optional = [f.product, f.productCategory, f.targetAudience, f.campaign, f.season, f.locationContext, f.objective];
  return { filled: optional.filter((v) => v.trim().length > 0).length, total: optional.length };
}
