// Goodshuffle note formatting — matches the team's own convention: `initials - date - comment`.
// Automated entries are tagged so manual vs. automation is obvious:
//   • known actor  → `HG(by SalesOS) - 9/7 - Sent text: "…"`
//   • unknown actor→ `SalesOS - 9/7 - Got voicemail`

/** Two-letter initials from a person's name (first + last). Null when we can't form them. */
export function initialsOf(name?: string | null): string | null {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  const first = parts[0][0] ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1][0] ?? "" : "";
  const ini = (first + last).toUpperCase();
  return ini || null;
}

/** M/D (no leading zeros) from a YYYY-MM-DD date, matching the team's note dates. */
export function shortDate(ymd: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return ymd;
  return `${Number(m[1])}/${Number(m[2])}`;
}

/** Build one SalesOS note line in the team's `prefix - date - comment` format. */
export function salesOsNoteLine(actorInitials: string | null, comment: string, ymd: string): string {
  const prefix = actorInitials ? `${actorInitials}(by SalesOS)` : "SalesOS";
  return `${prefix} - ${shortDate(ymd)} - ${comment}`;
}
