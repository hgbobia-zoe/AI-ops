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
  | "GS_QUOTE_OPENED";

export async function logIntakeEvent(action: IntakeAction, intakeId: string, detail?: Record<string, unknown>): Promise<void> {
  try {
    const actor = (await currentActor()).label;
    insertAudit({ actor, action, entity: "intake", entityId: intakeId, after: detail ?? null });
  } catch {
    /* audit is best-effort — never fail the intake over it */
  }
}
