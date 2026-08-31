// Ops failure alerts → Slack. When an integration call fails (SMS API error, GPS
// TrackIt / maps down, an unexpected exception in the fan-out), post a distinct
// alert to the ops Slack channel so a human notices. These failures are invisible
// on the driver's tablet — a silent SMS failure just means a customer never got
// their "on the way" text — so surfacing them is the whole point.
//
// Guardrails:
//   • Never throws — a broken alert must not break the caller.
//   • Never recurses on Slack's own failure — falls back to console (no alert loop).
//   • Throttled — identical failures collapse to one Slack post per window, so ETA
//     polling can't spam the channel when GPS TrackIt is down.

import { slackNotify } from "./slack";

const WINDOW_MS = Number(process.env.ALERT_THROTTLE_SECONDS || 600) * 1000;
const g = globalThis as unknown as { __opsAlertSeen?: Map<string, number> };
const seen = (g.__opsAlertSeen ??= new Map<string, number>());

/**
 * Report an operational failure to Slack. Fire-and-forget: callers use `void alertOps(...)`.
 * @param where  short label for the failing integration, e.g. "SMS (Quo/OpenPhone)".
 * @param detail the specific error (status, message) — also the throttle key.
 */
export async function alertOps(where: string, detail: string): Promise<void> {
  try {
    const key = `${where}|${detail}`;
    const now = Date.now();
    const last = seen.get(key);
    if (last && now - last < WINDOW_MS) return; // already alerted recently
    seen.set(key, now);

    // Opportunistic cleanup so the map can't grow unbounded.
    if (seen.size > 200) {
      for (const [k, t] of seen) if (now - t > WINDOW_MS) seen.delete(k);
    }

    const text = `⛔ *Zoe Dispatch failure* — ${where}\n${detail}`;
    const r = await slackNotify(text);
    if (!r.ok) {
      // Don't re-alert via Slack (that's what just failed) — log locally.
      console.error(
        `[alert] ${where}: ${detail} (slack ${r.skipped ? "not configured" : r.error})`,
      );
    }
  } catch (e) {
    console.error("[alert] failed to send alert:", e);
  }
}
