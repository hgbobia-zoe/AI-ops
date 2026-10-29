// SEO Growth — data-limit / staleness WATCHER. The office runner reads a small batch of live Google SERPs per
// run (a drip) and STOPS on a limit/blocked response. This surfaces that honestly:
//   • seoWatcherStatus() — discovered vs pending seed counts + last ingest + last limit-hit (freshness-based,
//     like the Instawork health, never a server-side probe).
//   • alertLimitHit() — a DEDUPED Slack alert (customer-alerts channel) when a data limit is hit, with a
//     cooldown so repeated hits in one window don't spam. Returns whether it actually sent.
// HONESTY: nothing here fabricates data; it only reports counts + timestamps that real ingests produced.

import { getJson, setJson } from "@/lib/kv";
import { slackNotifyAlert } from "@/lib/notify/slack";
import { buildSeedKeywords } from "./discovery";
import { allDedupeKeys, dedupeKey, latestSuccess, latestRateLimited, latestDiagnostic } from "./store";
import { SEO_STALE_HOURS, type SeoHealth } from "./types";

const ALERT_KEY = "seo.lastLimitAlertMs";
/** Don't re-alert more than once per window — a free-tier day can hit the cap on every run. */
const ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

export interface SeoWatcherStatus {
  totalSeeds: number;
  discovered: number;
  pending: number;
  /** ISO of the last successful ingest (office-runner freshness), or null. */
  lastIngestAt: string | null;
  /** ISO of the last time the runner hit a data limit, or null. */
  lastLimitHitAt: string | null;
}

/** Discovered-vs-pending progress + ingest/limit freshness. One dedupe-key query, computed in memory. */
export function seoWatcherStatus(): SeoWatcherStatus {
  const seeds = buildSeedKeywords();
  const have = allDedupeKeys();
  let discovered = 0;
  for (const s of seeds) if (have.has(dedupeKey(s.keyword, s.intent, s.location))) discovered++;
  return {
    totalSeeds: seeds.length,
    discovered,
    pending: seeds.length - discovered,
    lastIngestAt: latestSuccess()?.ts ?? null,
    lastLimitHitAt: latestRateLimited()?.ts ?? null,
  };
}

/**
 * Honest integration health for the SERP office-runner source, derived PURELY from ingest FRESHNESS (the stored
 * diagnostics) — never a server-side probe (the server can't read Google; the office machine does). "configured"
 * here means "the runner has run at least once". never → not run yet; error → the last read failed/blocked;
 * stale → the last success is older than the staleness window; ok → pushing live. Nothing fabricated.
 */
export function serpHealth(): SeoHealth {
  const success = latestSuccess();
  const attempt = latestDiagnostic();
  const lastSuccessAt = success?.ts ?? null;
  const lastAttemptAt = attempt?.ts ?? null;
  const ageH = lastSuccessAt ? (Date.now() - Date.parse(lastSuccessAt)) / 3_600_000 : null;
  const stale = ageH != null && Number.isFinite(ageH) && ageH > SEO_STALE_HOURS;

  if (!attempt) {
    return {
      status: "never",
      configured: false,
      headline: "Not run yet",
      detail: "The SERP office runner has not pushed any data yet. Run it from the office machine (tools/seo-runner) to start reading Google SERPs.",
      lastSuccessAt: null,
      lastAttemptAt: null,
      lastError: null,
      stale: false,
    };
  }
  if (!attempt.ok) {
    return {
      status: "error",
      configured: true,
      headline: attempt.rateLimited ? "Data limit" : "Blocked / error",
      detail: attempt.detail || "The last SERP read failed. The runner reports blocked reads honestly and retries on the next drip.",
      lastSuccessAt,
      lastAttemptAt,
      lastError: attempt.detail ?? "read failed",
      stale,
    };
  }
  return {
    status: stale ? "stale" : "ok",
    configured: true,
    headline: stale ? "Stale" : "Reading",
    detail: stale
      ? `The last successful SERP read was over ${SEO_STALE_HOURS} hours ago. Data may be out of date — check the office runner.`
      : "The SERP office runner is pushing live Google results.",
    lastSuccessAt,
    lastAttemptAt,
    lastError: null,
    stale,
  };
}

export interface LimitAlertResult {
  alerted: boolean;
  skipped?: "cooldown" | "slack";
}

/** Fire a DEDUPED Slack alert for a free-tier limit hit. Within ALERT_COOLDOWN_MS of the last alert it is a
 *  no-op (returns skipped:"cooldown"). Records the alert time only when it actually sends, so a Slack failure
 *  doesn't suppress the next real attempt. Never throws. */
export async function alertLimitHit(meta: { quota?: { resetAt?: string | null } } = {}): Promise<LimitAlertResult> {
  const now = Date.now();
  const last = getJson<number>(ALERT_KEY, 0);
  if (now - last < ALERT_COOLDOWN_MS) return { alerted: false, skipped: "cooldown" };
  const resets = meta.quota?.resetAt ? ` Resets ${meta.quota.resetAt}.` : "";
  const r = await slackNotifyAlert(`SEO data limit reached — keyword/SERP discovery is paused for now; it resumes on the next drip once the limit clears.${resets}`);
  if (r.ok) {
    setJson(ALERT_KEY, now);
    return { alerted: true };
  }
  return { alerted: false, skipped: "slack" };
}
