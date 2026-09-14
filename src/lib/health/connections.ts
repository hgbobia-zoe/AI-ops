// Connections health — the team-facing "what's wired up, what needs a hand" view. One row per
// integration, in three plain states: OK (green), ATTENTION (configured but not working — the team can
// fix it), OFF (not connected yet). Built from signals we already persist (pull freshness + the
// extension heartbeat + import ledger) and from config presence (provider secrets). Never fabricates:
// an unconfigured integration is OFF, not "healthy".

import { getPullState } from "@/lib/pull/state";
import { computeDataHealth, type HealthState } from "./health";
import { openphoneApiKey } from "@/lib/comms/openphone";
import { connecteamConfigured } from "@/lib/connecteam";
import { slackConfigured, slackAlertConfigured } from "@/lib/notify/slack";
import { llmConfigured } from "@/lib/llm";
import { getSettings } from "@/lib/settings";
import { loadGpsConfig, gpsProviderById } from "@/lib/providers";
import { zonarConfigured, rateLimitedUntil } from "@/lib/eta/zonar";

export type ConnStatus = "ok" | "attention" | "off";
export type ConnCategory = "Data pull" | "Communications" | "AI" | "GPS";

export interface Connection {
  key: string;
  label: string;
  category: ConnCategory;
  status: ConnStatus;
  headline: string; // 1-3 word state, e.g. "Pulling", "Signed out", "Not connected"
  detail: string; // one line: what it is / why it needs attention
  lastAt: string | null; // ISO of the last good signal, when we have one
  fixHref: string | null; // where the team goes to fix it
  fixLabel: string | null;
  // Testable live: provider-module creds via /api/integrations/test, or GPS TrackIt via /api/eta/units.
  test?: { kind: "sms" | "gps"; provider: string } | { kind: "gpstrackit" } | null;
}

const AGENT_FRESH_MIN = 30; // a heartbeat older than this means the puller isn't running

/** Map a Data-Health source state to a connection status. */
function fromHealth(s: HealthState): ConnStatus {
  if (s === "FRESH") return "ok";
  if (s === "UNVERIFIED") return "off";
  return "attention"; // STALE / INCOMPLETE / RETRIEVAL_FAILED / NEVER
}

export function computeConnections(now: number = Date.now()): Connection[] {
  const out: Connection[] = [];
  const st = getPullState();
  const health = computeDataHealth();
  const routes = health.find((h) => h.key === "routes");
  const bookings = health.find((h) => h.key === "bookings");

  // ── Auto-Pull extension (the office-machine puller that feeds routes + bookings) ──
  const agent = st.agent;
  const ageMin = agent ? (now - Date.parse(agent.at)) / 60000 : Infinity;
  let ext: Connection;
  if (agent && ageMin <= AGENT_FRESH_MIN) {
    if (agent.status === "ok") {
      ext = { key: "extension", label: "Auto-Pull extension", category: "Data pull", status: "ok", headline: "Pulling", detail: agent.detail || "Reporting in and pulling on schedule.", lastAt: agent.at, fixHref: null, fixLabel: null };
    } else if (agent.status === "not_logged_in") {
      ext = { key: "extension", label: "Auto-Pull extension", category: "Data pull", status: "attention", headline: "Goodshuffle signed out", detail: "Open pro.goodshuffle.com on the office machine and sign in.", lastAt: agent.at, fixHref: "/admin/pull", fixLabel: "How to fix" };
    } else if (agent.status === "no_tab") {
      ext = { key: "extension", label: "Auto-Pull extension", category: "Data pull", status: "attention", headline: "No Goodshuffle tab", detail: "Open a signed-in pro.goodshuffle.com tab in the office browser so the pull can run.", lastAt: agent.at, fixHref: "/admin/pull", fixLabel: "How to fix" };
    } else {
      ext = { key: "extension", label: "Auto-Pull extension", category: "Data pull", status: "attention", headline: "Last pull errored", detail: agent.detail || "The last pull hit a problem.", lastAt: agent.at, fixHref: "/admin/pull", fixLabel: "How to fix" };
    }
  } else {
    ext = {
      key: "extension",
      label: "Auto-Pull extension",
      category: "Data pull",
      status: "attention",
      headline: agent ? "Not reporting in" : "Never installed",
      detail: agent
        ? `No heartbeat for ${Math.round(ageMin)} min — the extension/browser may be closed on the office machine.`
        : "Install the Auto-Pull extension on the office machine so data refreshes on its own.",
      lastAt: agent?.at ?? null,
      fixHref: "/admin/pull",
      fixLabel: "How to fix",
    };
  }
  out.push(ext);

  // ── Goodshuffle routes + bookings (fed by the pull) ──
  if (routes) {
    out.push({
      key: "routes",
      label: "Goodshuffle routes",
      category: "Data pull",
      status: fromHealth(routes.state),
      headline: routes.state === "FRESH" ? "Fresh" : routes.state === "NEVER" ? "No data" : routes.state === "STALE" ? "Stale" : routes.state === "RETRIEVAL_FAILED" ? "Pull failed" : routes.state === "INCOMPLETE" ? "Incomplete" : "Unverified",
      detail: routes.detail + (routes.ageH != null ? ` · ${routes.ageH}h ago` : ""),
      lastAt: routes.lastAt,
      fixHref: fromHealth(routes.state) === "ok" ? null : "/admin/pull",
      fixLabel: fromHealth(routes.state) === "ok" ? null : "Open pull",
    });
  }
  if (bookings) {
    out.push({
      key: "bookings",
      label: "Goodshuffle bookings",
      category: "Data pull",
      status: fromHealth(bookings.state),
      headline: bookings.state === "FRESH" ? "Fresh" : bookings.state === "NEVER" ? "No data" : bookings.state === "STALE" ? "Stale" : bookings.state === "RETRIEVAL_FAILED" ? "Pull failed" : bookings.state === "INCOMPLETE" ? "Incomplete" : "Unverified",
      detail: bookings.detail + (bookings.ageH != null ? ` · ${bookings.ageH}h ago` : ""),
      lastAt: bookings.lastAt,
      fixHref: fromHealth(bookings.state) === "ok" ? null : "/admin/pull",
      fixLabel: fromHealth(bookings.state) === "ok" ? null : "Open pull",
    });
  }

  // ── OpenPhone / Quo (calls + texts + coaching transcripts) ──
  const quoOn = !!openphoneApiKey();
  out.push({
    key: "openphone",
    label: "OpenPhone / Quo",
    category: "Communications",
    status: quoOn ? "ok" : "off",
    headline: quoOn ? "Connected" : "Not connected",
    detail: quoOn ? "Calls, texts, and coaching transcripts." : "Add the OpenPhone API key to enable texts + call coaching.",
    lastAt: null,
    fixHref: quoOn ? null : "/admin",
    fixLabel: quoOn ? null : "Open settings",
    test: { kind: "sms", provider: "openphone" },
  });

  // ── Connecteam (staffing / labor cost) ──
  const ct = health.find((h) => h.key === "connecteam");
  const ctOn = connecteamConfigured();
  out.push({
    key: "connecteam",
    label: "Connecteam",
    category: "Communications",
    status: ctOn ? (ct && ct.state !== "FRESH" && ct.state !== "UNVERIFIED" ? "attention" : "ok") : "off",
    headline: ctOn ? (ct && ct.state === "RETRIEVAL_FAILED" ? "Unreachable" : "Connected") : "Not connected",
    detail: ctOn ? (ct?.detail ?? "Crew scheduling for staffing + labor cost.") : "Add the Connecteam API key to pull crew scheduling.",
    lastAt: ct?.lastAt ?? null,
    fixHref: ctOn ? null : "/admin",
    fixLabel: ctOn ? null : "Open settings",
  });

  // ── Slack notifications (delivery + customer alerts) ──
  const slackOn = slackConfigured();
  const alertsOn = slackAlertConfigured();
  out.push({
    key: "slack",
    label: "Slack notifications",
    category: "Communications",
    status: slackOn || alertsOn ? "ok" : "off",
    headline: slackOn || alertsOn ? "Connected" : "Not connected",
    detail:
      slackOn || alertsOn
        ? `Delivery alerts ${slackOn ? "on" : "off"} · Customer alerts ${alertsOn ? "on" : "off"}.`
        : "Add a Slack webhook to send delivery + customer alerts.",
    lastAt: null,
    fixHref: slackOn && alertsOn ? null : "/admin",
    fixLabel: slackOn && alertsOn ? null : "Open settings",
  });

  // ── Coaching AI model ──
  const aiOn = llmConfigured();
  out.push({
    key: "llm",
    label: "Coaching AI model",
    category: "AI",
    status: aiOn ? "ok" : "off",
    headline: aiOn ? "Connected" : "Not connected",
    detail: aiOn ? "Generates call recaps + coaching." : "Set ANTHROPIC_API_KEY to enable call recaps.",
    lastAt: null,
    fixHref: aiOn ? null : "/admin",
    fixLabel: aiOn ? null : "Open settings",
  });

  // ── GPS / live ETA ──
  const gpsId = getSettings().gpsProvider;
  const gpsDef = gpsProviderById(gpsId);
  if (gpsId === "zonar") {
    // Zonar = GPS TrackIt (cloud-api.gpstrackit.com), the server-side source that powers live ETA and
    // truck location viewable from anywhere (src/lib/eta/zonar.ts → liveEta.ts). Key-gated by
    // GPSTRACKIT_API_KEY; may be temporarily backing off after a rate-limit.
    const on = zonarConfigured();
    const limited = on && rateLimitedUntil() > now;
    out.push({
      key: "gps",
      label: "GPS / live ETA",
      category: "GPS",
      status: on ? (limited ? "attention" : "ok") : "off",
      headline: on ? (limited ? "Rate-limited" : "Live") : "Not connected",
      detail: on
        ? limited
          ? "GPS TrackIt is backing off after a rate-limit; live location resumes shortly."
          : "GPS TrackIt — truck location + ETA, viewable from anywhere."
        : "Set GPSTRACKIT_API_KEY to show live truck location + ETA from anywhere.",
      lastAt: null,
      fixHref: on ? null : "/admin",
      fixLabel: on ? null : "Configure",
      test: { kind: "gpstrackit" },
    });
  } else if (!gpsDef.serverSide) {
    // Any other non-server-side provider: handled on the device, nothing to wire up server-side.
    out.push({
      key: "gps",
      label: "GPS / live ETA",
      category: "GPS",
      status: "ok",
      headline: "On the tablet",
      detail: `${gpsDef.name} — handled on the truck tablet; nothing to configure here.`,
      lastAt: null,
      fixHref: null,
      fixLabel: null,
      test: null,
    });
  } else {
    // API provider (Samsara/Motive): connected when its required credential(s) are stored. The Test
    // button verifies them live against the provider's API.
    const cfg = loadGpsConfig(gpsId);
    const requiredKeys = gpsDef.fields.filter((f) => f.secret).map((f) => f.key);
    const missing = requiredKeys.filter((k) => !(cfg[k] && cfg[k].trim()));
    const on = requiredKeys.length > 0 && missing.length === 0;
    out.push({
      key: "gps",
      label: "GPS / live ETA",
      category: "GPS",
      status: on ? "ok" : "off",
      headline: on ? "Connected" : "Not connected",
      detail: on ? `${gpsDef.name} — live ETA on demand.` : `${gpsDef.name} selected but credentials missing${missing.length ? ` (${missing.join(", ")})` : ""}.`,
      lastAt: null,
      fixHref: "/admin",
      fixLabel: on ? "Settings" : "Configure",
      test: { kind: "gps", provider: gpsId },
    });
  }

  // Problems first, then not-connected, then healthy — so what needs attention is on top.
  const rank: Record<ConnStatus, number> = { attention: 0, off: 1, ok: 2 };
  return out.sort((a, b) => rank[a.status] - rank[b.status]);
}

export interface ConnectionsSummary {
  ok: number;
  attention: number;
  off: number;
}
export function summarize(conns: Connection[]): ConnectionsSummary {
  return {
    ok: conns.filter((c) => c.status === "ok").length,
    attention: conns.filter((c) => c.status === "attention").length,
    off: conns.filter((c) => c.status === "off").length,
  };
}
