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

// Per-worker-type timekeeping facts. Internal: Connecteam owns the clock (personal code). Instawork: the
// gig carries a per-gig clock-in / clock-out code; when we captured them they ride here, otherwise null
// (the worker clocks through the Instawork app). FACTS ONLY — a code we don't have stays null.
export type WorkerTimekeeping =
  | { kind: "internal"; system: "connecteam" }
  | { kind: "instawork"; system: "instawork"; clockInCode: string | null; clockOutCode: string | null };

/** One coworker on the shift: their display name + their OWN duty (so the crew list reads per-person). */
export interface PacketCoworker {
  name: string;
  role: ShiftRole;
}

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
    // supervisor stays in the packet data (readiness/exception code reads it) but never renders in a message.
    supervisor: { name: string; phone?: string | null } | null;
    coworkers: PacketCoworker[];
  };
  operations: { route: { stops: number; firstStop: string | null } | null; equipment: string[]; instructions: string | null };
  timekeeping: WorkerTimekeeping;
  dispatch: { phone: string };
}

/** The structured context the caller assembles from the DB (truck, supervisor, route, coworkers). For an
 *  Instawork worker, the matched gig's clock-in / clock-out codes (null when not captured). */
export interface PacketContext {
  truck: { id: string; name: string } | null;
  supervisor: { name: string; phone?: string | null } | null;
  coworkers: PacketCoworker[];
  route: { stops: number; firstStop: string | null } | null;
  mapUrl: string | null;
  equipment: string[];
  clockInCode?: string | null;
  clockOutCode?: string | null;
}

// Build the honest timekeeping fact for a worker. Internal → Connecteam. Instawork → the gig's codes if
// captured, else null (templates then fall back to "clock in/out through the Instawork app").
function timekeepingFor(workerKind: "internal" | "instawork", ctx: PacketContext): WorkerTimekeeping {
  if (workerKind === "internal") return { kind: "internal", system: "connecteam" };
  return { kind: "instawork", system: "instawork", clockInCode: ctx.clockInCode ?? null, clockOutCode: ctx.clockOutCode ?? null };
}

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
    // The worker's OWN duty, not the shift's role — a shift can carry a driver + helpers on different duties.
    identity: { date: shift.date, role: assignment.role, eventLabel: shift.eventLabel },
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
    timekeeping: timekeepingFor(assignment.workerKind, ctx),
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
