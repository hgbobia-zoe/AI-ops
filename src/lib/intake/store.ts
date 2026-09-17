// Guided Sales Intake — persistence. One row per call in sales_intake. Deterministic capture; no AI.
// Server-only (uses getDb).

import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";
import type { Intake, IntakePatch, AccessNotes } from "./types";

interface Row {
  id: string;
  status: string;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  source: string | null;
  call_id: string | null;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  email: string | null;
  customer_type: string | null;
  event_type: string | null;
  event_type_other: string | null;
  guest_count: number | null;
  guest_count_unknown: number | null;
  event_date: string | null;
  event_start_time: string | null;
  event_end_time: string | null;
  venue_name: string | null;
  street_address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  location_type: string | null;
  delivery_required: string | null;
  delivery_flexible: string | null;
  delivery_tier: string | null;
  setup_required: string | null;
  pickup_required: string | null;
  access_notes: string | null;
  logistics_notes: string | null;
  sales_notes: string | null;
  gs_contact_id: string | null;
  gs_project_id: string | null;
  gs_project_url: string | null;
  gs_status: string | null;
  gs_error: string | null;
  completed_at: string | null;
}

function parseAccess(s: string | null): AccessNotes {
  if (!s) return {};
  try {
    return JSON.parse(s) as AccessNotes;
  } catch {
    return {};
  }
}

function toIntake(r: Row): Intake {
  return {
    id: r.id,
    status: (r.status as Intake["status"]) ?? "draft",
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    createdBy: r.created_by,
    source: r.source,
    callId: r.call_id,
    firstName: r.first_name ?? "",
    lastName: r.last_name ?? "",
    phone: r.phone ?? "",
    email: r.email ?? "",
    customerType: (r.customer_type as Intake["customerType"]) ?? "",
    eventType: (r.event_type as Intake["eventType"]) ?? "",
    eventTypeOther: r.event_type_other ?? "",
    guestCount: r.guest_count ?? null,
    guestCountUnknown: Number(r.guest_count_unknown) === 1,
    eventDate: r.event_date ?? "",
    eventStartTime: r.event_start_time ?? "",
    eventEndTime: r.event_end_time ?? "",
    venueName: r.venue_name ?? "",
    streetAddress: r.street_address ?? "",
    city: r.city ?? "",
    state: r.state ?? "",
    zip: r.zip ?? "",
    locationType: (r.location_type as Intake["locationType"]) ?? "",
    deliveryRequired: (r.delivery_required as Intake["deliveryRequired"]) ?? "",
    deliveryFlexible: (r.delivery_flexible as Intake["deliveryFlexible"]) ?? "",
    deliveryTier: (r.delivery_tier as Intake["deliveryTier"]) ?? "",
    setupRequired: (r.setup_required as Intake["setupRequired"]) ?? "",
    pickupRequired: (r.pickup_required as Intake["pickupRequired"]) ?? "",
    accessNotes: parseAccess(r.access_notes),
    logisticsNotes: r.logistics_notes ?? "",
    salesNotes: r.sales_notes ?? "",
    gsContactId: r.gs_contact_id,
    gsProjectId: r.gs_project_id,
    gsProjectUrl: r.gs_project_url,
    gsStatus: (r.gs_status as Intake["gsStatus"]) ?? "",
    gsError: r.gs_error,
    completedAt: r.completed_at,
  };
}

// Patch key → column + encoder. Only these fields are updatable (no arbitrary columns).
const COLS: { [K in keyof IntakePatch]-?: { col: string; enc?: (v: NonNullable<IntakePatch[K]>) => unknown } } = {
  status: { col: "status" },
  createdBy: { col: "created_by" },
  source: { col: "source" },
  callId: { col: "call_id" },
  firstName: { col: "first_name" },
  lastName: { col: "last_name" },
  phone: { col: "phone" },
  email: { col: "email" },
  customerType: { col: "customer_type" },
  eventType: { col: "event_type" },
  eventTypeOther: { col: "event_type_other" },
  guestCount: { col: "guest_count" },
  guestCountUnknown: { col: "guest_count_unknown", enc: (v) => (v ? 1 : 0) },
  eventDate: { col: "event_date" },
  eventStartTime: { col: "event_start_time" },
  eventEndTime: { col: "event_end_time" },
  venueName: { col: "venue_name" },
  streetAddress: { col: "street_address" },
  city: { col: "city" },
  state: { col: "state" },
  zip: { col: "zip" },
  locationType: { col: "location_type" },
  deliveryRequired: { col: "delivery_required" },
  deliveryFlexible: { col: "delivery_flexible" },
  deliveryTier: { col: "delivery_tier" },
  setupRequired: { col: "setup_required" },
  pickupRequired: { col: "pickup_required" },
  accessNotes: { col: "access_notes", enc: (v) => JSON.stringify(v) },
  logisticsNotes: { col: "logistics_notes" },
  salesNotes: { col: "sales_notes" },
  gsContactId: { col: "gs_contact_id" },
  gsProjectId: { col: "gs_project_id" },
  gsProjectUrl: { col: "gs_project_url" },
  gsStatus: { col: "gs_status" },
  gsError: { col: "gs_error" },
  completedAt: { col: "completed_at" },
};

export function createIntake(input: { createdBy?: string | null; source?: string | null; callId?: string | null } & IntakePatch = {}): Intake {
  const now = new Date().toISOString();
  const id = `INTK-${randomUUID()}`;
  getDb()
    .prepare("INSERT INTO sales_intake (id, status, created_at, updated_at, created_by, source, call_id) VALUES (?, 'draft', ?, ?, ?, ?, ?)")
    .run(id, now, now, input.createdBy ?? null, input.source ?? null, input.callId ?? null);
  const { createdBy: _cb, source: _s, callId: _c, ...rest } = input;
  void _cb; void _s; void _c;
  if (Object.keys(rest).length) updateIntake(id, rest);
  return getIntake(id)!;
}

export function getIntake(id: string): Intake | null {
  const r = getDb().prepare("SELECT * FROM sales_intake WHERE id = ?").get(id) as Row | undefined;
  return r ? toIntake(r) : null;
}

/** Update only the provided fields (autosave). Whitelisted columns; touches updated_at. */
export function updateIntake(id: string, patch: IntakePatch): Intake | null {
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(patch) as [keyof IntakePatch, unknown][]) {
    const spec = COLS[k];
    if (!spec) continue;
    sets.push(`${spec.col} = ?`);
    vals.push(v == null ? null : spec.enc ? spec.enc(v as never) : v);
  }
  if (sets.length === 0) return getIntake(id);
  sets.push("updated_at = ?");
  vals.push(new Date().toISOString());
  vals.push(id);
  const info = getDb().prepare(`UPDATE sales_intake SET ${sets.join(", ")} WHERE id = ?`).run(...(vals as never[]));
  return info.changes ? getIntake(id) : null;
}

export function listRecentIntakes(limit = 50): Intake[] {
  return (getDb().prepare("SELECT * FROM sales_intake ORDER BY created_at DESC LIMIT ?").all(limit) as Row[]).map(toIntake);
}
