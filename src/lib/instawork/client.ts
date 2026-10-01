// Instawork read boundary (server-only). The ONE place the platform talks to Instawork. Reads the
// business dashboard's internal API (verified live 2026-09-30):
//   GET https://app.instawork.com/api/partner/gigs/groups/?timeframe=&page=&page_size=
//   → { results: [{ id, name, starts_at, ends_at, timezone, position_name, base_price,
//        filled_shifts_count, total_shifts_count, location_name, shifts:[{worker_name}], ... }], meta }
// Auth is the logged-in SESSION COOKIE (same-origin in the browser). Server-side we replay it with a
// stored cookie secret. RUNTIME NOTE: whether Fly (a datacenter IP) can reach this without a block is
// the one thing still to confirm live — if it can, this runs fully server-side (no machine/Chrome). If
// blocked, the same parser is driven from a logged-in browser pull instead. Either way: HONEST — no
// cookie → not_configured (no call); a failed/empty response → ok:false (UNVERIFIED), never fabricated.

import { getSecret } from "@/lib/secrets";
import { logImport } from "@/lib/pull/state";
import type { InstaworkResult, InstaworkShift } from "./types";

const BASE = (process.env.INSTAWORK_BASE_URL || "https://app.instawork.com").replace(/\/$/, "");
const SECRET_KEY = "instawork.cookie";
const TIMEOUT_MS = 12_000;

/** The Instawork session cookie, or null. Secret store wins, then env. Never returned to the browser. */
function instaworkCookie(): string | null {
  return getSecret(SECRET_KEY) || process.env.INSTAWORK_COOKIE || null;
}

export function instaworkConfigured(): boolean {
  return instaworkCookie() !== null;
}

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Map one raw gig-group row to our shape (defensive — Instawork may add/rename fields). */
function toShift(r: Record<string, unknown>): InstaworkShift | null {
  const id = r.id != null ? String(r.id) : null;
  const startsAt = typeof r.starts_at === "string" ? r.starts_at : null;
  const endsAt = typeof r.ends_at === "string" ? r.ends_at : null;
  if (!id || !startsAt || !endsAt) return null;
  const workers = Array.isArray(r.shifts)
    ? (r.shifts as Array<Record<string, unknown>>).map((s) => String(s.worker_name ?? "")).filter(Boolean)
    : [];
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
    interestedPending: num(r.interested_pros_pending_count) ?? 0,
  };
}

/**
 * Pull Instawork shift groups for a timeframe. Never throws. Reports ok ONLY when Instawork actually
 * returned results; no cookie → not_configured; any failure → ok:false (unverified).
 */
export async function getInstaworkShifts(timeframe = "in_progress_upcoming"): Promise<InstaworkResult> {
  const fetchedAt = new Date().toISOString();
  const cookie = instaworkCookie();
  if (!cookie) return { ok: false, status: "not_configured", shifts: [], fetchedAt };

  const url = `${BASE}/api/partner/gigs/groups/?timeframe=${encodeURIComponent(timeframe)}&page=1&page_size=100`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { cookie, accept: "application/json" },
      cache: "no-store",
      signal: ctrl.signal,
    });
    if (!res.ok) {
      logImport("instawork", false, { detail: `HTTP ${res.status}` });
      return { ok: false, status: "error", shifts: [], error: `HTTP ${res.status}`, fetchedAt };
    }
    const json = (await res.json().catch(() => null)) as { results?: unknown } | null;
    const rows = Array.isArray(json?.results) ? (json!.results as Array<Record<string, unknown>>) : [];
    const shifts = rows.map(toShift).filter((s): s is InstaworkShift => s !== null);
    logImport("instawork", true, { detail: `${shifts.length} shifts` });
    return { ok: true, status: "ok", shifts, fetchedAt };
  } catch (e) {
    const error = e instanceof Error && e.name === "AbortError" ? "timeout" : "network error";
    logImport("instawork", false, { detail: error });
    return { ok: false, status: "error", shifts: [], error, fetchedAt };
  } finally {
    clearTimeout(t);
  }
}
