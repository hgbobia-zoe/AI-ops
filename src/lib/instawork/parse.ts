// Instawork row parser — maps one raw gig-group row (GET /api/partner/gigs/groups/) to our shape.
// Extracted so BOTH the browser-pull ingest endpoint and any server reader reuse the exact same logic.
// Defensive: Instawork may add/rename fields; unknown numbers stay null, never 0 (FACTS ONLY).

import type { InstaworkShift } from "./types";

export function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Map one raw gig-group row to our shape, or null when it lacks the required id/window fields. */
export function toShift(r: Record<string, unknown>): InstaworkShift | null {
  const id = r.id != null ? String(r.id) : null;
  const startsAt = typeof r.starts_at === "string" ? r.starts_at : null;
  const endsAt = typeof r.ends_at === "string" ? r.ends_at : null;
  if (!id || !startsAt || !endsAt) return null;
  const rows = Array.isArray(r.shifts) ? (r.shifts as Array<Record<string, unknown>>) : [];
  const workers = rows.map((s) => String(s.worker_name ?? "")).filter(Boolean);
  const workerIds = rows.map((s) => (s.worker_id != null ? String(s.worker_id) : "")).filter(Boolean);
  const code = (v: unknown): string | null => (v != null && String(v).trim() ? String(v).trim() : null);
  return {
    id,
    name: String(r.name ?? ""),
    startsAt,
    endsAt,
    timezone: String(r.timezone ?? "America/New_York"),
    position: String(r.position_name ?? ""),
    basePrice: num(r.base_price),
    filled: num(r.filled_shifts_count) ?? 0,
    total: num(r.total_shifts_count) ?? 0,
    locationName: r.location_name != null ? String(r.location_name) : null,
    workers,
    workerIds,
    interestedPending: num(r.interested_pros_pending_count) ?? 0,
    clockInCode: code(r.clock_in_code),
    clockOutCode: code(r.clock_out_code),
  };
}
