// Ignition "live-tracking" health — PURE status + alert-gating logic (no DB). The Ignition session lives
// on the office machine: the Auto-Pull extension's Ignition content script polls /api/etalink/pending and
// stamps readiness (signed in → a mint can succeed). We INFER health from that heartbeat's freshness — no
// extension change. These pure helpers map the heartbeat (plus "are there deliveries to track today?")
// into the Connections dot and the Slack-alert decision; the DB-bound wrappers live in src/lib/pull/state.
//
// Honest by construction: we never show green when the poller isn't actually polling, and we only raise
// the "signed out" alert/dot when it MATTERS — there are upcoming same-day deliveries that need a link.
// Nothing to mint, or the feature was never used here → OFF / n-a, never a false alarm.

// The Connections dot status union (kept inline to avoid a module cycle with connections.ts, which
// imports this module's helpers). Matches ConnStatus there.
type DotStatus = "ok" | "attention" | "off";

/** Server-inferred Ignition session health, from the extension's poll heartbeat. */
export interface IgnitionHealth {
  /** The signed-in poller checked in within the freshness TTL (a mint can land right now). */
  ok: boolean;
  /** The Ignition mint path is in use here at all (the poller has EVER checked in). Gates alarms so a
   *  shop that never set up live tracking is never nagged. */
  configured: boolean;
  lastReadyAt: string | null; // last SIGNED-IN poll
  lastSeenAt: string | null; // last poll of any kind
  detail: string;
}

export interface IgnitionDot {
  status: DotStatus;
  headline: string;
  detail: string;
}

/** The sign-in prompt shown everywhere Ignition needs attention (status dot detail + Slack alert body). */
export const IGNITION_SIGNIN_HINT =
  "Sign in at ignition.zonarsystems.com on the office machine to restore live tracking.";

/** The Slack message when the office Ignition session has lapsed while deliveries still need a link. */
export const IGNITION_STALE_ALERT =
  "Ignition is signed out on the office machine — customer tracking links are falling back to the basic page. " +
  IGNITION_SIGNIN_HINT;

/** The Slack message when the session comes back (only sent if we had alerted the lapse). */
export const IGNITION_RECOVERED_ALERT = "Ignition is signed back in on the office machine — live customer tracking restored.";

/**
 * Map Ignition health + today's delivery demand into the Connections dot:
 *   • OK (green)        — the poller is fresh (signed in + polling).
 *   • ATTENTION (warn)  — stale AND there are deliveries to track today AND the feature is in use here.
 *   • OFF (idle/n-a)    — nothing to mint today, or Ignition was never used here. Never a false green.
 */
export function ignitionDotStatus(opts: {
  health: Pick<IgnitionHealth, "ok" | "configured" | "lastReadyAt">;
  hasDeliveriesToday: boolean;
}): IgnitionDot {
  const { ok, configured } = opts.health;
  if (ok) {
    return { status: "ok", headline: "Live", detail: "Signed in on the office machine — customer links are the real live map." };
  }
  if (configured && opts.hasDeliveriesToday) {
    return { status: "attention", headline: "Needs sign-in", detail: `Signed out — tracking links are falling back to the basic page. ${IGNITION_SIGNIN_HINT}` };
  }
  // Configured but nothing to track right now, or never used here.
  return {
    status: "off",
    headline: configured ? "Idle" : "Not set up",
    detail: configured
      ? "No deliveries to track right now; links will mint when the next route needs one."
      : "Live Ignition tracking isn't set up here; the basic /track page is used instead.",
  };
}

/**
 * Should we raise the "Ignition signed out" Slack alert now? Only when the poller is stale AND it matters
 * (deliveries to track today) AND the feature is in use here AND we're past the dedup cool-off. This is
 * the pure gate; the DB wrapper handles the cool-off bookkeeping. Mirrors the Instawork fresh→stale alert.
 */
export function shouldAlertIgnitionStale(opts: {
  pollerFresh: boolean;
  hasDeliveriesToday: boolean;
  configured: boolean;
  alertedAgoMs: number;
  cooloffMs: number;
}): boolean {
  if (opts.pollerFresh) return false; // healthy — nothing to alert
  if (!opts.configured) return false; // Ignition never used here — not a lapse worth paging
  if (!opts.hasDeliveriesToday) return false; // nothing to mint — don't nag
  return opts.alertedAgoMs > opts.cooloffMs; // past the cool-off
}
