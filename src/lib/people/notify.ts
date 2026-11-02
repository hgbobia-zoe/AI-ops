// People Lifecycle Slack notices. Every lifecycle milestone posts to the Hiring Bot's channel
// (botAnnounce("hiring"); override with SLACK_CHANNEL_HIRING). House style: plain words, no dashes.
// Best effort: a Slack failure never blocks a lifecycle action.

import { botAnnounce, appUrl } from "@/lib/notify/aiBots";
import { revokeRank } from "./policy";
import type { Employee, LifecycleTask } from "./types";

const STATUS_WORD: Record<LifecycleTask["status"], string> = {
  pending: "waiting for approval",
  in_progress: "running",
  completed: "done",
  failed: "failed",
  manual_required: "do by hand",
  skipped: "skipped",
  blocked: "blocked",
};

/** One line per task, in the order given. PURE (exported for tests). */
export function taskLines(tasks: LifecycleTask[]): string[] {
  return tasks.map((t, i) => `${i + 1}. ${t.system}: ${STATUS_WORD[t.status]}${t.required ? "" : " (optional)"}`);
}

/** Revoke tasks in offboarding order (door first). PURE. */
export function orderRevokes(tasks: LifecycleTask[]): LifecycleTask[] {
  return [...tasks].sort((a, b) => revokeRank(a.adapterId) - revokeRank(b.adapterId));
}

function personLink(emp: Employee) {
  return { text: "Open in People", url: appUrl(`/people/${encodeURIComponent(emp.id)}`) };
}

function post(card: Parameters<typeof botAnnounce>[1]): void {
  void botAnnounce("hiring", card).catch(() => {});
}

export function announceNewHire(emp: Employee, policyName: string | null): void {
  post({
    emoji: "🆕",
    title: "New hire added",
    fields: [
      { label: "Who", value: emp.displayName },
      { label: "Role", value: policyName ?? "No access policy" },
      { label: "Work email", value: emp.workEmail ?? "None" },
      { label: "Start date", value: emp.startDate ?? "Not set" },
    ],
    body: emp.startDate
      ? "Onboarding starts on the start date and the access checklist is created then."
      : "Set a start date or start onboarding to create the access checklist.",
    link: personLink(emp),
    context: "Hiring Bot",
  });
}

export function announceOnboardingStarted(emp: Employee, tasks: LifecycleTask[]): void {
  post({
    emoji: "👋",
    title: "Onboarding started",
    fields: [
      { label: "Who", value: emp.displayName },
      { label: "Work email", value: emp.workEmail ?? "None" },
    ],
    sections: [`*Access to set up*\n${taskLines(tasks).join("\n") || "No systems in this policy."}`],
    link: personLink(emp),
    context: "Hiring Bot",
  });
}

export function announceOffboardingStarted(emp: Employee, revokes: LifecycleTask[], effective: string | null): void {
  post({
    emoji: "🔒",
    title: "Offboarding started",
    fields: [
      { label: "Who", value: emp.displayName },
      { label: "Effective", value: effective ?? "Now" },
    ],
    sections: [`*Remove access in this order*\n${taskLines(orderRevokes(revokes)).join("\n") || "Nothing to remove."}`],
    body: "The door goes first. Each step stays open here until someone confirms it is removed.",
    link: personLink(emp),
    context: "Hiring Bot",
  });
}

export function announceReady(emp: Employee): void {
  post({
    emoji: "✅",
    title: "Hire is ready",
    fields: [{ label: "Who", value: emp.displayName }],
    body: "Every required system is set up.",
    link: personLink(emp),
    context: "Hiring Bot",
  });
}
