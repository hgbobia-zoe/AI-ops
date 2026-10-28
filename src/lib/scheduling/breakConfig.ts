// Break-management configuration — HR-editable policy for the break-reminder engine. Persisted in the
// settings KV with safe defaults. ACTIVATION IS GATED: `enabled` defaults to FALSE, so nothing is sent until
// HR turns it on after reviewing the compliance notes below. Policies are configurable so HR can adjust them
// without a code change (spec: do not hardcode a universal 5h legal requirement).

import { getJson, setJson } from "@/lib/kv";
import type { BreakPolicy } from "./breaks";

export interface BreakConfig {
  /** Master switch. Default FALSE — reminders are never sent until HR enables this (approval-gated). */
  enabled: boolean;
  /** The internal reminder policy (NOT a statutory rule — see LEGAL_NOTES). */
  policy: BreakPolicy;
  /** Preferred notification channel. Starts as the engine's recommendation; see the limitation note in the
   *  report (Connecteam push vs SMS reliability must be verified before enabling). */
  channel: "connecteam" | "sms" | "none";
}

const KEY = "scheduling.breaks.config";

export const DEFAULT_BREAK_POLICY: BreakPolicy = {
  thresholdHours: 5, // ZOE INTERNAL policy, configurable — not a legal minimum (see LEGAL_NOTES)
  reminderFraction: 0.5, // aim the reminder around the middle of the shift
  minWorkedMinutes: 120, // never remind in the first two hours
  qualifyingBreakMinutes: 20, // a recorded break of >= 20 min suppresses the reminder
  criticalBufferMinutes: 30, // avoid reminding within 30 min of a scheduled stop/install
};

export const DEFAULT_BREAK_CONFIG: BreakConfig = {
  enabled: false, // GATED OFF until HR approves (compliance review required)
  policy: DEFAULT_BREAK_POLICY,
  channel: "none",
};

/**
 * Sourced break-law findings for Zoe's operating jurisdictions, kept as DATA so the policy engine never
 * encodes a statutory rule in logic. Summary for an adult, non-retail delivery/install crew:
 *  - Federal (FLSA): no required meal or rest breaks for adults.
 *  - Maryland: no general adult break mandate. The Healthy Retail Employee Act covers RETAIL employers only
 *    (not event rental). MINORS (under 18): a 30-minute break for every 5 consecutive hours worked (law).
 *  - District of Columbia: no general adult meal/rest break mandate. Minor-labor protections apply.
 *  - Virginia: no general adult meal/rest break mandate. Breaks required for workers under 16.
 * => The > 5h reminder is INTERNAL policy. The only statutory piece is the MINOR rule (notably MD 30 min per
 *    5 consecutive hours). Zoe does not currently hold worker age/DOB in the platform, so a minor rule cannot
 *    be enforced from data today; it must stay a human-confirmed, HR-approved policy. This is flagged for
 *    approval, not activated. Verify current statutes with counsel before enabling any compliance behavior.
 */
export const LEGAL_NOTES = {
  reviewedOn: "2026-10-27",
  jurisdictions: {
    federal: { adultBreakMandate: false, note: "FLSA requires no meal/rest breaks for adults." },
    MD: { adultBreakMandate: false, minorRule: "30 min per 5 consecutive hours (under 18)", retailOnlyAdultLaw: "Healthy Retail Employee Act (retail employers only)" },
    DC: { adultBreakMandate: false, minorRule: "minor-labor protections apply" },
    VA: { adultBreakMandate: false, minorRule: "breaks required for workers under 16" },
  },
  caveat: "Internal 5h policy is not a legal minimum. Minor rules are statutory but unenforceable without age data. Confirm with counsel before enabling compliance behavior.",
} as const;

function clampNum(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= lo && n <= hi ? n : fallback;
}

export function getBreakConfig(): BreakConfig {
  const stored = getJson<Partial<BreakConfig>>(KEY, {});
  const p: Partial<BreakPolicy> = stored.policy ?? {};
  return {
    enabled: typeof stored.enabled === "boolean" ? stored.enabled : DEFAULT_BREAK_CONFIG.enabled,
    channel: stored.channel === "connecteam" || stored.channel === "sms" || stored.channel === "none" ? stored.channel : DEFAULT_BREAK_CONFIG.channel,
    policy: {
      thresholdHours: clampNum(p.thresholdHours, 1, 24, DEFAULT_BREAK_POLICY.thresholdHours),
      reminderFraction: clampNum(p.reminderFraction, 0.1, 0.9, DEFAULT_BREAK_POLICY.reminderFraction),
      minWorkedMinutes: clampNum(p.minWorkedMinutes, 0, 600, DEFAULT_BREAK_POLICY.minWorkedMinutes),
      qualifyingBreakMinutes: clampNum(p.qualifyingBreakMinutes, 5, 120, DEFAULT_BREAK_POLICY.qualifyingBreakMinutes),
      criticalBufferMinutes: clampNum(p.criticalBufferMinutes, 0, 120, DEFAULT_BREAK_POLICY.criticalBufferMinutes),
    },
  };
}

export function saveBreakConfig(patch: Partial<BreakConfig>): BreakConfig {
  const cur = getBreakConfig();
  const next: BreakConfig = {
    enabled: typeof patch.enabled === "boolean" ? patch.enabled : cur.enabled,
    channel: patch.channel === "connecteam" || patch.channel === "sms" || patch.channel === "none" ? patch.channel : cur.channel,
    policy: { ...cur.policy, ...(patch.policy ?? {}) },
  };
  // Re-validate through the getter's clamps.
  setJson(KEY, next);
  return getBreakConfig();
}
