// People Lifecycle overview — assembles the onboarding/offboarding queues server-side so the page only
// renders. Each entry carries its readiness (computed from the employee's provision tasks) and the count
// of outstanding revokes (for the honest "OFFBOARDED ≠ access removed" callout).

import { readinessFor, type Readiness } from "./lifecycle";
import { listEmployees, listTasks } from "./store";
import { classifyStage, type Stage } from "./stages";
import type { Employee } from "./types";

export interface EmployeeSummary {
  employee: Employee;
  readiness: Readiness;
  hasFailed: boolean;
  outstandingRevokes: number; // revoke tasks not completed/skipped (manual ones stay open after OFFBOARDED)
  stage: Stage; // the single derived bucket the UI groups/filters/counts by (same rules as below)
}

export interface PeopleOverview {
  startingSoon: EmployeeSummary[]; // HIRE
  onboarding: EmployeeSummary[]; //  ONBOARD, progressing, not ready
  blocked: EmployeeSummary[]; //     ONBOARD with a failed task
  ready: EmployeeSummary[]; //       onboarding complete (ready to activate) OR already READY
  active: EmployeeSummary[]; //      ACTIVE
  offboarding: EmployeeSummary[]; // OFFBOARD
  offboarded: EmployeeSummary[]; //  OFFBOARDED
  counts: { total: number; active: number; onboarding: number; offboarding: number; outstandingRevokes: number };
}

function summarize(e: Employee): EmployeeSummary {
  const readiness = readinessFor(e.id);
  const provision = listTasks(e.id, "provision");
  const revokes = listTasks(e.id, "revoke");
  const hasFailed = provision.some((t) => t.status === "failed");
  return {
    employee: e,
    readiness,
    hasFailed,
    outstandingRevokes: revokes.filter((t) => t.status !== "completed" && t.status !== "skipped").length,
    stage: classifyStage({ lifecycleState: e.lifecycleState, hasFailed, ready: readiness.ready }),
  };
}

/** The whole population as one flat, stage-annotated list (newest first). The searchable/filterable
 *  lifecycle list renders from this; `peopleOverview` groups the same summaries for the counts. */
export function lifecycleList(): EmployeeSummary[] {
  return listEmployees().map(summarize);
}

export function peopleOverview(): PeopleOverview {
  const summaries = lifecycleList();
  const startingSoon = summaries.filter((s) => s.employee.lifecycleState === "HIRE");
  const onboardingAll = summaries.filter((s) => s.employee.lifecycleState === "ONBOARD");
  const blocked = onboardingAll.filter((s) => s.hasFailed);
  const readyInOnboard = onboardingAll.filter((s) => !s.hasFailed && s.readiness.ready);
  const onboarding = onboardingAll.filter((s) => !s.hasFailed && !s.readiness.ready);
  const readyState = summaries.filter((s) => s.employee.lifecycleState === "READY");
  const active = summaries.filter((s) => s.employee.lifecycleState === "ACTIVE");
  const offboarding = summaries.filter((s) => s.employee.lifecycleState === "OFFBOARD");
  const offboarded = summaries.filter((s) => s.employee.lifecycleState === "OFFBOARDED");

  return {
    startingSoon,
    onboarding,
    blocked,
    ready: [...readyInOnboard, ...readyState],
    active,
    offboarding,
    offboarded,
    counts: {
      total: summaries.length,
      active: active.length,
      onboarding: onboardingAll.length,
      offboarding: offboarding.length + offboarded.length,
      outstandingRevokes: [...offboarding, ...offboarded].reduce((n, s) => n + s.outstandingRevokes, 0),
    },
  };
}
