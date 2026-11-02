// Replay-provisioning endpoint registry — the SINGLE source of truth for "can we auto-provision this
// system by replaying its internal invite/disable request from a logged-in admin session?"
//
// Goodshuffle, Quo (OpenPhone) and Slack have NO official create-user API (unlike Connecteam). The only
// automatable path is the same "replay an internal endpoint from a logged-in session" pattern CLAUDE.md
// documents for every Goodshuffle write: capture the exact request ONCE from a real admin action while
// recording the network tab, then codify endpoint + body here. Until that capture happens the endpoint is
// `null`, and EVERYTHING downstream degrades honestly:
//   • the ProvisioningAdapter.mode() reports `manual` (never `automated`/`replay`), and
//   • the office-pull / extension drainer NO-OPS that system (it never invents a request).
//
// Nothing here is invented. Filling a constant is a deliberate human step (see docs/provisioning-adapters.md).

/** A captured internal request, replayed same-origin with credentials:"include" from a logged-in session. */
export interface ReplayEndpoint {
  /** HTTP method of the captured request. */
  method: "POST" | "PUT" | "DELETE";
  /** Same-origin path (e.g. "/app/.../invite"), replayed inside the system's own logged-in tab. */
  path: string;
  /** How the body is encoded — matches what the captured request sent. */
  bodyType: "json" | "form";
}

export interface SystemReplayEndpoints {
  /** The logged-in admin origin this must run inside (credentials:"include" only reaches same-origin). */
  origin: string;
  /** The captured "create/invite a member" request — null until captured. */
  provision: ReplayEndpoint | null;
  /** The captured "disable/remove a member" request — null until captured. */
  revoke: ReplayEndpoint | null;
  /** What we already know about this system's flow (seat/billing, read endpoints). Shown in the docs/UI. */
  notes?: string;
}

export type ReplaySystem = "goodshuffle" | "quo" | "slack" | "squarespace_email" | "weddingpro" | "yelp" | "lockly";

// All null = capture-pending. Fill a system's provision/revoke with the EXACT captured request + body
// encoding, then the adapter flips to automated and the drainer starts replaying it.
export const PROVISION_ENDPOINTS: Record<ReplaySystem, SystemReplayEndpoints> = {
  goodshuffle: {
    origin: "https://pro.goodshuffle.com",
    // CAPTURE-PENDING: record the "invite a team member" request once from a logged-in GSPRO admin session
    // (Settings → Team → Invite), then fill { method, path, bodyType } here. This drains in the office pull
    // (same origin as the Goodshuffle tab).
    provision: null,
    // CAPTURE-PENDING: record the "remove / deactivate a team member" request once from GSPRO admin.
    revoke: null,
    // Mapped live 2026-11-02 (read-only): Account → Subscriptions → Team Management. The team list is
    // GET /app/subscriptionSeat/list ({subscriptionSeats:[{id,status,fullUser,hasAdminPrivileges,
    // invitationEmail,interval,employee:{fullName,email}}]}). "Invite Teammate" takes email + seat type
    // (Full/Limited) + billing interval and BUYS a seat ($49/mo Full), so it always rides the approval gate.
    notes: "Invite = email + seat Full + Monthly; buys a $49/mo seat. Team list: GET /app/subscriptionSeat/list.",
  },
  quo: {
    origin: "https://my.openphone.com",
    // CAPTURE-PENDING: record the "invite a member" request once from a logged-in Quo/OpenPhone admin
    // session, then fill it here. Quo runs on its OWN origin, so this replays from a logged-in Quo tab
    // (its own content script / bookmarklet), not the Goodshuffle pull.
    provision: null,
    // CAPTURE-PENDING: record the "remove / suspend a member" request once from Quo admin.
    revoke: null,
  },
  slack: {
    origin: "https://app.slack.com",
    // CAPTURE-PENDING: record the "invite member" request once from a logged-in Slack admin session, then
    // fill it here. Replays from a logged-in Slack tab (its own origin).
    provision: null,
    // CAPTURE-PENDING: record the "deactivate member" request once from Slack admin.
    revoke: null,
  },
  squarespace_email: {
    origin: "https://account.squarespace.com",
    // CAPTURE-PENDING: Google Workspace mailbox billed through Squarespace (firstname.lastname@zoeeventsdmv.com).
    // Record "add user" once from Squarespace → Email. If seats are managed in admin.google.com instead,
    // this flips to the official Google Admin Directory API (users.insert / users.update suspended=true).
    provision: null,
    revoke: null,
    notes: "Mailbox = firstname.lastname@zoeeventsdmv.com. Suspend on offboarding, do not delete (keeps mail).",
  },
  weddingpro: {
    origin: "https://pros.weddingpro.com",
    // CAPTURE-PENDING: record "add team member" once from WeddingPro (The Knot / WeddingWire) admin.
    provision: null,
    revoke: null,
  },
  yelp: {
    origin: "https://biz.yelp.com",
    // CAPTURE-PENDING: record "add user" once from Yelp for Business → Account settings → Users.
    provision: null,
    revoke: null,
  },
  lockly: {
    origin: "https://lockly.com",
    // CAPTURE-PENDING: door access (eKey / access code). If Lockly is app-only this stays a manual step.
    // Offboarding revokes this FIRST (physical access).
    provision: null,
    revoke: null,
    notes: "Physical door access. Revoked first on offboarding.",
  },
};

/** True when the given system has a captured endpoint for this action (so it can be replayed). */
export function hasCapturedEndpoint(system: ReplaySystem, kind: "provision" | "revoke"): boolean {
  const sys = PROVISION_ENDPOINTS[system];
  return Boolean(sys && sys[kind]);
}

/** The replay systems in id order (for the Systems view / the drainer). */
export const REPLAY_SYSTEMS: ReplaySystem[] = ["goodshuffle", "quo", "slack", "squarespace_email", "weddingpro", "yelp", "lockly"];
