// Persistence for the shift EXCEPTION queue. The runtime tick folds the deterministic scan
// (scanShiftExceptions) into shift_exceptions by STABLE signature, exactly the risk_items discipline:
//   - new signature            -> insert OPEN (opened)
//   - existing & active        -> update in place (severity/detail refresh)
//   - existing & RESOLVED      -> reopen (regressed)
//   - active on a scanned date but NOT in findings -> RESOLVED
// A staffing-derived exception on a date we could NOT verify (Connecteam/Instawork unreachable) is FROZEN
// (touched, not resolved): absence on an unverified date is UNKNOWN, never "fixed" (no false recovery).

import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";
import type { ShiftException } from "./exceptions";

/** A scan finding tagged with the shift's date (so reconcile only touches scanned dates) + optional
 *  detail override (the tick enriches replacement_needed with an est. additional temp cost). */
export interface ExceptionFinding extends ShiftException {
  date: string;
}

export interface StoredShiftException {
  id: string;
  signature: string;
  shiftId: string;
  routeId: string | null;
  date: string | null;
  code: string;
  severity: string;
  status: "OPEN" | "ACKNOWLEDGED" | "RESOLVED";
  title: string;
  detail: string;
  fixLabel: string;
  firstDetectedAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
}

interface Row {
  id: string;
  signature: string;
  shift_id: string;
  route_id: string | null;
  date: string | null;
  code: string;
  severity: string;
  status: string;
  title: string;
  detail: string;
  fix_label: string;
  first_detected_at: string;
  last_seen_at: string;
  resolved_at: string | null;
}

function toStored(r: Row): StoredShiftException {
  return {
    id: r.id,
    signature: r.signature,
    shiftId: r.shift_id,
    routeId: r.route_id,
    date: r.date,
    code: r.code,
    severity: r.severity,
    status: r.status as StoredShiftException["status"],
    title: r.title,
    detail: r.detail,
    fixLabel: r.fix_label,
    firstDetectedAt: r.first_detected_at,
    lastSeenAt: r.last_seen_at,
    resolvedAt: r.resolved_at,
  };
}

// Codes whose detection depends on a reachable staffing integration — frozen on unverified dates.
const STAFFING_DERIVED = new Set(["understaffed", "not_published", "replacement_needed"]);

export interface ExceptionChanges {
  opened: StoredShiftException[];
  regressed: StoredShiftException[];
  resolved: StoredShiftException[];
  activeCount: number;
}

/** Fold findings (for exactly scannedDates) into shift_exceptions. Idempotent + transactional. */
export function reconcileShiftExceptions(
  findings: ExceptionFinding[],
  scannedDates: string[],
  now: Date = new Date(),
  unverifiedDates: Set<string> = new Set(),
): ExceptionChanges {
  const db = getDb();
  const ts = now.toISOString();
  const changes: ExceptionChanges = { opened: [], regressed: [], resolved: [], activeCount: 0 };
  if (scannedDates.length === 0) return changes;

  const seen = new Set<string>();
  const getBySig = db.prepare("SELECT * FROM shift_exceptions WHERE signature = ?");
  const insert = db.prepare(
    `INSERT INTO shift_exceptions (id, signature, shift_id, route_id, date, code, severity, status, title,
       detail, fix_label, first_detected_at, last_seen_at)
     VALUES (@id,@signature,@shiftId,@routeId,@date,@code,@severity,'OPEN',@title,@detail,@fixLabel,@now,@now)`,
  );
  const updateActive = db.prepare(
    `UPDATE shift_exceptions SET severity=@severity, title=@title, detail=@detail, fix_label=@fixLabel,
       last_seen_at=@now WHERE id=@id`,
  );
  const reopen = db.prepare(
    `UPDATE shift_exceptions SET status='OPEN', severity=@severity, title=@title, detail=@detail,
       fix_label=@fixLabel, last_seen_at=@now, resolved_at=NULL WHERE id=@id`,
  );
  const touch = db.prepare("UPDATE shift_exceptions SET last_seen_at=@now WHERE id=@id");
  const resolve = db.prepare("UPDATE shift_exceptions SET status='RESOLVED', resolved_at=@now, last_seen_at=@now WHERE id=@id");

  const tx = db.transaction(() => {
    for (const f of findings) {
      seen.add(f.signature);
      const common = { severity: f.severity, title: f.title, detail: f.detail, fixLabel: f.fixLabel, now: ts };
      const existing = getBySig.get(f.signature) as Row | undefined;
      if (!existing) {
        insert.run({ id: `SX-${randomUUID()}`, signature: f.signature, shiftId: f.shiftId, routeId: f.routeId, date: f.date, code: f.code, ...common });
        changes.opened.push(toStored(getBySig.get(f.signature) as Row));
        continue;
      }
      if (existing.status === "RESOLVED") {
        reopen.run({ id: existing.id, ...common });
        changes.regressed.push(toStored(getBySig.get(f.signature) as Row));
        continue;
      }
      updateActive.run({ id: existing.id, ...common });
    }

    // Resolve active exceptions on scanned dates that no longer appear (freeze staffing-derived on
    // unverified dates).
    const placeholders = scannedDates.map(() => "?").join(",");
    const openRows = db
      .prepare(`SELECT * FROM shift_exceptions WHERE status IN ('OPEN','ACKNOWLEDGED') AND date IN (${placeholders})`)
      .all(...scannedDates) as Row[];
    for (const r of openRows) {
      if (seen.has(r.signature)) continue;
      if (STAFFING_DERIVED.has(r.code) && unverifiedDates.has(r.date ?? "")) {
        touch.run({ id: r.id, now: ts });
        continue;
      }
      resolve.run({ id: r.id, now: ts });
      changes.resolved.push({ ...toStored(r), status: "RESOLVED", resolvedAt: ts });
    }

    changes.activeCount = (db.prepare("SELECT COUNT(*) n FROM shift_exceptions WHERE status IN ('OPEN','ACKNOWLEDGED')").get() as { n: number }).n;
  });
  tx();
  return changes;
}

/** The active exception queue (OPEN/ACKNOWLEDGED), RED first then soonest date. */
export function getActiveShiftExceptions(): StoredShiftException[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM shift_exceptions WHERE status IN ('OPEN','ACKNOWLEDGED')
       ORDER BY CASE severity WHEN 'RED' THEN 0 ELSE 1 END, date, shift_id`,
    )
    .all() as Row[];
  return rows.map(toStored);
}
