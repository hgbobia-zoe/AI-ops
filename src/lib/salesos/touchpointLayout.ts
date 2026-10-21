// Pure layout math for the under-row LeadTouchTimeline. Kept out of the .tsx so it is unit-testable in the
// node test env (vitest includes src/**/*.test.ts). No DOM, no React — just the cadence + emphasis math.

/** A connector weight for each GAP between consecutive touch points (so there are n-1 of them for n
 *  points). Bigger real time gaps → longer connectors, conveying the conversation's cadence; a gap that
 *  touches an undated note (no reliable instant) gets the minimum weight, since we cannot measure it.
 *  Weights are normalized to [base, base+1] so the component can map them straight onto flex-grow, and
 *  every connector keeps a floor (nodes never collide even when two touches share an instant). */
export function connectorWeights(isos: (string | null)[], base = 0.35): number[] {
  if (isos.length < 2) return [];
  const t = isos.map((iso) => {
    if (!iso) return null;
    const ms = Date.parse(iso.length > 10 ? iso : `${iso}T00:00:00Z`);
    return Number.isFinite(ms) ? ms : null;
  });
  const deltas: (number | null)[] = [];
  for (let i = 1; i < t.length; i++) {
    const a = t[i - 1];
    const b = t[i];
    deltas.push(a != null && b != null ? Math.abs(b - a) : null);
  }
  const measured = deltas.filter((d): d is number => d != null && d > 0);
  const max = measured.length ? Math.max(...measured) : 0;
  return deltas.map((d) => (d == null || max === 0 ? base : base + d / max));
}

/** The index of the point to emphasize as "most recent": the last DATED point (rightmost real instant),
 *  else the last point overall, else -1 for an empty strip. Undated notes never steal the emphasis from a
 *  dated touch — we cannot claim an undated note is the newest. */
export function mostRecentIndex(isos: (string | null)[]): number {
  for (let i = isos.length - 1; i >= 0; i--) if (isos[i] != null) return i;
  return isos.length - 1;
}

/** A compact date label for a node: "Jun 3" style for a dated instant (month + day, locale-stable), or the
 *  note's written token verbatim for an undated line. Empty string when there is nothing honest to show. */
export function touchDateLabel(iso: string | null, dateToken: string | null): string {
  if (iso) {
    const ms = Date.parse(iso.length > 10 ? iso : `${iso}T00:00:00Z`);
    if (!Number.isFinite(ms)) return "";
    return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  }
  return (dateToken ?? "").trim();
}
