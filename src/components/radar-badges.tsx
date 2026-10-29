// Opportunity Radar — shared visual language (server-safe, no client hooks). Provenance is first-class:
// every fact shows whether it's VERIFIED / INFERRED / UNKNOWN / NOT_YET_VERIFIED, and tiers/scores get a
// consistent tone across the dashboard and detail view.
//
// MIGRATED onto the Nocturne shared status model (src/lib/tone.ts + components/ui/status): status COLOUR
// lives on a distinct-shape INDICATOR (icon/dot) and the LABEL/VALUE stays the crisp high-contrast label
// (white on dark, ink on light) — never tinted to the tone. Scores are VALUES, so they stay foreground
// and carry their tier colour on a small leading dot, exactly like a Metric tile.

import type React from "react";
import { cn } from "@/lib/utils";
import { StatusBadge } from "@/components/ui/status";
import { type Tone, STATUS_DOT, STATUS_LABEL } from "@/lib/tone";
import type { OpportunityTier, Verification } from "@/lib/radar/types";

// ── Verification → shared tone ────────────────────────────────────────────────────────────────────
// Colour on the indicator icon; label stays crisp white. VERIFIED = ready, INFERRED = requires-review
// (derived, not confirmed), NOT_YET_VERIFIED / UNKNOWN = no-data neutral.
const VER_TONE: Record<string, Tone> = {
  VERIFIED: "positive",
  INFERRED: "attention",
  NOT_YET_VERIFIED: "neutral",
  UNKNOWN: "neutral",
};
const VER_LABEL: Record<string, string> = {
  VERIFIED: "Verified",
  INFERRED: "Inferred",
  UNKNOWN: "Unknown",
  NOT_YET_VERIFIED: "Not yet verified",
};

export function VerificationBadge({
  status,
  label,
  size = "sm",
}: {
  status: Verification | string;
  label?: string;
  size?: "sm" | "md";
}): React.JSX.Element {
  const tone = VER_TONE[status] ?? "neutral";
  return (
    <StatusBadge tone={tone} size={size}>
      {label ?? VER_LABEL[status] ?? status}
    </StatusBadge>
  );
}

// ── Tier → shared tone ──────────────────────────────────────────────────────────────────────────────
// HIGH = ready, MEDIUM = requires-review, LOW / UNQUALIFIED = neutral.
const TIER_TONE: Record<OpportunityTier, Tone> = {
  HIGH: "positive",
  MEDIUM: "attention",
  LOW: "neutral",
  UNQUALIFIED: "neutral",
};

/** The semantic tone for a tier (for a dot/indicator — colour never goes on the label/value itself). */
export function tierTone(tier: OpportunityTier): Tone {
  return TIER_TONE[tier];
}

/** The tier name as a crisp white uppercase label with a leading tier-coloured dot (indicator carries
 *  the colour; the word stays the high-contrast label). */
export function TierBadge({ tier }: { tier: OpportunityTier }): React.JSX.Element {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT[TIER_TONE[tier]])} aria-hidden />
      <span className={cn("text-[11px] font-semibold uppercase tracking-[0.06em]", STATUS_LABEL)}>{tier}</span>
    </span>
  );
}

/** A fit score — the number the manager scans first. It is a VALUE: the figure stays the high-contrast
 *  foreground and the tier colour rides on a small leading dot (the Metric pattern), never on the digits. */
export function ScorePill({ score, tier }: { score: number; tier: OpportunityTier }): React.JSX.Element {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn("size-2 shrink-0 rounded-full", STATUS_DOT[TIER_TONE[tier]])} aria-hidden />
      <span className="text-[15px] font-medium tabular-nums text-foreground">{score}</span>
    </span>
  );
}

/** Small "DEMO" marker so seed rows are never mistaken for verified production data. Neutral by design
 *  (it is not a status) — a quiet bordered chip in the meta tier. */
export function SeedTag(): React.JSX.Element {
  return (
    <span
      className="inline-flex items-center rounded border border-border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.08em] text-meta"
      title="Demo / seed data — not verified production data"
    >
      Demo
    </span>
  );
}
