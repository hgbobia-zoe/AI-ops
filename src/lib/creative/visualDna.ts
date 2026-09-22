// Zoe Visual DNA — the centralized, reusable house look. Stored in the generic settings KV (like the
// postevent config), with the code default from types.ts. Owner/admin editable via the Visual DNA blade.
// Server-only (getJson/setJson touch the DB). The DNA is the single source of the "same photographer"
// consistency the Art Director composes every brief from — never re-typed into individual prompts.

import { getJson, setJson } from "@/lib/kv";
import { DEFAULT_VISUAL_DNA, type ZoeVisualDNA } from "./types";

const DNA_KEY = "creative_visual_dna";

const cleanList = (v: unknown, fb: string[]): string[] => {
  if (!Array.isArray(v)) return fb;
  const out = v.map((x) => (typeof x === "string" ? x.trim() : "")).filter((x) => x.length > 0);
  return out;
};
const clampLevel = (v: unknown, fb: number): number => {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fb;
  return Math.max(0, Math.min(100, Math.round(n)));
};

/** The live Visual DNA (stored override merged onto the code default; missing lists fall back). */
export function getVisualDNA(): ZoeVisualDNA {
  const stored = getJson<Partial<ZoeVisualDNA> | null>(DNA_KEY, null);
  const d = DEFAULT_VISUAL_DNA;
  if (!stored) return { ...d, photographyStyle: [...d.photographyStyle] };
  return {
    photographyStyle: cleanList(stored.photographyStyle, d.photographyStyle),
    lighting: cleanList(stored.lighting, d.lighting),
    colorGrade: cleanList(stored.colorGrade, d.colorGrade),
    cameraStyle: cleanList(stored.cameraStyle, d.cameraStyle),
    lensPreferences: cleanList(stored.lensPreferences, d.lensPreferences),
    compositionRules: cleanList(stored.compositionRules, d.compositionRules),
    environmentalStyle: cleanList(stored.environmentalStyle, d.environmentalStyle),
    peopleStyle: cleanList(stored.peopleStyle, d.peopleStyle),
    luxuryLevel: clampLevel(stored.luxuryLevel, d.luxuryLevel),
    realismLevel: clampLevel(stored.realismLevel, d.realismLevel),
    warmthLevel: clampLevel(stored.warmthLevel, d.warmthLevel),
    editorialLevel: clampLevel(stored.editorialLevel, d.editorialLevel),
    corporateLevel: clampLevel(stored.corporateLevel, d.corporateLevel),
    prohibitedCharacteristics: cleanList(stored.prohibitedCharacteristics, d.prohibitedCharacteristics),
    brandRules: cleanList(stored.brandRules, d.brandRules),
  };
}

/** Persist a full Visual DNA (the editor sends the whole object). Normalizes lists + clamps levels. */
export function saveVisualDNA(input: Partial<ZoeVisualDNA>): ZoeVisualDNA {
  const merged: ZoeVisualDNA = {
    ...getVisualDNA(),
    ...input,
  };
  // Re-run through the normalizer by round-tripping.
  setJson(DNA_KEY, merged);
  return getVisualDNA();
}

/** Reset to the code default (clears the stored override). */
export function resetVisualDNA(): ZoeVisualDNA {
  setJson(DNA_KEY, DEFAULT_VISUAL_DNA);
  return getVisualDNA();
}
