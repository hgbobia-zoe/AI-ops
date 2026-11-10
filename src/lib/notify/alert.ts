// Integration failure alerts → the AI Ops status channel (src/lib/notify/status.ts). When an integration call
// fails (SMS API error, GPS TrackIt or Google Maps down or rate limited, an unexpected exception in the
// fan-out), post a short status card so a human notices. These failures are invisible on the driver's tablet
// (a silent SMS failure just means a customer never got their "on the way" text), so surfacing them is the
// whole point.
//
// Guardrails:
//   • Never throws. A broken alert must not break the caller.
//   • Never recurses on Slack's own failure. postStatus falls back to the console.
//   • Throttled per integration AND failure kind (rate limited / key rejected / not responding / failing),
//     so ETA polling can't spam the channel when GPS TrackIt is down, whatever truck or stop hit it.

import { classifyFailure, failureAlert, postStatus } from "./status";

const WINDOW_MS = Number(process.env.ALERT_THROTTLE_SECONDS || 600) * 1000;
const g = globalThis as unknown as { __opsAlertSeen?: Map<string, number> };
const seen = (g.__opsAlertSeen ??= new Map<string, number>());

/** What each integration's failure means for the business, keyed by the `where` label callers already use. */
const KNOWN: { match: RegExp; system: string; impact: string; fix?: string }[] = [
  { match: /^Google Maps \(geocode\)/i, system: "Google Maps", impact: "New addresses can't be placed on the map, so drive times and distances for them are missing." },
  { match: /^Google Maps \(directions\)/i, system: "Google Maps", impact: "Drive time ETAs and route distances can't be calculated." },
  { match: /^GPS TrackIt|Zonar/i, system: "Zonar GPS", impact: "Live truck location and live ETAs are unavailable." },
  { match: /^SMS|Quo|OpenPhone/i, system: "Quo texting", impact: "Customer texts (on the way, arrival) are not going out." },
  { match: /^Ignition etaLink/i, system: "Ignition", impact: "Customers got the basic tracking page instead of the live truck map.", fix: "Open ignition.zonarsystems.com on the office computer and make sure it is signed in." },
  { match: /^Route scrape/i, system: "Goodshuffle route scrape", impact: "The route could not be pulled automatically.", fix: "Enter the stops by hand, or run the office Auto-Pull." },
  { match: /^fan-out/i, system: "Dispatch notifications", impact: "A step after a driver action (text, Slack, Goodshuffle sync) did not finish." },
  { match: /^Opportunity Radar/i, system: "Opportunity Radar", impact: "New bids and event leads from that source are not being picked up." },
];

/**
 * Report an integration failure. Fire-and-forget: callers use `void alertOps(...)`.
 * @param where  short label for the failing integration, e.g. "SMS (Quo/OpenPhone)".
 * @param detail the specific error (status, message). Shown small and redacted.
 * @param opts   override the system name, impact, or fix when the caller knows better.
 */
export async function alertOps(where: string, detail: string, opts: { system?: string; impact?: string; fix?: string } = {}): Promise<void> {
  try {
    const kind = classifyFailure(detail);
    const key = `${where}|${kind}`;
    const now = Date.now();
    const last = seen.get(key);
    if (last && now - last < WINDOW_MS) return; // already alerted recently
    seen.set(key, now);

    // Opportunistic cleanup so the map can't grow unbounded.
    if (seen.size > 200) {
      for (const [k, t] of seen) if (now - t > WINDOW_MS) seen.delete(k);
    }

    const known = KNOWN.find((k) => k.match.test(where));
    const alert = failureAlert(opts.system ?? known?.system ?? where, detail, {
      impact: opts.impact ?? known?.impact ?? null,
      fix: opts.fix ?? known?.fix ?? null,
    });
    await postStatus(alert, now);
  } catch (e) {
    console.error("[alert] failed to send alert:", e);
  }
}
