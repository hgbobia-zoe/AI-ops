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
  /** "extension": replayed in the ONBOARDER's own Chrome by the Auto-Pull extension, in a visible tab they can
   *  sign in on (extension/provision.js holds the per-system steps). Absent: the office Goodshuffle pull. */
  runner?: "extension";
  /** Why the run stops for the onboarder's OK first: a paid seat (the live price is shown) or a broad role. */
  approval?: "paid" | "owner_role";
}

export type ReplaySystem = "goodshuffle" | "quo" | "slack" | "squarespace_email" | "weddingpro" | "yelp" | "whimsical";

// All null = capture-pending. Fill a system's provision/revoke with the EXACT captured request + body
// encoding, then the adapter flips to automated and the drainer starts replaying it.
export const PROVISION_ENDPOINTS: Record<ReplaySystem, SystemReplayEndpoints> = {
  goodshuffle: {
    origin: "https://pro.goodshuffle.com",
    // Captured live 2026-11-11 (Account → Subscriptions → Team Management → Invite Teammate):
    // POST /app/subscriptionSeat/bulkPurchaseSeats {seatsToPurchase:[{invitationEmail,fullUser,interval}],
    // stripePromoCodeID:null, addingFromAccountShare:false}. Buys a seat (Full monthly $59, annual $49/mo paid
    // up front), so it always waits for the onboarder's OK. Runs in the onboarder's Chrome, not the office pull.
    provision: { method: "POST", path: "/app/subscriptionSeat/bulkPurchaseSeats", bodyType: "json" },
    // CAPTURE-PENDING: removing a teammate (seat cancel) — offboarding stays manual.
    revoke: null,
    runner: "extension",
    approval: "paid",
    notes: "Invite = email + Full seat + monthly; buys a $59/mo seat. Team list: GET /app/subscriptionSeat/list.",
  },
  quo: {
    origin: "https://my.quo.com",
    // Captured live 2026-11-10 (docs/provisioning-captures.md). Quo's API wants an app version header the page
    // builds at runtime, so the extension fills Quo's own Invite form instead (shared Zoe Events line, Member).
    provision: { method: "POST", path: "https://account.openphoneapi.com/v2/org/OR9X6MA29e/invite/bulk", bodyType: "json" },
    revoke: null,
    runner: "extension",
    approval: "paid",
    notes: "Invite on the shared Zoe Events line (never a new number). Adds a $33/month seat.",
  },
  slack: {
    origin: "https://app.slack.com",
    // Captured live 2026-11-10: users.admin.inviteBulk with the web client's session token (free plan).
    provision: { method: "POST", path: "/api/users.admin.inviteBulk", bodyType: "form" },
    // The signed-in Slack account is not a workspace admin, so deactivating stays a manual step.
    revoke: null,
    runner: "extension",
    notes: "Slack emails the invite; the step closes when the hire shows up in Slack (bot lookup).",
  },
  squarespace_email: {
    origin: "https://crocodile-chimes-jm6d.squarespace.com",
    // Captured live 2026-11-10: validate → preview-quantity-change → billing-requests/quantity-change (+ poll).
    provision: { method: "POST", path: "/api/billing/billing-requests/quantity-change", bodyType: "json" },
    revoke: null,
    runner: "extension",
    approval: "paid",
    notes: "Mailbox = firstname.lastname@zoeeventsdmv.com, $8.40/month seat. Suspend on offboarding, do not delete.",
  },
  weddingpro: {
    origin: "https://www.weddingpro.com",
    // Captured live 2026-11-10: POST /wpapi/employee. Its session header is built from protected cookies, so
    // the extension fills WeddingPro's own Invite user form (Storefront manager role).
    provision: { method: "POST", path: "/wpapi/employee", bodyType: "json" },
    revoke: null,
    runner: "extension",
  },
  yelp: {
    origin: "https://biz.yelp.com",
    // Captured live 2026-11-10: GraphQL CreateOrganizationInvite on /gql/batch. Yelp only offers OWNER.
    provision: { method: "POST", path: "/gql/batch", bodyType: "json" },
    revoke: null,
    runner: "extension",
    approval: "owner_role",
    notes: "Invite grants OWNER (can buy ads on the card on file); asks for the password again first.",
  },
  whimsical: {
    origin: "https://whimsical.com",
    // Captured live 2026-11-11 (workspace menu → Invite people): POST /api/workspace.invite, Transit-JSON
    // ["^ ","~:emails",["~#list",[email]],"~:editor",true,"~:team-ids",["~#set",[]],"~:workspace-id","~u<id>"]
    // with Content-Type/Accept application/transit+json. Free plan, so no charge.
    provision: { method: "POST", path: "/api/workspace.invite", bodyType: "json" },
    revoke: null,
    runner: "extension",
    notes: "Invite as Editor to the Zoe Event Rentals workspace (free plan).",
  },
};

/** True when this system is replayed in the onboarder's own Chrome (not the office Goodshuffle pull). */
export function runsInChrome(system: string): boolean {
  return (PROVISION_ENDPOINTS as Record<string, SystemReplayEndpoints | undefined>)[system]?.runner === "extension";
}

/** True when the given system has a captured endpoint for this action (so it can be replayed). */
export function hasCapturedEndpoint(system: ReplaySystem, kind: "provision" | "revoke"): boolean {
  const sys = PROVISION_ENDPOINTS[system];
  return Boolean(sys && sys[kind]);
}

/** The replay systems in id order (for the Systems view / the drainer). */
export const REPLAY_SYSTEMS: ReplaySystem[] = ["goodshuffle", "quo", "slack", "squarespace_email", "weddingpro", "yelp", "whimsical"];
