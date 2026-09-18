// Event Radar — recurrence engine. PURE and deterministic. Given the historical instances of a series
// (the events we actually hold), it derives a confidence and — carefully — a PREDICTED/UNANNOUNCED next
// occurrence. It NEVER fabricates a future event: predictedNext is only ever a projection, always
// labelled, always with its supporting evidence. If the next event has been announced (an instance
// already exists for a future year) we do NOT predict — we point at the real one.

import type { RecurrenceView } from "./types";

export interface SeriesInstance {
  id: string;
  name: string;
  date: string | null; // YYYY-MM-DD
  isSeed: boolean;
}

function yearOf(date: string | null): number | null {
  if (!date) return null;
  const y = Number(date.slice(0, 4));
  return Number.isFinite(y) ? y : null;
}

/**
 * Derive the recurrence view for a series from its instances.
 * - confidence: HIGH ≥3 distinct years with a consistent gap; MEDIUM 2 years; LOW otherwise.
 * - predictedNext: only when the cadence is regular AND no instance already exists at/after the
 *   projected year (i.e. the next one truly hasn't been announced yet). Always PREDICTED/UNANNOUNCED.
 */
export function deriveRecurrence(
  series: { id: string; name: string; cadence?: string | null } | null,
  instances: SeriesInstance[],
  today: string,
): RecurrenceView {
  const history = [...instances].sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));
  if (!series || history.length === 0) {
    return { recurring: false, confidence: "NONE", history, predictedNext: null };
  }

  const years = history.map((i) => yearOf(i.date)).filter((y): y is number => y != null);
  const distinctYears = [...new Set(years)].sort((a, b) => a - b);
  const gaps = distinctYears.slice(1).map((y, i) => y - distinctYears[i]);
  const consistentGap = gaps.length > 0 && gaps.every((g) => g === gaps[0]) ? gaps[0] : null;

  let confidence: RecurrenceView["confidence"];
  if (distinctYears.length >= 3 && consistentGap != null) confidence = "HIGH";
  else if (distinctYears.length >= 2) confidence = "MEDIUM";
  else confidence = "LOW";

  const currentYear = yearOf(today) ?? new Date().getUTCFullYear();
  const lastYear = distinctYears[distinctYears.length - 1];
  const cadence = consistentGap ?? (series.cadence === "BIENNIAL" ? 2 : series.cadence === "ANNUAL" ? 1 : null);

  // A future instance we already hold IS the next event — never fabricate a projection past a known,
  // announced upcoming occurrence. Only project when the most recent known instance has passed.
  const latestDate = history.reduce<string | null>((m, i) => (i.date && (!m || i.date > m) ? i.date : m), null);
  const latestHasPassed = !!latestDate && latestDate < today;

  let predictedNext: RecurrenceView["predictedNext"] = null;
  if (cadence != null && confidence !== "LOW" && latestHasPassed) {
    let projected = lastYear + cadence;
    // Skip forward until the projection is at or beyond the current year.
    while (projected < currentYear) projected += cadence;
    predictedNext = {
      year: projected,
      basis: `${distinctYears.length} prior year${distinctYears.length === 1 ? "" : "s"} (${distinctYears.join(", ")}) at a ${cadence === 1 ? "yearly" : `${cadence}-year`} cadence — not yet announced`,
    };
  }

  return {
    recurring: true,
    confidence,
    seriesId: series.id,
    seriesName: series.name,
    cadence: cadence != null ? (cadence === 1 ? "Annual" : cadence === 2 ? "Biennial" : `Every ${cadence}y`) : (series.cadence ?? undefined),
    history,
    predictedNext,
  };
}
