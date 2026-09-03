// Event Risk Engine (MVP2) — persistence + lifecycle.
//
// reconcileRisks() takes the deterministic findings for a set of scanned dates and folds them
// into the risk_items table by STABLE signature: existing risks are updated in place (never
// duplicated), newly-gone risks are RESOLVED, and a resolved risk that comes back is REGRESSED.
// It returns the change deltas so the scanner can Slack only what's meaningful.

import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";
import { SEVERITY_RANK, type RiskFinding, type RiskSeverity, type RiskStatus, type RiskCategory } from "./types";

export interface StoredRisk {
  id: string;
  signature: string;
  riskType: string;
  category: RiskCategory;
  severity: RiskSeverity;
  status: RiskStatus;
  title: string;
  description: string;
  date?: string;
  eventId?: string;
  routeId?: string;
  truckId?: string;
  affectedEntity?: string;
  recommendedAction?: string;
  actionTarget?: string;
  owner?: string;
  deadline?: string;
  metadata?: Record<string, unknown>;
  firstDetectedAt: string;
  lastSeenAt: string;
  resolvedAt?: string;
}

interface Row {
  id: string;
  signature: string;
  risk_type: string;
  category: string;
  severity: string;
  status: string;
  title: string;
  description: string | null;
  date: string | null;
  event_id: string | null;
  route_id: string | null;
  truck_id: string | null;
  affected_entity: string | null;
  recommended_action: string | null;
  action_target: string | null;
  owner: string | null;
  deadline: string | null;
  metadata: string | null;
  first_detected_at: string;
  last_seen_at: string;
  resolved_at: string | null;
}

function toStored(r: Row): StoredRisk {
  return {
    id: r.id,
    signature: r.signature,
    riskType: r.risk_type,
    category: r.category as RiskCategory,
    severity: r.severity as RiskSeverity,
    status: r.status as RiskStatus,
    title: r.title,
    description: r.description ?? "",
    date: r.date ?? undefined,
    eventId: r.event_id ?? undefined,
    routeId: r.route_id ?? undefined,
    truckId: r.truck_id ?? undefined,
    affectedEntity: r.affected_entity ?? undefined,
    recommendedAction: r.recommended_action ?? undefined,
    actionTarget: r.action_target ?? undefined,
    owner: r.owner ?? undefined,
    deadline: r.deadline ?? undefined,
    metadata: r.metadata ? (JSON.parse(r.metadata) as Record<string, unknown>) : undefined,
    firstDetectedAt: r.first_detected_at,
    lastSeenAt: r.last_seen_at,
    resolvedAt: r.resolved_at ?? undefined,
  };
}

const ACTIVE_STATES = "('OPEN','ACKNOWLEDGED','IN_PROGRESS')";

export interface RiskChanges {
  created: StoredRisk[];
  escalated: { risk: StoredRisk; from: RiskSeverity; to: RiskSeverity }[];
  resolved: StoredRisk[];
  regressed: StoredRisk[];
}

/**
 * Fold `findings` (for exactly the `scannedDates`) into risk_items.
 * - new signature → insert OPEN (created)
 * - existing & active → update; severity increase = escalated
 * - existing & RESOLVED → reopen (regressed)
 * - existing & DISMISSED → leave dismissed (respect the human), just touch last_seen
 * - active item on a scanned date but NOT in findings → RESOLVED
 * Only rows whose `date` is in scannedDates are considered, so risks outside the horizon are untouched.
 */
export function reconcileRisks(findings: RiskFinding[], scannedDates: string[], now: Date = new Date()): RiskChanges {
  const db = getDb();
  const ts = now.toISOString();
  const changes: RiskChanges = { created: [], escalated: [], resolved: [], regressed: [] };
  if (scannedDates.length === 0) return changes;

  const seen = new Set<string>();

  const getBySig = db.prepare("SELECT * FROM risk_items WHERE signature = ?");
  const insert = db.prepare(
    `INSERT INTO risk_items (id, signature, risk_type, category, severity, status, title, description,
       date, event_id, route_id, truck_id, affected_entity, recommended_action, action_target,
       metadata, first_detected_at, last_seen_at)
     VALUES (@id,@signature,@riskType,@category,@severity,'OPEN',@title,@description,
       @date,@eventId,@routeId,@truckId,@affectedEntity,@recommendedAction,@actionTarget,
       @metadata,@now,@now)`,
  );
  const updateActive = db.prepare(
    `UPDATE risk_items SET severity=@severity, title=@title, description=@description,
       recommended_action=@recommendedAction, action_target=@actionTarget, metadata=@metadata,
       last_seen_at=@now WHERE id=@id`,
  );
  const touch = db.prepare("UPDATE risk_items SET last_seen_at=@now WHERE id=@id");
  const reopen = db.prepare(
    `UPDATE risk_items SET status='OPEN', severity=@severity, title=@title, description=@description,
       recommended_action=@recommendedAction, action_target=@actionTarget, metadata=@metadata,
       last_seen_at=@now, resolved_at=NULL WHERE id=@id`,
  );
  const resolve = db.prepare("UPDATE risk_items SET status='RESOLVED', resolved_at=@now, last_seen_at=@now WHERE id=@id");

  const tx = db.transaction(() => {
    for (const f of findings) {
      seen.add(f.signature);
      const existing = getBySig.get(f.signature) as Row | undefined;
      const common = {
        severity: f.severity,
        title: f.title,
        description: f.description,
        recommendedAction: f.recommendedAction ?? null,
        actionTarget: f.actionTarget ?? null,
        metadata: f.metadata ? JSON.stringify(f.metadata) : null,
        now: ts,
      };
      if (!existing) {
        const id = `RK-${randomUUID()}`;
        insert.run({
          id,
          signature: f.signature,
          riskType: f.riskType,
          category: f.category,
          date: f.date ?? null,
          eventId: f.eventId ?? null,
          routeId: f.routeId ?? null,
          truckId: f.truckId ?? null,
          affectedEntity: f.affectedEntity ?? null,
          ...common,
        });
        changes.created.push(toStored(getBySig.get(f.signature) as Row));
        continue;
      }
      if (existing.status === "DISMISSED") {
        // Stay dismissed while the condition is unchanged; but a genuine WORSENING (higher
        // severity than when dismissed) is a meaningful change → resurface it.
        if (SEVERITY_RANK[f.severity] > SEVERITY_RANK[existing.severity as RiskSeverity]) {
          reopen.run({ id: existing.id, ...common });
          changes.regressed.push(toStored(getBySig.get(f.signature) as Row));
        } else {
          touch.run({ id: existing.id, now: ts });
        }
        continue;
      }
      if (existing.status === "RESOLVED") {
        reopen.run({ id: existing.id, ...common });
        changes.regressed.push(toStored(getBySig.get(f.signature) as Row));
        continue;
      }
      // active
      const from = existing.severity as RiskSeverity;
      updateActive.run({ id: existing.id, ...common });
      if (SEVERITY_RANK[f.severity] > SEVERITY_RANK[from]) {
        changes.escalated.push({ risk: toStored(getBySig.get(f.signature) as Row), from, to: f.severity });
      }
    }

    // Resolve active risks on scanned dates that no longer appear.
    const placeholders = scannedDates.map(() => "?").join(",");
    const openRows = db
      .prepare(`SELECT * FROM risk_items WHERE status IN ${ACTIVE_STATES} AND date IN (${placeholders})`)
      .all(...scannedDates) as Row[];
    for (const r of openRows) {
      if (!seen.has(r.signature)) {
        resolve.run({ id: r.id, now: ts });
        changes.resolved.push({ ...toStored(r), status: "RESOLVED", resolvedAt: ts });
      }
    }
  });
  tx();
  return changes;
}

/** The active risk queue (OPEN/ACK/IN_PROGRESS), worst-first then soonest date. */
export function getRiskQueue(): StoredRisk[] {
  const rows = getDb()
    .prepare(`SELECT * FROM risk_items WHERE status IN ${ACTIVE_STATES} ORDER BY date ASC`)
    .all() as Row[];
  return rows
    .map(toStored)
    .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || (a.date ?? "").localeCompare(b.date ?? ""));
}

export function setRiskStatus(id: string, status: RiskStatus, owner?: string): boolean {
  const now = new Date().toISOString();
  const resolvedAt = status === "RESOLVED" ? now : null;
  const info = getDb()
    .prepare("UPDATE risk_items SET status=?, owner=COALESCE(?, owner), resolved_at=?, last_seen_at=? WHERE id=?")
    .run(status, owner ?? null, resolvedAt, now, id);
  return info.changes > 0;
}
