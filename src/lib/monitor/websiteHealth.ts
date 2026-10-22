// Website uptime monitor — is the public company website answering with HTTP 200?
//
// OPERATIONAL / SAFETY: the site being down is urgent (lost leads, lost trust), so this is ALWAYS-ON
// and NEVER gated by business hours. The check is a plain server-side GET from Fly — Zoe's site is a
// public WordPress/Kinsta site, so unlike the Cloudflare-blocked Goodshuffle endpoints a datacenter
// fetch works fine.
//
// HONEST WHEN UNOBSERVABLE: a network failure is reported as "unreachable" and a timeout as a timeout,
// each DISTINCT from a real HTTP error code. We never report a site as up unless the final response (after
// following redirects) is exactly 200. RULES CALCULATE: the alert/dedup/recovery logic is deterministic.
//
// Alert path: slackNotify (the ops channel), NOT the sales/customer-alerts channel — this is an operational
// signal. We deliberately do NOT import the sales business-hours gate. Dedup + recovery mirror the probe
// pattern in src/lib/pull/state.ts (recordInstaworkProbe / recordBookingsImportFailure): a cold-start first
// observation never pages, a sustained non-200 pages ONCE and is then deduped by a 2h cool-off, and one
// recovery message is sent when it comes back to 200 (only if a failure was alerted).

import { getDb } from "@/lib/db";
import { slackNotify } from "@/lib/notify/slack";
import { getSettings } from "@/lib/settings";

/** The result of a single health check. `ok` is true only for a final HTTP 200. */
export interface WebsiteCheck {
  url: string;
  ok: boolean;
  status: number | null; // the final HTTP status, or null when we never got a response (network/timeout)
  error: string | null; //  honest failure reason when !ok: "HTTP 500", "timeout after 10000ms", "unreachable"
  ms: number; //            how long the check took, in milliseconds
}

const DEFAULT_TIMEOUT_MS = 10_000;
// A normal browser-ish UA so a WAF/CDN does not 403 a bare client (which would read as a false "down").
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36 ZoeOpsMonitor/1.0";

/**
 * Fetch `url` with a bounded timeout and report whether it is healthy. Follows redirects; only a FINAL 200
 * counts as healthy (a 3xx chain resolving to 200 is fine; a 4xx/5xx, a network error, or a timeout is not).
 * Uses GET (some hosts reject HEAD). NEVER throws — every failure is returned as a WebsiteCheck.
 */
export async function checkWebsiteHealth(
  url: string,
  now: number = Date.now(),
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<WebsiteCheck> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      cache: "no-store",
      signal: controller.signal,
      headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml,*/*" },
    });
    const status = res.status;
    const ok = status === 200;
    return { url, ok, status, error: ok ? null : `HTTP ${status}`, ms: Math.max(0, Date.now() - now) };
  } catch (e) {
    // An AbortError means our own timeout fired; anything else is a network-level failure. Both are "down",
    // but we keep them distinct in the message so a human can tell a slow site from an unreachable one.
    const aborted = e instanceof Error && (e.name === "AbortError" || /abort/i.test(e.message));
    const error = aborted ? `timeout after ${timeoutMs}ms` : "unreachable";
    return { url, ok: false, status: null, error, ms: Math.max(0, Date.now() - now) };
  } finally {
    clearTimeout(timer);
  }
}

// ── Per-url alert bookkeeping (persisted in the settings KV, like pull_state) ─────────────────────────

const STATE_KEY = "website_monitor";
const ALERT_COOLOFF_MS = 2 * 60 * 60 * 1000; // 2h, matching the other probes

interface UrlState {
  ok?: boolean; //          last observed result; undefined until the first observation (cold start)
  failingSince?: string; // ISO it first started failing (cleared on recovery)
  alertedAt?: string; //    ISO we last Slack-alerted this url (2h cool-off dedup)
}

interface MonitorState {
  urls?: Record<string, UrlState>;
}

export function getMonitorState(): MonitorState {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(STATE_KEY) as { value: string } | undefined;
  if (!row) return {};
  try {
    return JSON.parse(row.value) as MonitorState;
  } catch {
    return {};
  }
}

function saveMonitorState(s: MonitorState): void {
  getDb()
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(STATE_KEY, JSON.stringify(s), new Date().toISOString());
}

/** A short honest failure phrase for a check: the status (as "HTTP 500") or the network/timeout reason. */
function reason(check: WebsiteCheck): string {
  return check.error || (check.status != null ? `HTTP ${check.status}` : "unreachable");
}

/**
 * Record one check result for a url and decide whether to Slack. MIRRORS recordInstaworkProbe:
 *  - a cold-start first-ever observation never pages (no known baseline), whether ok or failing;
 *  - once seen, a failing check pages ONCE, deduped by a 2h cool-off that also caps a SUSTAINED outage at
 *    one page per 2h;
 *  - one recovery alert when it returns to 200 (only if we had alerted the failure).
 * House comms style: no dashes, no emoji. Returns the message to send, or null. Pure given `state`+`now`.
 */
export function recordWebsiteProbe(check: WebsiteCheck, now: Date = new Date()): { alert: string | null } {
  const s = getMonitorState();
  s.urls = s.urls ?? {};
  const prev = s.urls[check.url] ?? {};
  const seenBefore = prev.ok !== undefined; // don't page on a cold-start first glance (no known-good baseline)
  let alert: string | null = null;

  if (!check.ok) {
    if (!prev.failingSince) prev.failingSince = now.toISOString();
    const alertedAgo = prev.alertedAt ? now.getTime() - Date.parse(prev.alertedAt) : Infinity;
    if (seenBefore && alertedAgo > ALERT_COOLOFF_MS) {
      alert = `Zoe website monitor: ${check.url} is DOWN (${reason(check)}). It is not returning HTTP 200. Failing since ${prev.failingSince}.`;
      prev.alertedAt = now.toISOString();
    }
  } else {
    if (prev.alertedAt) alert = `Zoe website monitor: ${check.url} is back up (HTTP 200).`;
    prev.failingSince = undefined;
    prev.alertedAt = undefined;
  }

  prev.ok = check.ok;
  s.urls[check.url] = prev;
  saveMonitorState(s);
  return { alert };
}

export interface MonitorRun {
  checked: number;
  down: string[]; //    urls currently not returning 200 this run
  alerted: number; //   how many Slack messages (down + recovered) we sent this run
  checks: WebsiteCheck[];
}

/**
 * Check every configured url (sequentially, bounded + cheap) and fire the sustained-failure / recovery
 * alerts. Reads the url list from settings (monitorUrls, env MONITOR_URLS override). Never throws.
 */
export async function runWebsiteMonitor(now: Date = new Date()): Promise<MonitorRun> {
  const urls = getSettings().monitorUrls;
  const checks: WebsiteCheck[] = [];
  const down: string[] = [];
  let alerted = 0;

  for (const url of urls) {
    const check = await checkWebsiteHealth(url, now.getTime());
    checks.push(check);
    if (!check.ok) down.push(url);
    const { alert } = recordWebsiteProbe(check, now);
    if (alert) {
      alerted++;
      void slackNotify(alert);
    }
  }

  return { checked: urls.length, down, alerted, checks };
}
