// Shared semantic status vocabulary for the Nocturne design system.
//
// A "tone" is MEANING, not a colour: positive (ready/success), attention (requires review/warning),
// critical (blocked/error), info (syncing/processing), neutral (no data/unavailable). Every status
// surface — StatusBadge, StatusMark, FigureStrip + Metric indicators, the blocking banner — maps
// through this one table, so "blocked" reads identically everywhere.
//
// STATUS MODEL (Spectrum-style): a status is a small COLOURED INDICATOR (icon) + a crisp label on the
// neutral surface inherited from the row/panel. The colour lives on the INDICATOR; the LABEL stays
// the high-contrast label colour (white on dark, ink on light) and is NEVER tinted to match. No pill
// background, no coloured outline, no pastel tint for the routine treatment. Meaning is carried by a
// distinct icon SHAPE + the text, so it never depends on colour alone.
//
// The indicator palette (--status-*) is deliberately SEPARATE from the muted --positive/--attention/
// --critical/--info palette, which keeps its own jobs (charts via src/lib/chartTokens.ts, and legacy
// coloured text/chips in not-yet-migrated blades). Do not conflate them.

export type Tone = "positive" | "attention" | "critical" | "info" | "neutral";

/** Indicator colour (text-* so it paints an icon/dot). The ONLY place status colour belongs. */
export const STATUS_INDICATOR: Record<Tone, string> = {
  positive: "text-status-ready",
  attention: "text-status-warning",
  critical: "text-status-blocked",
  info: "text-status-syncing",
  neutral: "text-status-neutral",
};

/** Small dot indicator fill (for figure strips / metric tiles where a labelled value carries meaning). */
export const STATUS_DOT: Record<Tone, string> = {
  positive: "bg-status-ready",
  attention: "bg-status-warning",
  critical: "bg-status-blocked",
  info: "bg-status-syncing",
  neutral: "bg-status-neutral",
};

/** The crisp status label colour — white on dark, ink on light. Never tint the label to the tone. */
export const STATUS_LABEL = "text-status-label";

/**
 * Exceptional FILLED badge only (NOT the routine table treatment): a solid approved-colour fill with
 * the internal symbol/label in --status-symbol (chosen for contrast against the fill). Reserve for the
 * rare case that needs maximum salience.
 */
// The label/symbol sits on --status-symbol (dark on the bright dark-mode fills, white on the darkened
// light-mode fills) — which clears AA on every fill EXCEPT the dark-mode blocked red (#D13438), whose
// dark symbol is only 3.57:1; blocked therefore pins its label to white (4.93:1 dark, 5.9:1 light).
export const STATUS_FILL: Record<Tone, string> = {
  positive: "bg-status-ready text-status-symbol",
  attention: "bg-status-warning text-status-symbol",
  critical: "bg-status-blocked text-white",
  info: "bg-status-syncing text-status-symbol",
  neutral: "bg-status-neutral text-status-symbol",
};
