// People Lifecycle overview — assembles the onboarding/offboarding queues server-side so the page only
// renders. Each entry carries its readiness (computed from the employee's provision tasks) and the count
// of outstanding revokes (for the honest "OFFBOARDED ≠ access removed" callout).

import { readinessFor, type Readiness } from "./lifecycle";
import { listEmployees, listTasks } from "./store";
import type { Employee } from "./types";

export interface EmployeeSummary {
  employee: Employee;
  readiness: Readiness;
  hasFailed: boolean;
  outstandingRevokes: number; // revoke tasks not completed/skipped (manual ones stay open after OFFBOARDED)
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
  return {
    employee: e,
    readiness,
    hasFailed: provision.some((t) => t.status === "failed"),
    outstandingRevokes: revokes.filter((t) => t.status !== "completed" && t.status !== "skipped").length,
  };
}

export function peopleOverview(): PeopleOverview {
  const summaries = listEmployees().map(summarize);
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
