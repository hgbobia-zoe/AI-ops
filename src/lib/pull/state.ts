// Pull freshness + import ledger. Freshness is tracked PER SOURCE (route:<truck>, bookings,
// revenue) so a bookings pull can't mask stale routes. The import_log records every attempt (counts
// + errors) — the factual basis for the Data Health view and for detecting a bad-but-recent pull.

import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";
import {
  shouldAlertIgnitionStale,
  IGNITION_STALE_ALERT,
  IGNITION_RECOVERED_ALERT,
  type IgnitionHealth,
} from "@/lib/eta/ignitionStatus";

const KEY = "pull_state";

export interface SourceFreshness {
  at: string; // ISO of the last successful pull for this source
  count: number;
}

export type AgentStatus = "ok" | "no_tab" | "not_logged_in" | "error";

export interface AgentHeartbeat {
  agent: string; // stable per-install id (random, from the extension). Old installs send the constant "extension".
  label?: string | null; // human label for this puller (e.g. "Office PC", "Jane laptop"), when the install sets one
  status: AgentStatus;
  detail: string | null;
  at: string; // ISO of this heartbeat
}

export interface PullState {
  sources?: Record<string, SourceFreshness>;
  lastStaleAlertAt?: string;
  // Each Auto-Pull install reports independently, keyed by its stable id, so one signed-out laptop can no
  // longer clobber a healthy puller's status. `agent` is kept as the single most-recent heartbeat for
  // legacy readers; the FLEET (agents) is what drives the banner and the alert.
  agents?: Record<string, AgentHeartbeat>;
  agent?: AgentHeartbeat; // legacy: last heartbeat from ANY install (most recent); prefer fleetHealth()
  agentFailingSince?: string; // ISO the WHOLE fleet first went unhealthy (cleared when any puller recovers)
  agentAlertedAt?: string; // ISO we last Slack-alerted a fleet-down (cool-off dedup)
  routeHealthAlerted?: Record<string, string>; // routeId → ISO we last Slack-alerted it (overdue routes)
  instaworkOk?: boolean; // last Instawork probe result (undefined until first probe) — drives OK↔failed flip alerts
  instaworkFailingSince?: string; // ISO Instawork first started failing (cleared on a good probe)
  instaworkAlertedAt?: string; // ISO we last Slack-alerted an Instawork failure (cool-off dedup)
  // Legacy single-value fields (kept so the existing freshness banner keeps working).
  lastPullAt?: string;
  lastStops?: number;
  // Ignition etaLink mint poller (office-machine). Stamped when the extension's Ignition content script
  // polls for pending mints: `seenAt` = a tab is polling at all; `readyAt` = that tab is SIGNED IN (has
  // an IdToken, so a mint can actually succeed). The departure bounded-wait keys off `readyAt` so an
  // unconfigured/signed-out office never stalls the "on the way" text.
  ignitionMintSeenAt?: string;
  ignitionMintReadyAt?: string;
  // Ignition "signed out" alert bookkeeping (mirrors the Instawork probe dedup): the last time we
  // Slack-alerted a lapsed office Ignition session (2h cool-off), cleared on recovery.
  ignitionStaleSince?: string;
  ignitionAlertedAt?: string;
  // Bookings-import data-quality alert bookkeeping (mirrors the Instawork probe dedup). `bookingsImportOk`
  // is the last known result (undefined until the first observation → cold-start never pages);
  // `bookingsFailingSince`/`bookingsAlertedAt` drive the 2h-deduped sustained-failure + recovery alerts.
  bookingsImportOk?: boolean;
  bookingsFailingSince?: string;
  bookingsAlertedAt?: string;
}

export function getPullState(): PullState {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(KEY) as { value: string } | undefined;
  if (!row) return {};
  try {
    return JSON.parse(row.value) as PullState;
  } catch {
    return {};
  }
}

function save(s: PullState): void {
  getDb()
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(KEY, JSON.stringify(s), new Date().toISOString());
}

/** Record a SUCCESSFUL pull for one source (e.g. "route:E450", "bookings"). */
export function recordPull(source: string, count: number, now: Date = new Date()): void {
  const s = getPullState();
  s.sources = s.sources ?? {};
  s.sources[source] = { at: now.toISOString(), count };
  s.lastPullAt = now.toISOString();
  s.lastStops = count;
  save(s);
}

/** Record that the Ignition etaLink-mint poller checked in. `ready` = the Ignition tab is signed in
 *  (an IdToken is present, so a mint can succeed). Called from GET /api/etalink/pending. */
export function markEtaLinkPoller(ready: boolean, now: Date = new Date()): void {
  const s = getPullState();
  s.ignitionMintSeenAt = now.toISOString();
  if (ready) s.ignitionMintReadyAt = now.toISOString();
  save(s);
}

/** True when a SIGNED-IN Ignition tab has polled recently (default 20m). The departure flow only does
 *  the bounded wait for a minted link when this holds — otherwise it sends the /track link immediately
 *  (the mint still enqueues; /track upgrades itself if a link lands later). */
export function etaLinkPollerReady(withinMin = 20, now: number = Date.now()): boolean {
  const at = getPullState().ignitionMintReadyAt;
  if (!at) return false;
  const ageMin = (now - Date.parse(at)) / 60000;
  return Number.isFinite(ageMin) && ageMin <= withinMin;
}

/** True when the Ignition mint path has EVER been set up on this office machine (the poller has checked
 *  in at least once), regardless of how recent that was. The DEPARTURE bounded-wait keys off THIS — not
 *  the 20-min `etaLinkPollerReady` heartbeat — so a session that is actually signed in but whose tab is
 *  backgrounded/throttled (no ready-poll in 20m) still gets a REAL chance to mint at the "on the way"
 *  click. An office that never configured Ignition returns false here and never pays the wait. */
export function etaLinkConfigured(): boolean {
  return !!getPullState().ignitionMintSeenAt;
}

/** Server-inferred Ignition session health from the mint poller's heartbeat. `ok` = a signed-in tab
 *  polled within `freshMin` (default 20m, matching etaLinkPollerReady); `configured` = the poller has
 *  EVER checked in here (the feature is in use). Honest: no heartbeat → not ok; never faked. */
export function ignitionHealth(freshMin = 20, now: number = Date.now()): IgnitionHealth {
  const s = getPullState();
  const ok = etaLinkPollerReady(freshMin, now);
  const configured = !!s.ignitionMintSeenAt;
  const lastReadyAt = s.ignitionMintReadyAt ?? null;
  const lastSeenAt = s.ignitionMintSeenAt ?? null;
  const detail = ok
    ? "Signed in and polling on the office machine."
    : configured
      ? `Not polling${lastReadyAt ? ` (last signed-in ${lastReadyAt})` : ""} — office Ignition session may have lapsed.`
      : "Ignition live-tracking has not been set up on the office machine.";
  return { ok, configured, lastReadyAt, lastSeenAt, detail };
}

/** Decide whether to Slack about a lapsed Ignition session, and record the dedup bookkeeping. Mirrors
 *  recordInstaworkProbe: alert once when the poller goes STALE **and it matters** (there are deliveries
 *  to track today), 2h-deduped; one "recovered" message when it comes back (only if we had alerted).
 *  `hasDeliveriesToday` is the gate — we never nag when there's nothing to mint. Returns the message or null. */
export function recordIgnitionProbe(
  pollerFresh: boolean,
  hasDeliveriesToday: boolean,
  configured: boolean,
  now: Date = new Date(),
): { alert: string | null } {
  const s = getPullState();
  let alert: string | null = null;

  if (pollerFresh) {
    // Recovered: only announce if we had alerted a lapse; clear the bookkeeping.
    if (s.ignitionAlertedAt) alert = IGNITION_RECOVERED_ALERT;
    s.ignitionStaleSince = undefined;
    s.ignitionAlertedAt = undefined;
  } else if (configured && hasDeliveriesToday) {
    if (!s.ignitionStaleSince) s.ignitionStaleSince = now.toISOString();
    const alertedAgoMs = s.ignitionAlertedAt ? now.getTime() - Date.parse(s.ignitionAlertedAt) : Infinity;
    if (shouldAlertIgnitionStale({ pollerFresh, hasDeliveriesToday, configured, alertedAgoMs, cooloffMs: ALERT_COOLOFF_MS })) {
      alert = IGNITION_STALE_ALERT;
      s.ignitionAlertedAt = now.toISOString();
    }
  }
  // Stale-but-nothing-to-track: leave the bookkeeping as-is (no alert, no false recovery).

  save(s);
  return { alert };
}

export function markStaleAlerted(now: Date = new Date()): void {
  const s = getPullState();
  s.lastStaleAlertAt = now.toISOString();
  save(s);
}

/** The route-health dedup map (routeId → last-alerted ISO), so an overdue route is Slack-alerted once
 *  and only re-alerted after a cool-off. Persisted so it survives restarts. */
export function getRouteHealthAlerted(): Record<string, string> {
  return getPullState().routeHealthAlerted ?? {};
}
export function setRouteHealthAlerted(map: Record<string, string>): void {
  const s = getPullState();
  s.routeHealthAlerted = map;
  save(s);
}

// How recent a heartbeat must be to count toward the fleet (the extension pings every ~10m).
export const AGENT_FRESH_MIN = 30;
// How recently any source must have pulled for the data itself to count as "fresh" — a direct sign the
// pullers are working, independent of who last pinged. Generous vs the ~10m cadence.
const DATA_FRESH_MIN = 60;
// The fleet must be continuously unhealthy for this long before we page (one blip never alerts), and we
// re-page at most once per cool-off while it stays down.
const SUSTAIN_MS = 15 * 60 * 1000;
const ALERT_COOLOFF_MS = 2 * 60 * 60 * 1000;
// Forget an install that has not pinged in this long (a decommissioned laptop must not count as a puller).
const AGENT_TTL_MS = 24 * 60 * 60 * 1000;

export interface FleetHealth {
  agents: AgentHeartbeat[]; // fresh heartbeats (within AGENT_FRESH_MIN), most-recent first
  total: number; // number of fresh pullers reporting
  okCount: number; // fresh pullers currently able to pull
  dataFresh: boolean; // a source pulled within DATA_FRESH_MIN (ground truth that pulling works)
  healthy: boolean; // at least one puller OK, or data is fresh → redundancy is holding
  reason: AgentStatus | "none"; // when unhealthy, the most actionable failure across the fleet
  lastRouteAt: number | null;
}

/** Most recent successful pull across ALL sources (routes + bookings), in ms, or null. */
function latestPullMs(st: PullState): { route: number | null; any: number | null } {
  const routeAts = Object.entries(st.sources ?? {})
    .filter(([k]) => k.startsWith("route:"))
    .map(([, v]) => Date.parse(v.at))
    .filter((t) => !Number.isNaN(t));
  const route = routeAts.length ? Math.max(...routeAts) : null;
  const bookings = st.sources?.["bookings"] ? Date.parse(st.sources["bookings"].at) : NaN;
  const all = [route, Number.isNaN(bookings) ? null : bookings].filter((t): t is number => t != null);
  return { route, any: all.length ? Math.max(...all) : null };
}

/** The FLEET view of the Auto-Pull installs: healthy when any install is pulling OR data is fresh, so a
 *  single signed-out/closed laptop never reads as an outage while another operator is covering. This is
 *  what the banner and the fleet-down alert key off — never a single most-recent heartbeat. */
export function fleetHealth(now: number = Date.now(), freshMin = AGENT_FRESH_MIN, dataFreshMin = DATA_FRESH_MIN): FleetHealth {
  return computeFleet(getPullState(), now, freshMin, dataFreshMin);
}

// Pure fleet computation over a given state snapshot. recordAgentHeartbeat must compute from its IN-MEMORY
// state (the beat it just set but has not saved yet), so the verdict reflects the heartbeat being recorded.
function computeFleet(st: PullState, now: number, freshMin = AGENT_FRESH_MIN, dataFreshMin = DATA_FRESH_MIN): FleetHealth {
  const all = Object.values(st.agents ?? (st.agent ? { [st.agent.agent]: st.agent } : {}));
  const fresh = all
    .filter((a) => (now - Date.parse(a.at)) / 60000 <= freshMin)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const okCount = fresh.filter((a) => a.status === "ok").length;
  const { route, any } = latestPullMs(st);
  const dataFresh = any != null && (now - any) / 60000 <= dataFreshMin;
  const healthy = okCount > 0 || dataFresh;
  const reason: AgentStatus | "none" = fresh.some((a) => a.status === "not_logged_in")
    ? "not_logged_in"
    : fresh.some((a) => a.status === "no_tab")
      ? "no_tab"
      : fresh.some((a) => a.status === "error")
        ? "error"
        : "none";
  return { agents: fresh, total: fresh.length, okCount, dataFresh, healthy, reason, lastRouteAt: route };
}

/** Record ONE install's heartbeat (status + detail), keyed by its stable id. Independent of pull success —
 *  a successful pull updates source freshness via recordPull; this captures WHY a pull didn't happen (no
 *  GSPRO tab, signed out) per operator. The returned `alert` (when non-null) is a message the caller should
 *  Slack: we page ONLY when the WHOLE fleet is down (no puller OK and data stale) for at least SUSTAIN_MS,
 *  deduped by a 2h cool-off, and once on recovery. One signed-out laptop with a healthy peer never pages. */
export function recordAgentHeartbeat(agent: string, status: AgentStatus, detail: string | null, label: string | null = null, now: Date = new Date()): { alert: string | null } {
  const s = getPullState();
  const beat: AgentHeartbeat = { agent, label: label ?? undefined, status, detail: detail ?? null, at: now.toISOString() };

  // Upsert this install into the fleet map and prune installs that have gone silent past the TTL.
  const agents = s.agents ?? (s.agent ? { [s.agent.agent]: s.agent } : {});
  agents[agent] = beat;
  for (const [id, a] of Object.entries(agents)) {
    if (id !== agent && now.getTime() - Date.parse(a.at) > AGENT_TTL_MS) delete agents[id];
  }
  s.agents = agents;
  s.agent = beat; // legacy single-slot, kept for older readers

  // Fleet verdict AFTER recording this beat — computed from the in-memory state (not yet saved).
  const fleet = computeFleet(s, now.getTime());
  let alert: string | null = null;

  if (fleet.healthy) {
    if (s.agentAlertedAt) alert = "Zoe Auto-Pull recovered — a puller is reporting in again.";
    s.agentFailingSince = undefined;
    s.agentAlertedAt = undefined;
  } else {
    if (!s.agentFailingSince) s.agentFailingSince = now.toISOString();
    const downForMs = now.getTime() - Date.parse(s.agentFailingSince);
    const alertedAgo = s.agentAlertedAt ? now.getTime() - Date.parse(s.agentAlertedAt) : Infinity;
    if (downForMs >= SUSTAIN_MS && alertedAgo > ALERT_COOLOFF_MS) {
      const n = fleet.total;
      const fleetNote = n > 1 ? `all ${n} reporting pullers` : n === 1 ? "the reporting puller" : "no puller is reporting and";
      const reason =
        fleet.reason === "not_logged_in"
          ? `Goodshuffle is signed out on ${fleetNote}. Sign in at pro.goodshuffle.com on an office machine.`
          : fleet.reason === "no_tab"
            ? `No Goodshuffle tab is open on ${fleetNote}. Open pro.goodshuffle.com (signed in).`
            : fleet.reason === "error"
              ? `Auto-Pull is erroring on ${fleetNote} (${detail || "inject/pull failed"}). Check the extension's site access on pro.goodshuffle.com.`
              : "no Auto-Pull install is reporting in. Start the extension on an office machine.";
      alert = `Zoe Auto-Pull is down — ${reason} No puller has pulled in a while, so Goodshuffle data will go stale. Down since ${s.agentFailingSince}.`;
      s.agentAlertedAt = now.toISOString();
    }
  }

  save(s);
  return { alert };
}

/** Record the result of an Instawork live probe and decide whether to Slack. Mirrors the agent-heartbeat
 *  bookkeeping: once Instawork has worked at least once, a failing probe Slack-alerts (so an expired
 *  cookie is caught), deduped by a 2h cool-off that also caps a SUSTAINED outage at one page per 2h; and
 *  one alert on recovery (only if we had alerted the failure). Honest: a cold-start first-ever observation
 *  never pages, and a failed probe is never reported as OK. Returns `alert` = the message to send, or null. */
export function recordInstaworkProbe(ok: boolean, detail: string | null, now: Date = new Date()): { alert: string | null } {
  const s = getPullState();
  const seenBefore = s.instaworkOk !== undefined; // don't page on a cold-start first glance (no known-good baseline)
  let alert: string | null = null;

  if (!ok) {
    if (!s.instaworkFailingSince) s.instaworkFailingSince = now.toISOString();
    const alertedAgo = s.instaworkAlertedAt ? now.getTime() - Date.parse(s.instaworkAlertedAt) : Infinity;
    if (seenBefore && alertedAgo > ALERT_COOLOFF_MS) {
      alert = `Zoe Instawork connection is down (${detail || "unreachable"}). The session cookie has likely expired. Re-paste it in Settings so temp-labor reconciliation keeps working. Failing since ${s.instaworkFailingSince}.`;
      s.instaworkAlertedAt = now.toISOString();
    }
  } else {
    if (s.instaworkAlertedAt) alert = `Zoe Instawork connection recovered (${detail || "ok"}).`;
    s.instaworkFailingSince = undefined;
    s.instaworkAlertedAt = undefined;
  }

  s.instaworkOk = ok;
  save(s);
  return { alert };
}

/** Record the result of a bookings import's orphan-prune step and decide whether to Slack. MIRRORS
 *  recordInstaworkProbe EXACTLY: once a bookings pull has been observed at least once, a failing prune
 *  (the orphan cleanup keeps skipping because too many active projects are missing — likely a truncated
 *  pull, or a real bulk deletion that needs the /admin Force-archive one-shot) Slack-alerts so a human
 *  decides, deduped by a 2h cool-off that also caps a SUSTAINED failure at one page per 2h; and one alert
 *  on recovery (only if we had alerted). Honest: a cold-start first-ever observation never pages, and a
 *  failing prune is never reported as OK. `detail` carries the missing-orphan count for the alert copy.
 *  Returns `alert` = the message to send, or null. */
export function recordBookingsImportFailure(ok: boolean, detail: string | null, now: Date = new Date()): { alert: string | null } {
  const s = getPullState();
  const seenBefore = s.bookingsImportOk !== undefined; // don't page on a cold-start first glance (no known baseline)
  let alert: string | null = null;

  if (!ok) {
    if (!s.bookingsFailingSince) s.bookingsFailingSince = now.toISOString();
    const alertedAgo = s.bookingsAlertedAt ? now.getTime() - Date.parse(s.bookingsAlertedAt) : Infinity;
    if (seenBefore && alertedAgo > ALERT_COOLOFF_MS) {
      // House comms style: no em-dashes, no emoji, natural and short.
      alert = `Zoe bookings pull keeps skipping orphan cleanup${detail ? ` (${detail})` : ""}. If you deliberately deleted a batch in Goodshuffle, arm Force-archive in /admin. Otherwise the pull may be truncated, so check the office browser. Failing since ${s.bookingsFailingSince}.`;
      s.bookingsAlertedAt = now.toISOString();
    }
  } else {
    if (s.bookingsAlertedAt) alert = `Zoe bookings pull recovered (${detail || "ok"}). Orphan cleanup is running again.`;
    s.bookingsFailingSince = undefined;
    s.bookingsAlertedAt = undefined;
  }

  s.bookingsImportOk = ok;
  save(s);
  return { alert };
}

// ── Banner verdict (drives PullHealthBanner) ──────────────────────────────────

export interface PullBanner {
  level: "error" | "warn";
  title: string;
  detail: string;
}

/** Decide whether to show a data-health banner, and what it says. Keys primarily off the Auto-Pull
 *  extension's heartbeat (it pings every cycle): a recent "not_logged_in"/"no_tab"/"error" is precise;
 *  a missing/stale heartbeat means the puller isn't running at all. Returns null when all is well.
 *  `agentFreshMin` = how recent a heartbeat must be to be trusted (default 30m; the extension pulls
 *  every ~10m). `routeStaleH` = fallback route-freshness threshold when there's no extension at all. */
export function pullBannerState(now: number = Date.now(), agentFreshMin = AGENT_FRESH_MIN, routeStaleH = 20): PullBanner | null {
  const fleet = fleetHealth(now, agentFreshMin);

  // Redundancy holds: at least one puller is OK, or data is fresh. A signed-out/closed peer is irrelevant.
  if (fleet.healthy) return null;

  const routeAgeH = fleet.lastRouteAt != null ? (now - fleet.lastRouteAt) / 3_600_000 : Infinity;
  const lastPullPhrase = fleet.lastRouteAt != null ? `Last route pull ${Math.round(routeAgeH)}h ago.` : "Routes have never been pulled.";
  const fleetNote = fleet.total > 1 ? ` ${fleet.total} pullers are reporting and none can pull right now.` : "";

  // No install is reporting in at all → fall back to route-age so a manual bookmarklet pull stays quiet.
  if (fleet.total === 0) {
    if (routeAgeH < routeStaleH) return null;
    return {
      level: "warn",
      title: "Route data may be stale — auto-pull isn't reporting in",
      detail: `${lastPullPhrase} Start the Auto-Pull extension (or run the pull) on an office machine.`,
    };
  }

  // Installs ARE reporting, all are failing, and data is stale — a real, uncovered outage.
  if (fleet.reason === "not_logged_in")
    return { level: "error", title: "Goodshuffle is signed out — auto-pull can't run", detail: `Sign into pro.goodshuffle.com on an office machine; data will refresh within a few minutes.${fleetNote}` };
  if (fleet.reason === "no_tab")
    return { level: "warn", title: "Auto-pull has no Goodshuffle tab open", detail: `Open pro.goodshuffle.com (signed in) in an office browser so the pull can run.${fleetNote}` };
  return { level: "warn", title: "Auto-pull hit a problem", detail: `${fleet.agents[0]?.detail ?? "Last pull errored."} ${lastPullPhrase}${fleetNote}` };
}

// ── Import ledger ────────────────────────────────────────────────────────────

export interface ImportMeta {
  rowsIn?: number;
  rowsWritten?: number;
  rowsSkipped?: number;
  detail?: string;
}

/** Append one import/pull attempt to the ledger. ok=false for a failed OR partial import. */
export function logImport(source: string, ok: boolean, m: ImportMeta = {}, now: Date = new Date()): void {
  getDb()
    .prepare(
      `INSERT INTO import_log (id, ts, source, ok, rows_in, rows_written, rows_skipped, detail)
       VALUES (?,?,?,?,?,?,?,?)`,
    )
    .run(`IL-${randomUUID()}`, now.toISOString(), source, ok ? 1 : 0, m.rowsIn ?? null, m.rowsWritten ?? null, m.rowsSkipped ?? null, m.detail ?? null);
}

export interface ImportRow {
  id: string;
  ts: string;
  source: string;
  ok: boolean;
  rowsIn: number | null;
  rowsWritten: number | null;
  rowsSkipped: number | null;
  detail: string | null;
}

export function getRecentImports(limit = 100): ImportRow[] {
  return (getDb().prepare("SELECT * FROM import_log ORDER BY ts DESC LIMIT ?").all(limit) as Record<string, unknown>[]).map((r) => ({
    id: String(r.id),
    ts: String(r.ts),
    source: String(r.source),
    ok: Number(r.ok) === 1,
    rowsIn: r.rows_in == null ? null : Number(r.rows_in),
    rowsWritten: r.rows_written == null ? null : Number(r.rows_written),
    rowsSkipped: r.rows_skipped == null ? null : Number(r.rows_skipped),
    detail: (r.detail as string) ?? null,
  }));
}

/** Latest import row per source (for the health view). */
export function getLatestImportBySource(): Record<string, ImportRow> {
  const rows = getRecentImports(500);
  const out: Record<string, ImportRow> = {};
  for (const r of rows) if (!out[r.source]) out[r.source] = r;
  return out;
}
