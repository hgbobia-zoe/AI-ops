// The SHIFT PACKET — everything a worker needs at shift start, assembled ONLY from structured data
// already in the DB (route/stop/vehicle/Connecteam/shift). No LLM produces a fact here (RULES CALCULATE).
// A null fact is shown as "TBD" by the renderer, never guessed. The packet is versioned by a content
// hash, so "what did this worker receive, and is it current?" is a pure comparison, and a changed packet
// (e.g. a truck swap) deterministically differs — the lifecycle drops affected assignments out of
// NOTIFIED/CONFIRMED and queues a re-send (readiness recomputes from packet_sent_at per version).

import { createHash } from "node:crypto";
import { getDb } from "@/lib/db";
import type { ShiftAssignment, ShiftRole, StaffShift } from "./types";

/** The Zoe main line — the dispatch number on every packet. NEVER the customer's number (memory rule). */
export const ZOE_DISPATCH_PHONE = "301-291-5296";

export type WorkerTimekeeping =
  | { kind: "internal"; system: "connecteam"; howTo: string }
  | { kind: "instawork"; system: "instawork"; howTo: string };

export interface ShiftPacket {
  shiftId: string;
  version: string; // content hash of everything below (set by buildShiftPacket)
  identity: { date: string; role: ShiftRole; eventLabel: string | null };
  reporting: {
    reportTime: string | null;
    reportLocation: string | null;
    startTime: string | null;
    endTime: string | null;
    windowKnown: boolean;
    mapUrl: string | null;
  };
  assignment: {
    workerKind: "internal" | "instawork";
    displayName: string;
    truck: { id: string; name: string } | null;
    supervisor: { name: string; phone?: string | null } | null;
    coworkers: string[];
  };
  operations: { route: { stops: number; firstStop: string | null } | null; equipment: string[]; instructions: string | null };
  timekeeping: WorkerTimekeeping;
  dispatch: { phone: string };
}

/** The structured context the caller assembles from the DB (truck, supervisor, route, coworkers). */
export interface PacketContext {
  truck: { id: string; name: string } | null;
  supervisor: { name: string; phone?: string | null } | null;
  coworkers: string[];
  route: { stops: number; firstStop: string | null } | null;
  mapUrl: string | null;
  equipment: string[];
}

// Honest, per-worker-type timekeeping copy. Internal: Connecteam owns the clock. Instawork: Instawork
// owns it and we have no captured clock surface, so we say so plainly rather than imply a Zoe clock.
const TIMEKEEPING: Record<"internal" | "instawork", WorkerTimekeeping> = {
  internal: { kind: "internal", system: "connecteam", howTo: "Clock in and out on the Connecteam app at your report time." },
  instawork: { kind: "instawork", system: "instawork", howTo: "Clock in through the Instawork app. Zoe cannot clock you in." },
};

/** Stable JSON (sorted keys) so the version hash is deterministic regardless of property order. */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const obj = v as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/** Build the versioned packet for one worker on a shift, purely from structured data. */
export function buildShiftPacket(shift: StaffShift, assignment: ShiftAssignment, ctx: PacketContext): ShiftPacket {
  const base: Omit<ShiftPacket, "version"> = {
    shiftId: shift.id,
    identity: { date: shift.date, role: shift.role, eventLabel: shift.eventLabel },
    reporting: {
      reportTime: shift.reportTime ?? (shift.windowKnown ? shift.startTime : null),
      reportLocation: shift.reportLocation ?? shift.location,
      startTime: shift.startTime,
      endTime: shift.endTime,
      windowKnown: shift.windowKnown,
      mapUrl: ctx.mapUrl,
    },
    assignment: {
      workerKind: assignment.workerKind,
      displayName: assignment.displayName ?? (assignment.instaworkWorker ?? "Worker"),
      truck: ctx.truck,
      supervisor: ctx.supervisor,
      coworkers: ctx.coworkers,
    },
    operations: { route: ctx.route, equipment: ctx.equipment.length ? ctx.equipment : shift.equipment, instructions: shift.instructions },
    timekeeping: TIMEKEEPING[assignment.workerKind],
    dispatch: { phone: ZOE_DISPATCH_PHONE },
  };
  const version = createHash("sha1").update(stableStringify(base)).digest("hex").slice(0, 12);
  return { ...base, version };
}

/**
 * Persist the packet, versioned. A new row is written ONLY when the content hash is new (UNIQUE dedup),
 * so a rebuild with no change reuses the same version. Returns the version. This records WHAT the packet
 * is, independently of whether it was sent (sending sets packet_sent_at on the assignment).
 */
export function saveShiftPacket(packet: ShiftPacket): string {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO shift_packets (id, shift_id, version, packet_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(`SP-${packet.shiftId}-${packet.version}`, packet.shiftId, packet.version, JSON.stringify(packet), new Date().toISOString());
  return packet.version;
}

/** The persisted packet for a shift+version, if any. */
export function getShiftPacket(shiftId: string, version: string): ShiftPacket | null {
  const r = getDb().prepare("SELECT packet_json FROM shift_packets WHERE shift_id = ? AND version = ?").get(shiftId, version) as
    | { packet_json: string }
    | undefined;
  if (!r) return null;
  try {
    return JSON.parse(r.packet_json) as ShiftPacket;
  } catch {
    return null;
  }
}
