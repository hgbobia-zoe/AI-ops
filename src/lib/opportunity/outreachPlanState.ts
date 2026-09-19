// Guided Outreach Plan — per-opportunity progress (which steps a person has done, notes, and where they
// are in the plan). Stored as one JSON blob per opportunity in the settings table under
// `outreach_plan:<opportunityId>`. The plan itself is generated deterministically; this is only the
// human's running state so the coaching is a real, resumable workflow.

import { getDb } from "@/lib/db/index";
import { emptyPlanState, type PlanState, type PlanStatus } from "./outreachPlanShape";

const PREFIX = "outreach_plan:";
const keyFor = (id: string): string => `${PREFIX}${id}`;

export function getPlanState(opportunityId: string): PlanState {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(keyFor(opportunityId)) as { value: string } | undefined;
  if (!row) return emptyPlanState();
  try {
    const stored = JSON.parse(row.value) as Partial<PlanState>;
    const base = emptyPlanState();
    return { ...base, ...stored, done: stored.done && typeof stored.done === "object" ? stored.done : {} };
  } catch {
    return emptyPlanState();
  }
}

export interface PlanSaveInput {
  status?: PlanStatus;
  done?: Record<string, boolean>;
  notes?: string;
}

export function savePlanState(opportunityId: string, input: PlanSaveInput): PlanState {
  const prev = getPlanState(opportunityId);
  const now = new Date().toISOString();
  const next: PlanState = {
    status: input.status ?? prev.status,
    done: input.done ?? prev.done,
    notes: input.notes !== undefined ? input.notes.trim() : prev.notes,
    updatedAt: now,
  };
  getDb().prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(keyFor(opportunityId), JSON.stringify(next), now);
  return next;
}
