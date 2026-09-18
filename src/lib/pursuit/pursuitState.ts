// Bid pursuit — per-opportunity human-owned state (status, edited narrative, checklist ticks, notes,
// submission stamp). Stored as one JSON blob per opportunity in the generic settings table under
// `pursuit:<opportunityId>`, mirroring the capability_profile pattern. FACTS about the opportunity live
// in the radar store; this only holds what a person decides while working the bid.

import { getDb } from "@/lib/db/index";
import { emptyPursuitState, type PursuitState, type PursuitStatus } from "./bidPackageShape";

const PREFIX = "pursuit:";
const keyFor = (opportunityId: string): string => `${PREFIX}${opportunityId}`;

export function getPursuitState(opportunityId: string): PursuitState {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(keyFor(opportunityId)) as { value: string } | undefined;
  if (!row) return emptyPursuitState();
  try {
    const stored = JSON.parse(row.value) as Partial<PursuitState>;
    const base = emptyPursuitState();
    return {
      ...base,
      ...stored,
      checklistDone: stored.checklistDone && typeof stored.checklistDone === "object" ? stored.checklistDone : {},
    };
  } catch {
    return emptyPursuitState();
  }
}

export interface PursuitSaveInput {
  status?: PursuitStatus;
  statementOverride?: string | null;
  responseOverride?: string | null;
  checklistDone?: Record<string, boolean>;
  portalUrl?: string;
  notes?: string;
  /** Set when transitioning to SUBMITTED, to stamp who/when. */
  submittedBy?: string | null;
}

/** Merge-save. Only provided fields change; stamps submittedAt/By when status flips to SUBMITTED. */
export function savePursuitState(opportunityId: string, input: PursuitSaveInput): PursuitState {
  const db = getDb();
  const prev = getPursuitState(opportunityId);
  const now = new Date().toISOString();
  const trim = (v: string | null | undefined): string | null => {
    if (v == null) return null;
    const t = v.trim();
    return t === "" ? null : t;
  };

  const nextStatus = input.status ?? prev.status;
  const justSubmitted = nextStatus === "SUBMITTED" && prev.status !== "SUBMITTED";

  const next: PursuitState = {
    status: nextStatus,
    statementOverride: input.statementOverride !== undefined ? trim(input.statementOverride) : prev.statementOverride,
    responseOverride: input.responseOverride !== undefined ? trim(input.responseOverride) : prev.responseOverride,
    checklistDone: input.checklistDone ?? prev.checklistDone,
    portalUrl: input.portalUrl !== undefined ? input.portalUrl.trim() : prev.portalUrl,
    notes: input.notes !== undefined ? input.notes.trim() : prev.notes,
    submittedAt: justSubmitted ? now : prev.submittedAt,
    submittedBy: justSubmitted ? (input.submittedBy ?? prev.submittedBy) : prev.submittedBy,
    updatedAt: now,
  };

  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(keyFor(opportunityId), JSON.stringify(next), now);
  return next;
}

/** Opportunity ids that have an active pursuit record (for a "Pursuits" list). */
export function listPursuitIds(): string[] {
  const rows = getDb().prepare("SELECT key FROM settings WHERE key LIKE ?").all(`${PREFIX}%`) as { key: string }[];
  return rows.map((r) => r.key.slice(PREFIX.length));
}
