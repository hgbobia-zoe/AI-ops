// Stuck tracking links: the alert the "Ignition signed out" check misses.
//
// The office Ignition tab can check in (so the session looks healthy) while the links it should be making
// sit in the queue for hours: a backgrounded or sleeping tab, a frozen page, a mint that never posts back.
// When that happens the "on the way" text goes out with the basic /track page instead of the live map, and
// nothing warns anyone. This watches the GROUND TRUTH instead of the heartbeat: how long current pending
// mint requests have been waiting. Gates close only on that real condition (the queue drains), never on a
// check-in.
//
// Pure decision helpers first (tested), then the small DB wrapper the pre-mint tick calls.

import { getDb } from "@/lib/db";
import { statusText, type StatusAlert } from "@/lib/notify/status";

/** A pending mint request that still matters (made within 12h and its window hasn't ended). */
export interface PendingMint {
  id: string;
  truckLabel: string | null;
  createdAt: string; // ISO
}

export interface MintBacklog {
  stuck: number; // pending longer than the threshold
  oldestMin: number | null; // age of the oldest stuck request, minutes
  byTruck: Record<string, number>;
}

/** Minutes a pending link may wait before it counts as stuck. The extension polls every 15s, so a healthy
 *  session clears a request in well under a minute; 20 minutes is unambiguous. */
export function stuckThresholdMin(): number {
  const n = Number(process.env.ETA_MINT_STUCK_MIN);
  return Number.isFinite(n) && n > 0 ? n : 20;
}

/** Summarize the pending queue into what is stuck. Pure. */
export function assessMintBacklog(rows: PendingMint[], nowMs: number, thresholdMin: number): MintBacklog {
  let stuck = 0;
  let oldestMin: number | null = null;
  const byTruck: Record<string, number> = {};
  for (const r of rows) {
    const created = Date.parse(r.createdAt);
    if (!Number.isFinite(created)) continue;
    const ageMin = (nowMs - created) / 60000;
    if (ageMin < thresholdMin) continue;
    stuck += 1;
    oldestMin = oldestMin == null ? ageMin : Math.max(oldestMin, ageMin);
    const truck = (r.truckLabel ?? "").trim() || "truck";
    byTruck[truck] = (byTruck[truck] ?? 0) + 1;
  }
  return { stuck, oldestMin: oldestMin == null ? null : Math.round(oldestMin), byTruck };
}

/** Is this an hour the team would act on an alert? 6am to 9pm in the ops timezone. Pure. */
export function isOpsAlertHour(now: Date, tz: string = process.env.ETA_TIMEZONE || "America/New_York"): boolean {
  const h = Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hourCycle: "h23" }).format(now));
  return h >= 6 && h < 21;
}

function fmtAge(min: number): string {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** The status card for a stuck queue. No dashes, no emoji (house comms style). Pure. */
export function stuckMintAlert(b: MintBacklog, nowMs: number = Date.now()): StatusAlert {
  const n = b.stuck;
  const trucks = Object.entries(b.byTruck)
    .sort((a, z) => z[1] - a[1])
    .map(([t, c]) => `${t}: ${c}`)
    .join(", ");
  return {
    system: "Ignition",
    level: "degraded",
    title: `${n} customer tracking ${n === 1 ? "link has" : "links have"} been stuck in Ignition for ${fmtAge(b.oldestMin ?? 0)}`,
    impact: "On the way texts send the basic tracking page instead of the live truck map until these are made.",
    fix: "On the office computer, open the ignition.zonarsystems.com tab, reload it, and keep it signed in.",
    since: b.oldestMin != null ? new Date(nowMs - b.oldestMin * 60_000).toISOString() : null,
    detail: trucks ? `Waiting by truck: ${trucks}` : null,
  };
}

/** Kept for callers and tests that want the plain text. */
export function stuckMintAlertText(b: MintBacklog): string {
  return statusText(stuckMintAlert(b));
}

export const MINT_BACKLOG_RECOVERED: StatusAlert = {
  system: "Ignition",
  level: "recovered",
  title: "Tracking links are being made again",
  impact: "Ignition caught up on the waiting links. Customers get the live truck map again.",
};
export const MINT_BACKLOG_RECOVERED_TEXT = statusText(MINT_BACKLOG_RECOVERED);

export interface BacklogAlertState {
  alertedAt?: string; // ISO we last alerted a stuck queue (cool-off dedup); cleared when the queue drains
}

/**
 * Decide what to post. Pure.
 *   • queue drained (nothing stuck) → one "recovered" note, only if we had alerted.
 *   • stuck → alert, unless the "signed out" alert already covers it, it's outside ops hours, or we
 *     alerted within the cool-off.
 */
export function decideMintBacklogAlert(opts: {
  backlog: MintBacklog;
  state: BacklogAlertState;
  signedOutAlertCovers: boolean;
  opsHour: boolean;
  nowMs: number;
  cooloffMs: number;
}): { post: "stuck" | "recovered" | null; next: BacklogAlertState } {
  const { backlog, state } = opts;
  if (backlog.stuck === 0) {
    return state.alertedAt ? { post: "recovered", next: {} } : { post: null, next: state };
  }
  if (opts.signedOutAlertCovers || !opts.opsHour) return { post: null, next: state };
  const alertedAgo = state.alertedAt ? opts.nowMs - Date.parse(state.alertedAt) : Infinity;
  if (alertedAgo <= opts.cooloffMs) return { post: null, next: state };
  return { post: "stuck", next: { alertedAt: new Date(opts.nowMs).toISOString() } };
}

// ── DB wrapper ──────────────────────────────────────────────────────────────────────────────────────

const STATE_KEY = "eta_mint_backlog";
const COOLOFF_MS = 2 * 60 * 60 * 1000;

/** Current pending mint requests (same "still matters" rule the enqueue/reuse path uses). */
export function listCurrentPendingMints(nowMs: number = Date.now()): PendingMint[] {
  const nowISO = new Date(nowMs).toISOString();
  const cutoff = new Date(nowMs - 12 * 3600 * 1000).toISOString();
  const rows = getDb()
    .prepare(
      "SELECT id, truck_label, created_at FROM eta_links WHERE status = 'pending' AND created_at > ? AND (end_iso IS NULL OR end_iso > ?)",
    )
    .all(cutoff, nowISO) as { id: string; truck_label: string | null; created_at: string }[];
  return rows.map((r) => ({ id: r.id, truckLabel: r.truck_label, createdAt: r.created_at }));
}

/** The stuck part of the queue right now (also feeds the Connections dot). */
export function currentMintBacklog(nowMs: number = Date.now()): MintBacklog {
  return assessMintBacklog(listCurrentPendingMints(nowMs), nowMs, stuckThresholdMin());
}

function loadState(): BacklogAlertState {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(STATE_KEY) as { value: string } | undefined;
  if (!row) return {};
  try {
    return JSON.parse(row.value) as BacklogAlertState;
  } catch {
    return {};
  }
}

function saveState(s: BacklogAlertState): void {
  getDb()
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(STATE_KEY, JSON.stringify(s), new Date().toISOString());
}

/** Check the queue, update the dedup state, and return the status card to post (or null). Never throws. */
export function checkMintBacklog(opts: { signedOutAlertCovers: boolean; now?: Date }): { backlog: MintBacklog; alert: StatusAlert | null } {
  const now = opts.now ?? new Date();
  try {
    const backlog = currentMintBacklog(now.getTime());
    const state = loadState();
    const { post, next } = decideMintBacklogAlert({
      backlog,
      state,
      signedOutAlertCovers: opts.signedOutAlertCovers,
      opsHour: isOpsAlertHour(now),
      nowMs: now.getTime(),
      cooloffMs: COOLOFF_MS,
    });
    if (next !== state) saveState(next);
    const alert = post === "stuck" ? stuckMintAlert(backlog, now.getTime()) : post === "recovered" ? MINT_BACKLOG_RECOVERED : null;
    return { backlog, alert };
  } catch {
    return { backlog: { stuck: 0, oldestMin: null, byTruck: {} }, alert: null };
  }
}
