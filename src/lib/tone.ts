// Shared semantic tone vocabulary for the Nocturne design system.
//
// A "tone" is MEANING, not a colour: positive (good / ready), attention (needs review / stale),
// critical (blocked / error), info (neutral FYI), neutral (no state). Every status surface in the
// console — badges, dots, pills, metric emphasis — maps through this one table so a "blocked" row
// in Payroll and a "blocked" row in Dispatch read identically. The tokens resolve in both themes.
//
// Keep semantic tones OUT of categorical charts: category series use the chart ramp
// (see src/lib/chartTokens.ts). Statuses and categories are deliberately different languages.

export type Tone = "positive" | "attention" | "critical" | "info" | "neutral";

/** Foreground text colour only (e.g. a number or word that should carry state). */
export const TONE_TEXT: Record<Tone, string> = {
  positive: "text-positive",
  attention: "text-attention",
  critical: "text-critical",
  info: "text-info",
  neutral: "text-meta",
};

/** A small status dot (fill). Pair with an accessible label; never rely on colour alone. */
export const TONE_DOT: Record<Tone, string> = {
  positive: "bg-positive",
  attention: "bg-attention",
  critical: "bg-critical",
  info: "bg-info",
  neutral: "bg-meta",
};

/** Soft chip — tinted fill + hairline border + coloured text. The primary status chip. */
export const TONE_SOFT: Record<Tone, string> = {
  positive: "text-positive border-positive/40 bg-positive/10",
  attention: "text-attention border-attention/40 bg-attention/10",
  critical: "text-critical border-critical/40 bg-critical/10",
  info: "text-info border-info/40 bg-info/10",
  neutral: "text-meta border-border bg-[var(--row)]",
};

/** Solid-ish pill — denser tinted fill, no border. For compact inline tags (severity, counts). */
export const TONE_SOLID: Record<Tone, string> = {
  positive: "text-positive bg-positive/15",
  attention: "text-attention bg-attention/15",
  critical: "text-critical bg-critical/15",
  info: "text-info bg-info/15",
  neutral: "text-meta bg-[var(--row)]",
};
