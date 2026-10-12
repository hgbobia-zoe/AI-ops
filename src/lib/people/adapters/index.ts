// Provisioning adapters — the extensibility seam. One adapter per system, all behind a single interface so
// a real integration can slot in later WITHOUT redesign. The governing honesty rule:
//
//   mode() reports "automated" ONLY when a scope-verified credential can truly perform the action.
//   It is NOT enough that an API key exists — the key must be recorded as carrying the write/admin scope
//   (hasVerifiedProvisioningScope). Until then the adapter degrades to a tracked manual/future task.
//
// Today only the Zoe-platform adapter is automated (it wraps our OWN DB via the exported auth functions).
// Everything else ships manual/future with an honest reason, structured so it can flip to automated once a
// real admin API + scope lands (Connecteam's comment marks its Tasks-API path).

import { getSecret } from "@/lib/secrets";
import { createInvite } from "@/lib/auth/invites";
import { getUser, setUserActive } from "@/lib/auth/users";
import type { AdapterMode, Employee, ProvisioningResult } from "../types";

export interface ProvisioningAdapter {
  id: string;
  system: string;
  /** The HONEST capability right now. `automated` requires a scope-verified credential (or being our own
   *  DB); otherwise manual/future. Recomputed each call so flipping a credential takes effect live. */
  mode(): AdapterMode;
  /** Grant access. Returns a result that maps onto the task's next status. Never throws for a "can't
   *  automate" case — it returns a manual_required result with an instruction. */
  automate(emp: Employee): Promise<ProvisioningResult>;
  /** Remove access. Same contract as automate(). */
  revoke(emp: Employee): Promise<ProvisioningResult>;
  /** Best-effort read-back of whether the person currently has access. */
  status(emp: Employee): Promise<{ provisioned: boolean; detail: string }>;
}

/**
 * Has the stored credential for this adapter been recorded as carrying the admin/user-write scope needed
 * to provision/deprovision? We store ONLY a scope assertion (never a third-party password) under
 * `<adapterId>.provisioningScope` = "verified". Nothing sets this today, so every external adapter is
 * honestly manual/future — gating mode() on a REAL scope record, not on "a key is present".
 */
export function hasVerifiedProvisioningScope(adapterId: string): boolean {
  return getSecret(`${adapterId}.provisioningScope`) === "verified";
}

// ── Zoe platform (AUTOMATED) ──────────────────────────────────────────────────────────────────────────
// The one reliably automatable system: our own users table. Provision = mint a one-time invite link (the
// new hire sets their OWN password at /join — we never create or store a password). Revoke = setUserActive
// (false), which also refuses any future login. Both reuse the EXPORTED auth functions; auth/* is never
// edited here.
class ZoePlatformAdapter implements ProvisioningAdapter {
  id = "zoe_platform";
  system = "Zoe platform login";
  mode(): AdapterMode {
    return "automated"; // our DB + our exported functions — truly automatable, no external scope needed
  }
  async automate(emp: Employee): Promise<ProvisioningResult> {
    // Already has an active login linked? Then it's provisioned — idempotent.
    if (emp.userId) {
      const u = getUser(emp.userId);
      if (u && u.active) return { ok: true, status: "completed", detail: `Login already active (${u.username}).` };
      if (u && !u.active) {
        setUserActive(emp.userId, true);
        return { ok: true, status: "completed", detail: `Reactivated the existing login (${u.username}).` };
      }
    }
    // Mint a one-time invite link; the hire picks their own username + password at /join. No password here.
    const invite = createInvite({
      role: emp.role,
      name: emp.displayName,
      invitedByName: "People Lifecycle",
    });
    const link = `/join?token=${invite.token}`;
    return {
      ok: true,
      status: "completed",
      externalRef: link,
      detail: `Invite link minted — share ${link}. The hire sets their own password (no password stored).`,
    };
  }
  async revoke(emp: Employee): Promise<ProvisioningResult> {
    if (!emp.userId) {
      return {
        ok: false,
        status: "manual_required",
        detail: "No Zoe login is linked to this employee — confirm the link, then revoke, or mark done if none exists.",
      };
    }
    setUserActive(emp.userId, false);
    return { ok: true, status: "completed", detail: "Login deactivated — sessions refuse and future logins are blocked." };
  }
  async status(emp: Employee): Promise<{ provisioned: boolean; detail: string }> {
    if (!emp.userId) return { provisioned: false, detail: "No login linked yet." };
    const u = getUser(emp.userId);
    if (!u) return { provisioned: false, detail: "Linked login not found." };
    return { provisioned: u.active, detail: u.active ? `Active (${u.username}).` : `Deactivated (${u.username}).` };
  }
}

// ── Generic manual / future adapter ───────────────────────────────────────────────────────────────────
// No admin API wired. It never fakes a write: automate()/revoke() return a manual_required result carrying
// a human instruction, and the engine creates a tracked task with a "Mark Complete" action (which records
// who/when). A `future` adapter is the same, but its reason says the integration does not exist at all yet.
class ManualAdapter implements ProvisioningAdapter {
  constructor(
    public id: string,
    public system: string,
    private readonly fallback: Exclude<AdapterMode, "automated">,
    private readonly reason: string,
  ) {}
  mode(): AdapterMode {
    // Could flip to automated ONLY if a real scope were verified — honest gate, not "key exists".
    return hasVerifiedProvisioningScope(this.id) ? "partial" : this.fallback;
  }
  private manual(kind: "provision" | "revoke"): ProvisioningResult {
    const verb = kind === "provision" ? "Create / invite" : "Disable / remove";
    return {
      ok: false,
      status: "manual_required",
      detail: `${verb} the ${this.system} account by hand (${this.reason}), then Mark Complete here.`,
    };
  }
  async automate(): Promise<ProvisioningResult> {
    return this.manual("provision");
  }
  async revoke(): Promise<ProvisioningResult> {
    return this.manual("revoke");
  }
  async status(): Promise<{ provisioned: boolean; detail: string }> {
    return { provisioned: false, detail: `No read-back — ${this.system} access is tracked manually.` };
  }
}

// The registry. Scaffold adapters carry an honest reason; Connecteam's notes the Tasks-API flip path.
const ADAPTERS: Record<string, ProvisioningAdapter> = {
  zoe_platform: new ZoePlatformAdapter(),
  connecteam: new ManualAdapter(
    "connecteam",
    "Connecteam",
    "manual",
    // DEFERRED (decision 3): the Tasks API (POST /tasks/v1/taskboards/{board}/tasks) could later auto-CREATE
    // an onboarding TASK — not a user. User create/deactivate is not wired and the key's scope is unverified,
    // so this stays manual until the board id + users/tasks scope are confirmed.
    "Connecteam has no wired user-provisioning API; the Tasks-API onboarding-task automation is deferred",
  ),
  quo: new ManualAdapter("quo", "Quo (OpenPhone)", "manual", "OpenPhone exposes no member-provisioning API — invite/disable the seat in the Quo dashboard"),
  slack: new ManualAdapter("slack", "Slack", "manual", "Slack invite/deactivate needs admin.users/SCIM scopes we do not hold — use the Slack admin console"),
  goodshuffle: new ManualAdapter("goodshuffle", "Goodshuffle Pro", "manual", "Goodshuffle has no public API; invite/revoke is a hand action in GSPRO"),
  gusto: new ManualAdapter("gusto", "Gusto", "future", "Gusto onboarding/termination is a human flow in Gusto; no admin-provisioning path exists in the app"),
  google: new ManualAdapter("google", "Google Workspace / SSO", "future", "No Google identity/SSO/SCIM is implemented anywhere in the app"),
};

/** The adapter for an id, or a generic manual fallback (future-proof against unknown policy rows). */
export function getAdapter(adapterId: string): ProvisioningAdapter {
  return ADAPTERS[adapterId] ?? new ManualAdapter(adapterId, adapterId, "manual", "no adapter registered — handle by hand");
}

/** Every registered adapter (for the Access Policies / Systems views). */
export function allAdapters(): ProvisioningAdapter[] {
  return Object.values(ADAPTERS);
}
