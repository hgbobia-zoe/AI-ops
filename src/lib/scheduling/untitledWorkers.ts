// "Scheduled, but no Connecteam Title" — the role-gap VISIBILITY detector. The #104 fix already makes an
// untitled worker safe (roleFromTitle -> "other" -> isAutoRouteEligible false -> never auto-routed). This
// closes the other half the owner asked for: SEE the gap instead of silently dropping the person. If a
// scheduled worker has no Title set, their crew role genuinely can't be determined, so a human must set it
// (and approve the role) before they can be scheduled onto crew/routes.
//
// HONESTY / design law: we flag ONLY a genuinely EMPTY title. A worker who HAS a title that maps to the
// "other" bucket (Co-Founder, Executive Assistant, a manager) is a legitimate non-crew person with a real
// title — not a data gap — and is NOT flagged. PURE: a function of the scheduled workers; the caller reuses
// the shared scheduling-alarm cool-off for the actual Slack post (no new notification system).

/** The minimal shape the detector needs off a scheduled crew member (Connecteam roster CrewMember fits). */
export interface TitledWorker {
  userId: number;
  name: string;
  /** The Connecteam "Title" custom field. null / "" / whitespace = genuinely unset (the data gap we flag). */
  title?: string | null;
}

/** One scheduled worker with no Title set — surfaced so a human sets it before they can be crewed. */
export interface UntitledWorker {
  userId: number;
  name: string;
}

/** True when a title is genuinely unset (missing, empty, or whitespace). A present-but-"other" title
 *  (Co-Founder, etc.) is NOT unset — it is a real title and must not be flagged. */
export function hasNoTitle(title?: string | null): boolean {
  return typeof title !== "string" || title.trim() === "";
}

/**
 * PURE. Return the DISTINCT scheduled workers who have no Connecteam Title (so their role can't be
 * determined). De-duped by userId (a person on several shifts that day is flagged once), first name kept.
 * Order is stable (first appearance). Workers WITH a title (even one that maps to "other") are excluded.
 */
export function detectUntitledWorkers(scheduled: TitledWorker[]): UntitledWorker[] {
  const seen = new Map<number, string>();
  for (const w of scheduled) {
    if (!hasNoTitle(w.title)) continue; // has a real title (driver/warehouse/other) — not a gap
    if (!seen.has(w.userId)) seen.set(w.userId, w.name);
  }
  return [...seen.entries()].map(([userId, name]) => ({ userId, name }));
}
