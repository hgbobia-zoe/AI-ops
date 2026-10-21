// In-process runtime clock — runs the server-job bucket on a reliable in-app timer.
//
// WHY: all server-side scheduled work runs via runServerJobs() (the SAME function /api/runtime/tick
// calls). That was driven only by a GitHub Actions cron set to every 15 min, but GitHub throttles
// scheduled workflows and actually fires them only ~every few hours — so debrief sends, the sales-AI,
// the OpenPhone text sync, Instawork, payroll, outbox-health, action-item detection, etc. all lagged.
// Since the Fly machine is always-on (fly.toml: auto_stop_machines = "off", min_machines_running = 1),
// we run the clock INSIDE the app on a dependable 15-minute timer.
//
// The GitHub Actions cron and /api/runtime/tick are left intact as a harmless backstop — the jobs are
// idempotent, so the in-process clock and an occasional external tick firing together have no
// double-effect. Belt-and-suspenders.
//
// CORRECTNESS CAVEAT (single machine today → exactly one in-process clock): during a rolling deploy two
// machines can briefly overlap and both tick. That is SAFE because runServerJobs' jobs are idempotent —
// the same guarantee the external cron already relied on. If min_machines_running is ever raised above 1,
// disable this (RUNTIME_IN_PROCESS_CLOCK=false) or add a leader lock before relying on it. Not built now.

import { runServerJobs } from "@/lib/runtime/jobs";

const DEFAULT_INTERVAL_MIN = 15;
const MIN_INTERVAL_MIN = 1; // clamp floor: never tick more often than once a minute
const FIRST_RUN_DELAY_MS = 30_000; // let the app settle before the first run

// Module-level state. One process → one clock; these guard against duplicate arming and overlapping runs.
let started = false; // idempotent-arming guard: a second startRuntimeClock() is a no-op
let running = false; // single-flight guard: a tick while a run is in flight is skipped, not queued
let firstTimer: ReturnType<typeof setTimeout> | null = null;
let intervalTimer: ReturnType<typeof setInterval> | null = null;

/** Whether the in-process clock is enabled. Default ON; set RUNTIME_IN_PROCESS_CLOCK=false to disable. */
export function clockEnabled(): boolean {
  return process.env.RUNTIME_IN_PROCESS_CLOCK !== "false";
}

/** Only arm inside the Node.js server runtime — never edge, never during build. */
function inNodeRuntime(): boolean {
  return process.env.NEXT_RUNTIME === "nodejs";
}

/**
 * Resolve the tick interval (minutes) from RUNTIME_TICK_INTERVAL_MIN, falling back to 15 and clamping to a
 * sane floor so a misconfigured value can't hammer the box. Pure given the env.
 */
export function resolveIntervalMin(): number {
  const raw = process.env.RUNTIME_TICK_INTERVAL_MIN;
  const n = raw != null && raw.trim() !== "" ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return DEFAULT_INTERVAL_MIN;
  return Math.max(MIN_INTERVAL_MIN, Math.floor(n));
}

/**
 * Run one tick: single-flight-guarded, never-throwing, with a concise per-tick log. Exported for tests.
 * If a previous run is still in flight it is skipped (not queued), so a slow run can't stack up ticks.
 */
export async function tick(): Promise<void> {
  if (running) {
    console.log("[runtime-clock] previous run still in flight — skipping this tick");
    return;
  }
  running = true;
  const t = Date.now();
  try {
    const results = await runServerJobs();
    const ok = results.filter((r) => r.ok).length;
    const bad = results.length - ok;
    console.log(
      `[runtime-clock] tick ran ${results.length} job(s) (${ok} ok${bad ? `, ${bad} failed` : ""}) in ${Date.now() - t}ms`,
    );
  } catch (e) {
    // A job failure must never stop the timer or crash the process.
    console.error(`[runtime-clock] tick threw after ${Date.now() - t}ms (ignored):`, e instanceof Error ? e.message : e);
  } finally {
    running = false;
  }
}

/**
 * Arm the in-process clock: a first run shortly after boot, then one every interval (default 15 min).
 * Idempotent — calling it more than once never creates duplicate timers. A no-op when disabled by flag or
 * when not in the Node.js server runtime.
 */
export function startRuntimeClock(): void {
  if (started) return; // idempotent: already armed
  if (!clockEnabled()) {
    console.log("[runtime-clock] disabled (RUNTIME_IN_PROCESS_CLOCK=false) — not arming");
    return;
  }
  if (!inNodeRuntime()) return; // edge/build: never arm

  started = true;
  const intervalMin = resolveIntervalMin();
  const intervalMs = intervalMin * 60_000;

  // First run ~30s after boot so the app settles, then every interval.
  firstTimer = setTimeout(() => void tick(), FIRST_RUN_DELAY_MS);
  intervalTimer = setInterval(() => void tick(), intervalMs);

  console.log(`[runtime-clock] armed: first run in ${FIRST_RUN_DELAY_MS / 1000}s, then every ${intervalMin}m`);
}

/** Test-only: clear timers and reset the module guards so each test starts from a clean slate. */
export function __resetRuntimeClockForTest(): void {
  if (firstTimer) clearTimeout(firstTimer);
  if (intervalTimer) clearInterval(intervalTimer);
  firstTimer = null;
  intervalTimer = null;
  started = false;
  running = false;
}
