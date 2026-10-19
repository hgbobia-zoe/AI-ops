// Server side of the office-machine Ignition etaLink mint: geocode the stop, enqueue a mint request for
// the extension to replay, and (when Ignition is set up here) do a BOUNDED WAIT for the live link so the
// "on the way" SMS can carry the real Ignition map URL. Pure request/URL/selection logic lives in
// ./etaLinkMint; this module is the IO glue (geocode + DB + timing).
//
// Timing design (see also the design note in notify/fanout.ts):
//   • We ALWAYS enqueue the mint and ALWAYS have the /track fallback ready, so the customer never gets a
//     dead or fabricated link.
//   • We do the BOUNDED WAIT for a live mint whenever the feature is CONFIGURED here — i.e. the office
//     Ignition poller has EVER checked in (etaLinkConfigured), NOT only when the 20-minute ready
//     heartbeat (etaLinkPollerReady) is fresh. This is the fix: a tab that is actually signed in but
//     backgrounded/throttled (so the server hasn't seen a ready-poll in 20m) used to short-circuit to
//     /track immediately; now it still gets a real chance to mint at the click. The extension's Ignition
//     content script polls every ~15s, so a mint lands in ~15-45s; we early-return the instant it does.
//   • When Ignition was NEVER configured here, we DON'T wait at all — the text goes out immediately with
//     /track (which upgrades to the Ignition map if a mint ever lands). An unconfigured office never pays
//     the delay.
//   • Every outcome carries a REASON so a /track fallback is never silent (see EtaLinkMintResult).

import { geocode } from "./geo";
import { computeLiveEta } from "./liveEta";
import { shiftWindowHours, type EtaLinkMintReason } from "./etaLinkMint";
import { enqueueEtaLinkMint, getMintedEtaLinkForStop, getEtaLinkStateForStop } from "@/lib/db/repo";
import { etaLinkConfigured, etaLinkPollerReady } from "@/lib/pull/state";
import type { Stop } from "@/lib/types";

const WAIT_MS = Math.max(0, Number(process.env.ETA_LINK_MINT_WAIT_MS || 45000));
const POLL_MS = Math.max(500, Number(process.env.ETA_LINK_MINT_POLL_MS || 2500));
// A still-`pending` mint older than this at click time is treated as stale (the office poller was likely
// down when it was enqueued, so it never drained) and a FRESH pending row is enqueued — the live session
// then gets a current attempt instead of us waiting on a dead-in-the-water request. Tune via env only.
const PENDING_STALE_MS = Math.max(0, Number(process.env.ETA_LINK_PENDING_STALE_MS || 10 * 60 * 1000));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The result of a departure mint attempt: the live-map URL (or null → caller uses /track) plus WHY, so
 *  a fallback can be surfaced instead of silently happening. `pollerReady` = whether a signed-in poller
 *  heartbeat was fresh (≤20m) at the click — context for the fallback alert (stale heartbeat ⇒ the office
 *  session may actually be down, not just throttled). */
export interface EtaLinkMintResult {
  url: string | null;
  reason: EtaLinkMintReason;
  pollerReady: boolean;
}

/**
 * Mint (or reuse) an Ignition etaLink for a stop and return its public live-map URL (with the reason),
 * or a null URL if it isn't available in time (caller falls back to /track). Honest: never returns a
 * fabricated link.
 *
 * @param truckLabel the Ignition unit label to resolve at runtime (e.g. "Ford E450")
 */
export async function mintEtaLinkForStop(
  stop: Stop,
  truckId: string,
  truckLabel: string,
): Promise<EtaLinkMintResult> {
  const pollerReady = etaLinkPollerReady();
  // Feature escape hatch: ETA_LINK_MINT=0 disables minting entirely (pure /track — the prior behavior).
  if (process.env.ETA_LINK_MINT === "0") return { url: null, reason: "disabled", pollerReady };
  if (!stop.address) return { url: null, reason: "no-address", pollerReady };

  // Has Ignition ever been set up on the office machine? Gates the bounded wait below (NOT the 20m
  // ready heartbeat), so a live-but-stale-heartbeat session still gets the wait at the click.
  const configured = etaLinkConfigured();

  const coords = await geocode(stop.address).catch(() => null);
  if (!coords) return { url: null, reason: "geocode-fail", pollerReady }; // no coordinates → /track stays the link

  // Rough initial ETA (hours) best-effort from live GPS; the Ignition page recomputes live anyway.
  let etaHours: number | null = null;
  try {
    const live = await computeLiveEta(truckId, stop);
    if (live && live.minutesAway > 0) etaHours = live.minutesAway / 60;
  } catch {
    /* no live fix → omit the initial estimate */
  }

  const now = Date.now();
  const startISO = new Date(now).toISOString();
  const endISO = new Date(now + shiftWindowHours() * 3600 * 1000).toISOString();

  const state = enqueueEtaLinkMint({
    stopId: stop.stopId,
    routeId: stop.routeId,
    truckId,
    truckLabel,
    address: stop.address,
    lat: coords.lat,
    lng: coords.lng,
    etaHours,
    startISO,
    endISO,
    // Re-enqueue a fresh pending row if the only existing one is a stale, never-drained pending attempt.
    maxPendingAgeMs: PENDING_STALE_MS,
  });

  // Reused an already-minted link → send it now.
  if (state.status === "minted" && state.url) return { url: state.url, reason: "minted", pollerReady };

  // Wait for the live Ignition session to mint whenever the feature is CONFIGURED here; an office that
  // never set Ignition up falls straight back to /track (no delay). WAIT_MS<=0 also skips the wait.
  if (!configured) return { url: null, reason: "unconfigured", pollerReady };
  if (WAIT_MS <= 0) return { url: null, reason: "wait-timeout", pollerReady };

  const deadline = now + WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    const minted = getMintedEtaLinkForStop(stop.stopId);
    if (minted?.url) return { url: minted.url, reason: "minted", pollerReady };
    const cur = getEtaLinkStateForStop(stop.stopId);
    if (cur?.status === "error") return { url: null, reason: "error", pollerReady }; // failed fast — don't block the text
  }
  return { url: null, reason: "wait-timeout", pollerReady };
}
