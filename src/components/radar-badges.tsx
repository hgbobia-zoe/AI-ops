// Event Radar — shared visual language (server-safe, no client hooks). Provenance is first-class: every
// fact shows whether it's VERIFIED / INFERRED / UNKNOWN / NOT_YET_VERIFIED, and tiers/phases get a
// consistent tone across the dashboard and detail view. Kept in the Nocturne palette.

import type React from "react";
import type { OpportunityTier, Verification } from "@/lib/radar/types";

const VER_TONE: Record<string, string> = {
  VERIFIED: "text-positive border-positive/40",
  INFERRED: "text-attention border-attention/40",
  UNKNOWN: "text-meta border-border",
  NOT_YET_VERIFIED: "text-tertiary-text border-border",
};
const VER_LABEL: Record<string, string> = {
  VERIFIED: "Verified",
  INFERRED: "Inferred",
  UNKNOWN: "Unknown",
  NOT_YET_VERIFIED: "Not yet verified",
};

export function VerificationBadge({ status, label }: { status: Verification | string; label?: string }): React.JSX.Element {
  const tone = VER_TONE[status] ?? VER_TONE.UNKNOWN;
  return (
    <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10.5px] font-medium uppercase tracking-[0.05em] ${tone}`}>
      {label ?? VER_LABEL[status] ?? status}
    </span>
  );
}

const TIER_TONE: Record<OpportunityTier, string> = {
  HIGH: "text-positive",
  MEDIUM: "text-attention",
  LOW: "text-meta",
  UNQUALIFIED: "text-tertiary-text",
};

export function tierTone(tier: OpportunityTier): string {
  return TIER_TONE[tier];
}

export function TierBadge({ tier }: { tier: OpportunityTier }): React.JSX.Element {
  return <span className={`text-[11px] font-semibold uppercase tracking-[0.06em] ${TIER_TONE[tier]}`}>{tier}</span>;
}

/** A fit score with tone from its tier — the number the manager scans first. */
export function ScorePill({ score, tier }: { score: number; tier: OpportunityTier }): React.JSX.Element {
  return <span className={`text-[15px] font-medium tabular-nums ${TIER_TONE[tier]}`}>{score}</span>;
}

/** Small "SEED" marker so demo rows are never mistaken for verified production data. */
export function SeedTag(): React.JSX.Element {
  return <span className="inline-flex items-center rounded border border-border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.08em] text-meta" title="Demo / seed data — not verified production data">Seed</span>;
}
