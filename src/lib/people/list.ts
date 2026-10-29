// People Lifecycle — pure list filtering + counting for the searchable/filterable lifecycle view.
// The page assembles the stage-annotated summaries (overview.lifecycleList) server-side; these pure
// helpers do the stage/search narrowing and the per-stage counts the filter chips show. Kept IO-free
// so the filter/count contract is unit-testable (type-only import of EmployeeSummary — no runtime cycle).

import type { EmployeeSummary } from "./overview";
import type { Stage } from "./stages";

/** A stage filter is either a concrete Stage or the "all" sentinel. */
export type StageFilter = Stage | "all";

/** Normalize an untrusted ?stage= value against the stages valid for this section (else "all"). */
export function parseStageFilter(raw: string | undefined, allowed: Stage[]): StageFilter {
  return raw && (allowed as string[]).includes(raw) ? (raw as Stage) : "all";
}

/** Count how many people fall in each stage of `allowed` (plus the total), over the given scope. */
export function stageCounts(people: EmployeeSummary[], allowed: Stage[]): { all: number } & Partial<Record<Stage, number>> {
  const counts: { all: number } & Partial<Record<Stage, number>> = { all: people.length };
  for (const stage of allowed) counts[stage] = people.filter((p) => p.stage === stage).length;
  return counts;
}

/**
 * Filter a scope of people by stage + a free-text query. The query matches the name, role, department
 * (policy id) and work email, case-insensitively; stage "all" keeps every person in scope. Pure.
 */
export function filterPeople(people: EmployeeSummary[], opts: { stage?: StageFilter; q?: string }): EmployeeSummary[] {
  const stage = opts.stage ?? "all";
  const q = (opts.q ?? "").trim().toLowerCase();
  return people.filter((p) => {
    if (stage !== "all" && p.stage !== stage) return false;
    if (!q) return true;
    const e = p.employee;
    const hay = `${e.displayName} ${e.role} ${e.department ?? ""} ${e.workEmail ?? ""}`.toLowerCase();
    return hay.includes(q);
  });
}
