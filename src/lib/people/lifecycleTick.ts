// People Lifecycle tick — the unattended sweep, run by the cloud runtime (RUNTIME_JOBS). It:
//   1. fires start-date onboarding (a HIRE whose start_date has arrived → ONBOARD + materialize tasks),
//   2. executes future-dated terminations at their effective time (an OFFBOARD employee past end_date →
//      auto-run the AUTOMATED revoke tasks; manual revokes stay open — OFFBOARDED never implies removal),
//   3. escalates overdue manual provision/revoke tasks (manual_required beyond a grace window → Slack).
// App-owned: safe when nothing matches (a silent no-op). No external writes beyond the proven adapters.

import { botAnnounce, appUrl } from "@/lib/notify/aiBots";
import { todayInOpsTz } from "@/lib/dates";
import { executeAutomatedTask, startOnboarding } from "./lifecycle";
import { getAdapter } from "./adapters";
import { getEmployee, listEmployees, listTasks, tasksByStatus } from "./store";
import { announceCheckIn, announceOnboardingStarted, dueCheckIn, orderRevokes } from "./notify";
import { ensureSopLink } from "./sopAck";
import { getJson, setJson } from "@/lib/kv";

/** Days a manual provision/revoke task may sit before it is escalated. */
export const PEOPLE_ESCALATE_DAYS = 3;

export async function runPeopleLifecycleTick(now: Date = new Date()): Promise<{ ok: boolean; detail: string }> {
  const today = todayInOpsTz();
  const actor = "People Lifecycle (runtime)";
  let onboarded = 0;
  let revoked = 0;
  let escalated = 0;

  const employees = listEmployees();

  // 1) Start-date onboarding — a HIRE whose start date is today or earlier.
  for (const e of employees) {
    if (e.lifecycleState === "HIRE" && e.startDate && e.startDate <= today) {
      const r = startOnboarding(e.id, actor);
      if (r.ok) {
        onboarded++;
        const cur = getEmployee(e.id) ?? e;
        announceOnboardingStarted(cur, listTasks(e.id, "provision"), ensureSopLink(cur));
      }
    }
  }

  // 2) Future-dated terminations — an OFFBOARD employee past their effective end date: auto-run the
  //    automated revokes (zoe_platform). Manual revokes are left open by design.
  for (const e of employees) {
    if (e.lifecycleState !== "OFFBOARD") continue;
    if (e.endDate && e.endDate > today) continue; // not yet effective
    for (const t of orderRevokes(listTasks(e.id, "revoke"))) {
      if (t.status !== "pending") continue;
      if (getAdapter(t.adapterId).mode() !== "automated") continue;
      const r = await executeAutomatedTask(t.id, actor);
      if (r.ok) {
        revoked++;
        void botAnnounce("hiring", {
          emoji: "🔒",
          title: "Access deactivated",
          fields: [
            { label: "Who", value: e.displayName },
            { label: "System", value: t.system },
            { label: "Effective", value: e.endDate ?? today },
          ],
          body: "Offboarding. Any manual access removals stay open for a human.",
          link: { text: "Open People", url: appUrl("/people") },
          context: "Hiring Bot",
        }).catch(() => {});
      }
    }
  }

  // 3) Escalate overdue manual tasks (provision + revoke) that no one has completed.
  const cutoff = new Date(now.getTime() - PEOPLE_ESCALATE_DAYS * 86_400_000).toISOString();
  const overdue = [...tasksByStatus("provision", ["manual_required", "failed"]), ...tasksByStatus("revoke", ["manual_required", "failed"])].filter(
    (t) => t.createdAt <= cutoff,
  );
  if (overdue.length > 0) {
    escalated = overdue.length;
    const lines = overdue.slice(0, 8).map((t) => {
      const who = getEmployee(t.employeeId)?.displayName ?? "someone";
      return `• ${t.kind === "revoke" ? "Remove" : "Set up"} ${t.system} for ${who}`;
    });
    await botAnnounce("hiring", {
      emoji: "⏰",
      title: `${overdue.length} access step${overdue.length === 1 ? "" : "s"} still open`,
      sections: [lines.join("\n")],
      body: `Open for more than ${PEOPLE_ESCALATE_DAYS} days. Do them in the system, then Mark Complete in People.`,
      link: { text: "Open People", url: appUrl("/people") },
      context: "Hiring Bot",
    }).catch(() => {});
  }

  // 4) Manager check ins at 30 / 60 / 90 days after the start date (each posted once to #hiring).
  const sentMap = getJson<Record<string, number[]>>("people.checkins", {});
  let checkins = 0;
  for (const e of employees) {
    if (!e.startDate || !["ONBOARD", "READY", "ACTIVE"].includes(e.lifecycleState)) continue;
    const sent = sentMap[e.id] ?? [];
    const due = dueCheckIn(e.startDate, today, sent);
    if (due == null) continue;
    sentMap[e.id] = [...sent, due];
    announceCheckIn(e, due);
    checkins++;
  }
  if (checkins > 0) setJson("people.checkins", sentMap);

  const detail = `${checkins} check ins, ${onboarded} onboarded, ${revoked} auto-revoked, ${escalated} escalated`;
  return { ok: true, detail };
}
