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

/** The "By" field for a human action (house rule: name who did it). System runs pass null. PURE. */
export function byField(by: string | null | undefined): { label: string; value: string }[] {
  return by ? [{ label: "By", value: by }] : [];
}

function post(card: Parameters<typeof botAnnounce>[1]): void {
  void botAnnounce("hiring", card).catch(() => {});
}

export function announceNewHire(emp: Employee, policyName: string | null, by: string | null = null): void {
  post({
    emoji: "🆕",
    title: "New hire added",
    fields: [
      { label: "Who", value: emp.displayName },
      { label: "Role", value: policyName ?? "No access policy" },
      { label: "Work email", value: emp.workEmail ?? "None" },
      { label: "Start date", value: emp.startDate ?? "Not set" },
      ...byField(by),
    ],
    body: emp.startDate
      ? "Onboarding starts on the start date and the access checklist is created then."
      : "Set a start date or start onboarding to create the access checklist.",
    link: personLink(emp),
    context: "Hiring Bot",
  });
}

/** The Lockly reminder line, when the policy includes the door. PURE. */
export function lockReminder(tasks: LifecycleTask[], kind: "provision" | "revoke"): string | null {
  if (!tasks.some((t) => t.adapterId === "lockly")) return null;
  return kind === "provision"
    ? "*Reminder:* create their Lockly access key in the Lockly phone app, then Mark Complete in People."
    : "*Do this first:* delete their Lockly access key in the Lockly phone app, then Mark Complete in People.";
}

export function announceOnboardingStarted(emp: Employee, tasks: LifecycleTask[], sopLink: string | null = null, by: string | null = null): void {
  const lock = lockReminder(tasks, "provision");
  const sop = sopLink ? `*Send the hire this link to read and sign their SOP:*\n${sopLink}` : null;
  post({
    emoji: "👋",
    title: "Onboarding started",
    fields: [
      { label: "Who", value: emp.displayName },
      { label: "Work email", value: emp.workEmail ?? "None" },
      ...(by ? byField(by) : [{ label: "By", value: "Started on the start date" }]),
    ],
    sections: [`*Access to set up*\n${taskLines(tasks).join("\n") || "No systems in this policy."}`, ...(lock ? [lock] : []), ...(sop ? [sop] : [])],
    link: personLink(emp),
    context: "Hiring Bot",
  });
}

export function announceOffboardingStarted(emp: Employee, revokes: LifecycleTask[], effective: string | null, by: string | null = null): void {
  const lock = lockReminder(revokes, "revoke");
  post({
    emoji: "🔒",
    title: "Offboarding started",
    fields: [
      { label: "Who", value: emp.displayName },
      { label: "Effective", value: effective ?? "Now" },
      ...byField(by),
    ],
    sections: [...(lock ? [lock] : []), `*Remove access in this order*\n${taskLines(orderRevokes(revokes)).join("\n") || "Nothing to remove."}`],
    body: "The door goes first. Each step stays open here until someone confirms it is removed.",
    link: personLink(emp),
    context: "Hiring Bot",
  });
}

export function announceReady(emp: Employee, by: string | null = null): void {
  post({
    emoji: "✅",
    title: "Hire is ready",
    fields: [{ label: "Who", value: emp.displayName }, ...byField(by)],
    body: "Every required system is set up.",
    link: personLink(emp),
    context: "Hiring Bot",
  });
}

export function announceSopSigned(emp: Employee, title: string, version: string): void {
  post({
    emoji: "✍️",
    title: "SOP signed",
    fields: [
      { label: "Who", value: emp.displayName },
      { label: "Document", value: `${title} (v${version})` },
    ],
    link: personLink(emp),
    context: "Hiring Bot",
  });
}

/** Check-in milestones in days after the start date. */
export const CHECKIN_DAYS = [30, 60, 90];

/** The milestone due today for a start date, or null. A milestone counts for 7 days so a missed tick still
 *  posts, but an old hire is never flooded with past ones. PURE. */
export function dueCheckIn(startDate: string, today: string, sent: number[]): number | null {
  const days = Math.floor((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${startDate}T12:00:00Z`)) / 86_400_000);
  for (const m of CHECKIN_DAYS) {
    if (days >= m && days < m + 7 && !sent.includes(m)) return m;
  }
  return null;
}

export function announceCheckIn(emp: Employee, day: number): void {
  post({
    emoji: "📅",
    title: `${day} day check in due`,
    fields: [
      { label: "Who", value: emp.displayName },
      { label: "Started", value: emp.startDate ?? "Unknown" },
    ],
    body: "Time for the manager check in: feedback, updates, and goals.",
    link: personLink(emp),
    context: "Hiring Bot",
  });
}
