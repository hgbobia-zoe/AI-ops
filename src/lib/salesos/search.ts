// Sales OS project search — ONE pure match function that drives the search bar across all three views
// (Board / Worklist / Table). Keeping the logic here (no DB or server imports, client-safe) means a
// query means the same thing in every view: the Kanban board, the ranked worklist, and the flat table
// all filter their own project set with identical rules, so results stay consistent.

/** The subset of fields the search looks at. Every view maps its own card/queue item onto this shape,
 *  so the match logic never has to know which view it came from. All fields but `id` are optional. */
export interface SearchableProject {
  id: string;
  clientName?: string | null;
  eventName?: string | null;
  value?: number | null;
  /** Human stage/state/status label as shown in that view (e.g. "Quote Sent", "Awaiting reply"). */
  stage?: string | null;
  venue?: string | null;
  location?: string | null;
}

/** Trim + lowercase a raw query. An empty or whitespace-only query normalizes to "" (matches all). */
export function normalizeQuery(q: string): string {
  return q.trim().toLowerCase();
}

/** The searchable text for a project: client, event/label, stage, address, and its value (raw + formatted). */
function haystack(p: SearchableProject): string {
  const parts: string[] = [];
  if (p.clientName) parts.push(p.clientName);
  if (p.eventName) parts.push(p.eventName);
  if (p.stage) parts.push(p.stage);
  if (p.venue) parts.push(p.venue);
  if (p.location) parts.push(p.location);
  if (p.value != null && Number.isFinite(p.value)) {
    const n = Math.round(p.value);
    parts.push(String(n)); // "4200"
    parts.push("$" + n.toLocaleString("en-US")); // "$4,200"
  }
  return parts.join(" ").toLowerCase();
}

/** Case-insensitive match of a project against a raw query. Every whitespace-separated term must appear
 *  somewhere in the project's searchable text (AND across terms). An empty/whitespace query matches all. */
export function matchesQuery(p: SearchableProject, q: string): boolean {
  const terms = normalizeQuery(q).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const hay = haystack(p);
  return terms.every((t) => hay.includes(t));
}

/** Filter a project set by query, preserving order. An empty/whitespace query returns the input as-is. */
export function filterProjects<T extends SearchableProject>(projects: T[], q: string): T[] {
  if (!normalizeQuery(q)) return projects;
  return projects.filter((p) => matchesQuery(p, q));
}

/** Match a row's lead state against the active single-select state filter. `null`/`""` (the default)
 *  matches everything. The status compared is the row's EXISTING board-status classification — the
 *  state filter never invents a state, it just selects one the code already computes. Composes with the
 *  search: a view applies `matchesQuery(p, q) && matchesState(status, stateFilter)` to narrow by both. */
export function matchesState(status: string | null | undefined, stateFilter: string | null | undefined): boolean {
  if (!stateFilter) return true;
  return status === stateFilter;
}
