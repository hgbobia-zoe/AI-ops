// AI Control Plane — per-blade AI configuration. Small, durable settings that say whether AI is enabled
// on a blade and how bold it may be, stored as JSON in the settings table via kv.ts (key "aiBlade.<blade>"),
// exactly like the other namespaced config (coaching.callImport, finance config, etc.). No new table —
// this is config, not a record stream. Server-only (kv reads the DB).
//
// Governing law holds: these toggles only decide whether AI *interprets/proposes* on a blade. They can
// NEVER let AI execute — execution stays behind the approval + outbox + send-gate path regardless.

import { getJson, setJson } from "@/lib/kv";
import type { BladeKey } from "@/lib/aiorg/types";

/** The blades that can host AI, mirroring the BladeKey enum in aiorg/types.ts. */
export const AI_BLADES: BladeKey[] = [
  "salesos",
  "scheduling",
  "staffing",
  "marketing",
  "radar",
  "dispatch",
  "event-risk",
  "finance",
  "command",
];

export interface BladeAiConfig {
  /** AI surfaces on this blade at all (the per-blade workspace + agent strip). */
  enabled: boolean;
  /** Agents may auto-raise approval proposals from real signals (still human-decided). Off by default —
   *  the conservative stance: AI proposes only when a human asks until this is turned on. */
  autoPropose: boolean;
  /** Optional per-blade provider override; falls back to the globally active provider when unset. */
  provider?: string;
  updatedAt?: string;
}

/** Conservative defaults: AI is ON for visibility but never auto-proposes until explicitly enabled. */
export function defaultBladeAiConfig(): BladeAiConfig {
  return { enabled: true, autoPropose: false };
}

function key(blade: BladeKey): string {
  return `aiBlade.${blade}`;
}

/** Blades force-enabled for auto-propose by config (comma list in AI_AUTOPROPOSE_BLADES, or "*" for all).
 *  A deploy-time lever so auto-propose can be turned on without writing the settings DB. It only affects
 *  whether AI may PROPOSE — execution still requires a human approval. Env wins over the stored toggle. */
function envAutoProposeBlades(): Set<string> {
  return new Set(
    (process.env.AI_AUTOPROPOSE_BLADES ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

export function getBladeAiConfig(blade: BladeKey): BladeAiConfig {
  const stored = getJson<Partial<BladeAiConfig>>(key(blade), {});
  const merged = { ...defaultBladeAiConfig(), ...stored };
  const env = envAutoProposeBlades();
  if (env.has("*") || env.has(blade)) merged.autoPropose = true; // config force-on
  return merged;
}

/** Merge a partial update into a blade's config. Returns the merged result. */
export function setBladeAiConfig(blade: BladeKey, patch: Partial<BladeAiConfig>): BladeAiConfig {
  const next: BladeAiConfig = { ...getBladeAiConfig(blade), ...patch, updatedAt: new Date().toISOString() };
  setJson(key(blade), next);
  return next;
}

/** Every blade's config (for the Control Center management view). */
export function allBladeAiConfig(): Record<BladeKey, BladeAiConfig> {
  const out = {} as Record<BladeKey, BladeAiConfig>;
  for (const b of AI_BLADES) out[b] = getBladeAiConfig(b);
  return out;
}

/** Is AI enabled on this blade right now? (Cheap gate for the per-blade workspace.) */
export function isBladeAiEnabled(blade: BladeKey): boolean {
  return getBladeAiConfig(blade).enabled;
}

export function isValidBlade(x: unknown): x is BladeKey {
  return typeof x === "string" && (AI_BLADES as string[]).includes(x);
}
