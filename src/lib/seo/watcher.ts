// SEO Growth — free-tier data-limit WATCHER. Ubersuggest's free plan allows only a few keyword lookups/day,
// so the office runner drips a small batch and STOPS on a quota response. This surfaces that honestly:
//   • seoWatcherStatus() — discovered vs pending seed counts + last ingest + last limit-hit (freshness-based,
//     like the Instawork health, never a server-side probe).
//   • alertLimitHit() — a DEDUPED Slack alert (customer-alerts channel) when a limit is hit, with a cooldown
//     so repeated hits in one window don't spam. Returns whether it actually sent.
// HONESTY: nothing here fabricates data; it only reports counts + timestamps that real ingests produced.

import { getJson, setJson } from "@/lib/kv";
import { slackNotifyAlert } from "@/lib/notify/slack";
import { buildSeedKeywords } from "./discovery";
import { allDedupeKeys, dedupeKey, latestSuccess, latestRateLimited } from "./store";

const ALERT_KEY = "seo.lastLimitAlertMs";
/** Don't re-alert more than once per window — a free-tier day can hit the cap on every run. */
const ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

export interface SeoWatcherStatus {
  totalSeeds: number;
  discovered: number;
  pending: number;
  /** ISO of the last successful ingest (office-runner freshness), or null. */
  lastIngestAt: string | null;
  /** ISO of the last time we hit the Ubersuggest daily limit, or null. */
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
  const r = await slackNotifyAlert(`Ubersuggest daily limit reached — keyword discovery is paused until the quota resets or the plan is upgraded to paid.${resets}`);
  if (r.ok) {
    setJson(ALERT_KEY, now);
    return { alerted: true };
  }
  return { alerted: false, skipped: "slack" };
}
