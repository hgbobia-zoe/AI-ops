// People Lifecycle tick — the unattended sweep, run by the cloud runtime (RUNTIME_JOBS). It:
//   1. fires start-date onboarding (a HIRE whose start_date has arrived → ONBOARD + materialize tasks),
//   2. executes future-dated terminations at their effective time (an OFFBOARD employee past end_date →
//      auto-run the AUTOMATED revoke tasks; manual revokes stay open — OFFBOARDED never implies removal),
//   3. escalates overdue manual provision/revoke tasks (manual_required beyond a grace window → Slack).
// App-owned: safe when nothing matches (a silent no-op). No external writes beyond the proven adapters.

import { slackNotify } from "@/lib/notify/slack";
import { todayInOpsTz } from "@/lib/dates";
import { executeAutomatedTask, startOnboarding } from "./lifecycle";
import { getAdapter } from "./adapters";
import { listEmployees, listTasks, tasksByStatus } from "./store";

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
      if (r.ok) onboarded++;
    }
  }

  // 2) Future-dated terminations — an OFFBOARD employee past their effective end date: auto-run the
  //    automated revokes (zoe_platform). Manual revokes are left open by design.
  for (const e of employees) {
    if (e.lifecycleState !== "OFFBOARD") continue;
    if (e.endDate && e.endDate > today) continue; // not yet effective
    for (const t of listTasks(e.id, "revoke")) {
      if (t.status !== "pending") continue;
      if (getAdapter(t.adapterId).mode() !== "automated") continue;
      const r = await executeAutomatedTask(t.id, actor);
      if (r.ok) revoked++;
    }
  }

  // 3) Escalate overdue manual tasks (provision + revoke) that no one has completed.
  const cutoff = new Date(now.getTime() - PEOPLE_ESCALATE_DAYS * 86_400_000).toISOString();
  const overdue = [...tasksByStatus("provision", ["manual_required", "failed"]), ...tasksByStatus("revoke", ["manual_required", "failed"])].filter(
    (t) => t.createdAt <= cutoff,
  );
  if (overdue.length > 0) {
    escalated = overdue.length;
    const lines = overdue.slice(0, 8).map((t) => `• ${t.kind} ${t.system} (${t.status})`);
    await slackNotify(
      `People Lifecycle: ${overdue.length} manual access task(s) outstanding > ${PEOPLE_ESCALATE_DAYS}d:\n${lines.join("\n")}`,
    );
  }

  const detail = `${onboarded} onboarded, ${revoked} auto-revoked, ${escalated} escalated`;
  return { ok: true, detail };
}
