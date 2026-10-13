// AI Control Plane — responder health. The office-machine responder (the Claude Code session running the
// /loop prompt) heartbeats the bridge every cycle (~60s), which `setBridgeConnected()` stamps under the kv
// key `ai.bridge.connected` as `{ connected, at: <ISO> }`. So the LAST HEARTBEAT TIME already exists; this
// module just READS that same key (it never changes provider.ts logic) and turns the age into a simple
// alive | stale | never verdict, plus the alert-dedupe deciders for the two fail-loud paths:
//   • reactive  — fired from /api/slack/events when a Viktor message lands while the responder is down;
//                 a short cool-off so a burst of Slack messages doesn't spam the ops channel.
//   • proactive — the `responder-health` runtime job; a ~2h cool-off with a one-shot "recovered" note,
//                 mirroring recordInstaworkProbe / recordPreCheckAlert exactly.
//
// The pure functions (responderHealth, decideReactiveAlert, decideJobAlert) take their inputs and `now`
// explicitly, so they are unit-tested with no DB and no clock. The kv-backed wrappers are the thin glue.

import { getJson, setJson } from "@/lib/kv";

// The SAME key provider.ts writes on heartbeat (BRIDGE_CONNECTED_KEY). Duplicated as a literal on purpose:
// this module must not import provider.ts (keeps the read side free of the provider's registry), and the
// key is a stable storage contract, not logic.
const BRIDGE_CONNECTED_KEY = "ai.bridge.connected";

/** Dedupe bookkeeping for the two alert paths, in one namespaced kv row (settings table, no migration). */
const ALERT_KEY = "ai.responder.alert";

/** Staleness threshold. Cadence is ~60s, so this tolerates ~3 missed beats before we call the responder
 *  down — long enough that one slow cycle never false-alarms, short enough to notice within a few minutes. */
export const RESPONDER_STALE_MS = 3.5 * 60 * 1000; // 3.5 minutes

/** Short cool-off for the REACTIVE (Slack-triggered) alert, so a burst of inbound messages while the
 *  responder is down produces at most one ping per window. */
export const RESPONDER_REACTIVE_COOLOFF_MS = 10 * 60 * 1000; // 10 minutes

/** Cool-off for the PROACTIVE (runtime-job) alert — matches the other alert producers' 2h window. */
export const RESPONDER_JOB_COOLOFF_MS = 2 * 60 * 60 * 1000; // 2 hours

export type ResponderState = "alive" | "stale" | "never";

export interface ResponderHealth {
  state: ResponderState;
  /** True only when the bridge reported connected AND the heartbeat is within the threshold. */
  alive: boolean;
  /** Age of the last heartbeat in ms, or null when there has never been one. */
  ageMs: number | null;
  /** ISO of the last heartbeat, or null. */
  lastHeartbeatAt: string | null;
}

/** The persisted heartbeat record shape (as provider.setBridgeConnected writes it). */
export interface BridgeRecord {
  connected?: boolean;
  at?: string;
}

/** PURE. Turn a heartbeat record + now into an alive | stale | never verdict. A missing record (or missing
 *  timestamp) is `never`; an explicit `connected:false` is `stale` regardless of age (the responder told us
 *  it is going down); otherwise alive iff the heartbeat is within the threshold. */
export function responderHealth(
  record: BridgeRecord | null | undefined,
  now: number,
  thresholdMs: number = RESPONDER_STALE_MS,
): ResponderHealth {
  const at = record?.at;
  if (!at) return { state: "never", alive: false, ageMs: null, lastHeartbeatAt: null };
  const parsed = Date.parse(at);
  if (!Number.isFinite(parsed)) return { state: "never", alive: false, ageMs: null, lastHeartbeatAt: null };
  const ageMs = now - parsed;
  if (record?.connected === false) return { state: "stale", alive: false, ageMs, lastHeartbeatAt: at };
  const alive = ageMs <= thresholdMs;
  return { state: alive ? "alive" : "stale", alive, ageMs, lastHeartbeatAt: at };
}

/** Read the live heartbeat record from kv (the same key provider.ts writes). */
export function readBridgeRecord(): BridgeRecord {
  return getJson<BridgeRecord>(BRIDGE_CONNECTED_KEY, {});
}

/** The last time the responder heartbeated, or null if never. */
export function responderLastHeartbeatAt(): string | null {
  return readBridgeRecord().at ?? null;
}

/** Live health verdict from kv. */
export function responderHealthNow(now: number = Date.now(), thresholdMs: number = RESPONDER_STALE_MS): ResponderHealth {
  return responderHealth(readBridgeRecord(), now, thresholdMs);
}

/** Human age string for alert copy: "90s", "4m", "2h" etc. PURE. */
export function formatAge(ageMs: number | null): string {
  if (ageMs == null) return "never";
  const s = Math.max(0, Math.round(ageMs / 1000));
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  return `${Math.round(m / 60)}h`;
}

// ── Reactive alert dedupe (short cool-off) ───────────────────────────────────────
interface ReactiveRecord {
  lastAlertedAt?: string;
}

/** PURE. Alert iff we have never alerted, or the cool-off has elapsed since the last reactive alert. */
export function decideReactiveAlert(
  prev: ReactiveRecord | undefined,
  now: number,
  cooloffMs: number = RESPONDER_REACTIVE_COOLOFF_MS,
): { alert: boolean; next: ReactiveRecord } {
  const agoMs = prev?.lastAlertedAt ? now - Date.parse(prev.lastAlertedAt) : Infinity;
  if (agoMs > cooloffMs) return { alert: true, next: { lastAlertedAt: new Date(now).toISOString() } };
  return { alert: false, next: { lastAlertedAt: prev?.lastAlertedAt } };
}

interface AlertState {
  reactive?: ReactiveRecord;
  job?: JobAlertRecord;
}

/** Apply decideReactiveAlert against the persisted store; returns whether to Slack now. */
export function recordReactiveAlert(now: number = Date.now(), cooloffMs: number = RESPONDER_REACTIVE_COOLOFF_MS): { alert: boolean } {
  const s = getJson<AlertState>(ALERT_KEY, {});
  const { alert, next } = decideReactiveAlert(s.reactive, now, cooloffMs);
  s.reactive = next;
  setJson(ALERT_KEY, s);
  return { alert };
}

// ── Proactive (runtime-job) alert dedupe (2h cool-off + recovered note) ──────────
interface JobAlertRecord {
  firstDownAt?: string;
  lastAlertedAt?: string;
}

/** PURE. The runtime-job decision, mirroring recordInstaworkProbe/recordPreCheckAlert:
 *    • down  → alert when never alerted, OR the cool-off has elapsed. Otherwise stay quiet (keep the clock).
 *    • up    → emit ONE "recovered" note iff we had alerted; then forget the record. */
export function decideJobAlert(
  prev: JobAlertRecord | undefined,
  down: boolean,
  now: number,
  cooloffMs: number = RESPONDER_JOB_COOLOFF_MS,
): { alert: "down" | "recovered" | null; next: JobAlertRecord | undefined } {
  if (!down) {
    const alert = prev?.lastAlertedAt ? "recovered" : null;
    return { alert, next: undefined };
  }
  const firstDownAt = prev?.firstDownAt ?? new Date(now).toISOString();
  const agoMs = prev?.lastAlertedAt ? now - Date.parse(prev.lastAlertedAt) : Infinity;
  const shouldAlert = prev?.lastAlertedAt == null || agoMs > cooloffMs;
  if (!shouldAlert) return { alert: null, next: { firstDownAt, lastAlertedAt: prev?.lastAlertedAt } };
  return { alert: "down", next: { firstDownAt, lastAlertedAt: new Date(now).toISOString() } };
}

/** Apply decideJobAlert against the persisted store; returns the decision. The caller does the Slack post. */
export function recordJobAlert(down: boolean, now: number = Date.now(), cooloffMs: number = RESPONDER_JOB_COOLOFF_MS): { alert: "down" | "recovered" | null } {
  const s = getJson<AlertState>(ALERT_KEY, {});
  const { alert, next } = decideJobAlert(s.job, down, now, cooloffMs);
  if (next) s.job = next;
  else delete s.job;
  setJson(ALERT_KEY, s);
  return { alert };
}
