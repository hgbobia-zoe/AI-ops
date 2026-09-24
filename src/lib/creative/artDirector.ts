// Art Director — the layer that stands between the human and the image model. We NEVER send raw user
// input to a generator. Given the job + the centralized Zoe Visual DNA (+ any source/reference metadata),
// it DETERMINISTICALLY assembles a structured Image Brief so every image reads like the same house team.
//
// RULES CALCULATE, AI INTERPRETS: the brief is fully composed by rules alone (works with no LLM key). If
// an LLM is configured it may REFINE only the human-readable creativeConcept + imagePrompt — never the
// constraints, preserve/transform, or negatives. It degrades gracefully: any failure keeps the rules brief.

import { chat, llmConfigured } from "@/lib/llm";
import { getVisualDNA, dnaVersion } from "./visualDna";
import {
  type CreativeJob,
  type ImageBrief,
  type ZoeVisualDNA,
  ASSET_TYPE_LABEL,
  isReferenceFirst,
} from "./types";

const first = (arr: string[], fb: string): string => (arr.length ? arr[0] : fb);
const join = (arr: string[], max: number): string => arr.slice(0, max).join(", ");

/** Pick the lens best matching the asset type from the DNA's lens set (deterministic). */
function pickLens(dna: ZoeVisualDNA, job: CreativeJob): string {
  const prefs = dna.lensPreferences;
  const find = (needle: string): string | undefined => prefs.find((l) => l.toLowerCase().includes(needle));
  switch (job.assetType) {
    case "hero":
    case "advertising":
      return find("24") ?? find("35") ?? first(prefs, "35mm environmental");
    case "product":
    case "detail":
      return find("85") ?? find("50") ?? first(prefs, "85mm portrait compression");
    case "lifestyle":
    case "editorial":
    case "social":
      return find("35") ?? find("50") ?? first(prefs, "35mm environmental");
    default:
      return find("50") ?? first(prefs, "50mm natural");
  }
}

/** Choose a composition rule appropriate to the asset type (deterministic, from the DNA rule set). */
function pickComposition(dna: ZoeVisualDNA, job: CreativeJob): string {
  const rules = dna.compositionRules;
  const find = (needle: string): string | undefined => rules.find((r) => r.toLowerCase().includes(needle));
  switch (job.assetType) {
    case "hero":
    case "advertising":
      return find("architectural") ?? find("negative space") ?? first(rules, "Architectural wide establishing shot");
    case "product":
    case "detail":
      return find("detail") ?? find("texture") ?? first(rules, "Detail and texture study");
    case "lifestyle":
    case "editorial":
      return find("environmental") ?? find("documentary") ?? first(rules, "Environmental portrait");
    case "social":
      return find("guest") ?? find("documentary") ?? first(rules, "Guest-perspective framing");
    default:
      return first(rules, "Environmental portrait");
  }
}

/** People direction from the DNA + asset type. Product/detail = no people unless the job says otherwise. */
function peopleDirection(dna: ZoeVisualDNA, job: CreativeJob): string {
  if (job.assetType === "product" || job.assetType === "detail") {
    return "No people. The rental product is the sole subject.";
  }
  const style = join(dna.peopleStyle, 3);
  return style ? `${style}. Guests support the scene; the rentals remain the hero.` : "Guests support the scene; the rentals remain the hero.";
}

/** Build the subject line from the concrete job facts (never invented). */
function buildSubject(job: CreativeJob): string {
  const bits: string[] = [];
  if (job.product) bits.push(job.product);
  if (job.productCategory && job.productCategory !== job.product) bits.push(`(${job.productCategory})`);
  if (bits.length === 0) bits.push("Zoe event rental setup");
  const setting = job.locationContext ? ` at ${job.locationContext}` : "";
  const season = job.season ? `, ${job.season}` : "";
  return `${bits.join(" ")}${setting}${season}`.trim();
}

function buildEnvironment(dna: ZoeVisualDNA, job: CreativeJob): string {
  const env = job.locationContext || first(dna.environmentalStyle, "an elevated DMV event venue");
  const style = join(dna.environmentalStyle, 2);
  return job.locationContext ? `${env}. ${style}.` : `${style}.`;
}

/** The negative constraints = the DNA prohibited list, plus a reference-first "no invented equipment"
 *  clause whenever a real photo anchors the job. This is what keeps the model honest. */
function buildNegatives(dna: ZoeVisualDNA, job: CreativeJob): string[] {
  const negs = [...dna.prohibitedCharacteristics];
  if (isReferenceFirst(job.sourceMode)) {
    negs.push("Do not add, remove, or alter any rental equipment present in the source photo.");
    negs.push("Do not change the physical configuration, counts, or proportions of the setup.");
  }
  return negs;
}

/** Compose the full imagePrompt string the provider receives (deterministic assembly). */
function composePrompt(brief: Omit<ImageBrief, "imagePrompt" | "briefSource" | "builtAt">, dna: ZoeVisualDNA): string {
  const lines: string[] = [];
  lines.push(brief.creativeConcept);
  lines.push(`Subject: ${brief.subject}.`);
  lines.push(`Environment: ${brief.environment}`);
  lines.push(`Camera: ${brief.camera}. Lens: ${brief.lens}.`);
  lines.push(`Lighting: ${brief.lighting}.`);
  lines.push(`Composition: ${brief.composition}.`);
  lines.push(`Color grade: ${brief.colorGrade}.`);
  lines.push(`People: ${brief.peopleDirection}`);
  if (brief.preserve.length) lines.push(`Preserve exactly from the source: ${brief.preserve.join("; ")}.`);
  if (brief.transform.length) lines.push(`May transform: ${brief.transform.join("; ")}.`);
  lines.push(`Avoid: ${brief.negativeConstraints.join("; ")}.`);
  if (dna.brandRules.length) lines.push(`Brand law: ${dna.brandRules.join(" ")}`);
  return lines.join("\n");
}

/** Deterministic creative concept sentence — the human-readable "why this image". */
function buildConcept(job: CreativeJob, dna: ZoeVisualDNA): string {
  const genre = first(dna.photographyStyle, "Premium commercial event photography");
  const type = ASSET_TYPE_LABEL[job.assetType].toLowerCase();
  const aud = job.targetAudience ? ` for ${job.targetAudience}` : "";
  const obj = job.objective ? ` The image should ${job.objective.replace(/\.$/, "")}.` : "";
  const dir = job.visualDirection ? ` Creative note: ${job.visualDirection}.` : "";
  return `${genre} for a ${type} asset${aud}.${obj}${dir}`.trim();
}

/** Assemble the Image Brief with RULES only (always works, no key needed). */
export function buildBriefDeterministic(job: CreativeJob, dna: ZoeVisualDNA = getVisualDNA()): ImageBrief {
  const partial: Omit<ImageBrief, "imagePrompt" | "briefSource" | "builtAt"> = {
    creativeConcept: buildConcept(job, dna),
    subject: buildSubject(job),
    environment: buildEnvironment(dna, job),
    camera: join(dna.cameraStyle, 2) || "Full-frame perspective, natural depth of field",
    lens: pickLens(dna, job),
    lighting: join(dna.lighting, 2) || "Natural daylight, golden hour warmth",
    composition: pickComposition(dna, job),
    colorGrade: join(dna.colorGrade, 3) || "Deep blacks, warm-neutral whites, natural skin tones",
    peopleDirection: peopleDirection(dna, job),
    preserve: [...job.preserve],
    transform: [...job.transform],
    negativeConstraints: buildNegatives(dna, job),
  };
  return {
    ...partial,
    imagePrompt: composePrompt(partial, dna),
    briefSource: "rules",
    dnaVersion: dnaVersion(dna),
    builtAt: new Date().toISOString(),
  };
}

/** Optionally refine ONLY the concept + prompt with an LLM (constraints/negatives stay rule-fixed). Falls
 *  back to the deterministic brief on any error or when no key is set. */
export async function buildBrief(job: CreativeJob, dna: ZoeVisualDNA = getVisualDNA()): Promise<ImageBrief> {
  const base = buildBriefDeterministic(job, dna);
  if (!llmConfigured()) return base;
  try {
    const sys =
      "You are the art director for Zoe Events, a premium DMV event-rental company. You refine an already-composed " +
      "creative brief. You may ONLY improve the creativeConcept (one or two sentences) and the imagePrompt (a vivid, " +
      "specific, photographic prompt). You MUST keep every preserve rule, transform rule, and negative constraint " +
      "exactly as given, and never invent rental equipment. Return strict JSON: {\"creativeConcept\":string,\"imagePrompt\":string}.";
    const payload = {
      assetType: job.assetType,
      subject: base.subject,
      environment: base.environment,
      camera: base.camera,
      lens: base.lens,
      lighting: base.lighting,
      composition: base.composition,
      colorGrade: base.colorGrade,
      peopleDirection: base.peopleDirection,
      preserve: base.preserve,
      transform: base.transform,
      negativeConstraints: base.negativeConstraints,
      objective: job.objective,
      audience: job.targetAudience,
      visualDirection: job.visualDirection,
      brandRules: dna.brandRules,
      currentConcept: base.creativeConcept,
      currentPrompt: base.imagePrompt,
    };
    const res = await chat(
      [
        { role: "system", content: sys },
        { role: "user", content: JSON.stringify(payload) },
      ],
      { json: true, temperature: 0.4, timeoutMs: 30000, maxTokens: 900 },
    );
    if (!res.ok || !res.text) return base;
    const parsed = JSON.parse(res.text) as { creativeConcept?: unknown; imagePrompt?: unknown };
    const concept = typeof parsed.creativeConcept === "string" ? parsed.creativeConcept.trim() : "";
    const prompt = typeof parsed.imagePrompt === "string" ? parsed.imagePrompt.trim() : "";
    if (!concept && !prompt) return base;
    return {
      ...base,
      creativeConcept: concept || base.creativeConcept,
      imagePrompt: prompt || base.imagePrompt,
      briefSource: "ai_refined",
    };
  } catch {
    return base;
  }
}
