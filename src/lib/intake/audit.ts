// Guided Sales Intake — audit trail. Milestones only (start, review, the Goodshuffle lifecycle), not
// every keystroke (autosave already persists answers). Attributed to the signed-in rep. Best-effort.

import { insertAudit } from "@/lib/db/repo";
import { currentActor } from "@/lib/auth/getSession";

export type IntakeAction =
  | "INTAKE_STARTED"
  | "INTAKE_REVIEWED"
  | "GS_CONTACT_SELECTED"
  | "GS_SHELL_QUEUED"
  | "GS_SHELL_CREATED"
  | "GS_SHELL_FAILED"
  | "GS_DUPLICATE_PROJECT" // a second Goodshuffle project was reported for an intake that already had one
  | "GS_QUOTE_OPENED"
  | "WEB_LEAD_DISABLED" // structured web/connector lead accepted while the master switch is off
  | "WEB_LEAD_DUPLICATE" // a web lead for the same contact within the dedupe window
  | "WEB_LEAD_QUEUED" // a web lead's create_project op was enqueued
  | "WEB_LEAD_WELCOME_QUEUED" // the Goodshuffle welcome-template email was queued for the new project
  | "WEB_LEAD_SMS_SENT" // the welcome text went out (Google leads)
  | "WEB_LEAD_SMS_FAILED" // the welcome text could not be sent
  | "RADAR_CONVERSION_QUEUED"; // a person confirmed a Radar prospect's intent and queued the Goodshuffle project

export async function logIntakeEvent(action: IntakeAction, intakeId: string, detail?: Record<string, unknown>): Promise<void> {
  try {
    const actor = (await currentActor()).label;
    insertAudit({ actor, action, entity: "intake", entityId: intakeId, after: detail ?? null });
  } catch {
    /* audit is best-effort — never fail the intake over it */
  }
}
