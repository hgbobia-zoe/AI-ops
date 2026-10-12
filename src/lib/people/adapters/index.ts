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
import { archiveConnecteamUser, connecteamConfigured, createConnecteamUser } from "@/lib/connecteam";
import { enqueueProvisioningOp } from "@/lib/db/repo";
import { setEmployeeConnecteamUserId } from "../store";
import { hasCapturedEndpoint, PROVISION_ENDPOINTS, type ReplaySystem } from "../provisioningEndpoints";
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

/** Split a display name into first + last for an external system that wants them separately. */
function splitName(displayName: string): { firstName: string; lastName: string } {
  const parts = displayName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: "", lastName: "" };
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

// ── Connecteam (REAL automation — official users API) ──────────────────────────────────────────────────
// Connecteam is the ONE external system with an official create/archive user API, so this adapter genuinely
// automates when the key's `users.write` scope is VERIFIED (recorded as `connecteam.provisioningScope` =
// "verified", set after connecteamWriteProbe() returns a non-403 — a real capability check, never "a key
// exists"). provision = create the user (NO activation SMS — sendActivation defaults false) + link the
// returned userId onto the employee + audit via the engine. revoke = archive (reversible). A 403 at run
// time degrades to a manual task (scopeMissing) — it never fakes a write.
class ConnecteamAdapter implements ProvisioningAdapter {
  id = "connecteam";
  system = "Connecteam";
  mode(): AdapterMode {
    // Automated ONLY when the write scope is verified. A bare key is NOT enough.
    return hasVerifiedProvisioningScope(this.id) ? "automated" : "manual";
  }
  async automate(emp: Employee): Promise<ProvisioningResult> {
    if (emp.connecteamUserId) {
      return { ok: true, status: "completed", externalRef: `connecteam:${emp.connecteamUserId}`, detail: `Already a Connecteam user (#${emp.connecteamUserId}).` };
    }
    if (!connecteamConfigured()) {
      return { ok: false, status: "manual_required", detail: "Connecteam API key not configured — create the user by hand, then Mark Complete." };
    }
    if (!emp.phone) {
      return { ok: false, status: "blocked", detail: "Phone required — add the hire's mobile (E.164) to the employee record to provision Connecteam." };
    }
    const { firstName, lastName } = splitName(emp.displayName);
    const res = await createConnecteamUser(
      [{ firstName, lastName, phoneNumber: emp.phone, userType: "user", email: emp.workEmail ?? undefined }],
      { sendActivation: false },
    );
    if (res.scopeMissing) {
      return { ok: false, status: "manual_required", detail: "Connecteam key lacks the users.write scope — enable it (or create the user by hand), then Mark Complete." };
    }
    if (!res.ok || res.userId == null) {
      return { ok: false, status: "failed", detail: `Connecteam create failed: ${res.error ?? `HTTP ${res.status}`}.` };
    }
    setEmployeeConnecteamUserId(emp.id, res.userId);
    return { ok: true, status: "completed", externalRef: `connecteam:${res.userId}`, detail: `Created Connecteam user #${res.userId} (no activation SMS sent).` };
  }
  async revoke(emp: Employee): Promise<ProvisioningResult> {
    if (!emp.connecteamUserId) {
      return { ok: false, status: "manual_required", detail: "No Connecteam user linked — confirm the link then revoke, or Mark Complete if none exists." };
    }
    if (!connecteamConfigured()) {
      return { ok: false, status: "manual_required", detail: "Connecteam API key not configured — archive the user by hand, then Mark Complete." };
    }
    const res = await archiveConnecteamUser(emp.connecteamUserId);
    if (res.scopeMissing) {
      return { ok: false, status: "manual_required", detail: "Connecteam key lacks the users.write scope — archive the user by hand, then Mark Complete." };
    }
    if (!res.ok) {
      return { ok: false, status: "failed", detail: `Connecteam archive failed: ${res.error ?? `HTTP ${res.status}`}.` };
    }
    return { ok: true, status: "completed", detail: `Archived Connecteam user #${emp.connecteamUserId} (access removed; reversible).` };
  }
  async status(emp: Employee): Promise<{ provisioned: boolean; detail: string }> {
    if (!emp.connecteamUserId) return { provisioned: false, detail: "No Connecteam user linked yet." };
    return { provisioned: true, detail: `Linked to Connecteam user #${emp.connecteamUserId}.` };
  }
}

// ── Replay adapter (Goodshuffle / Quo / Slack) — endpoint capture-pending ────────────────────────────────
// No official create-user API exists, so the only automatable path is replaying a captured internal invite/
// disable request from a logged-in admin session (the CLAUDE.md pattern). This adapter is the FRAMEWORK:
//   • mode() = automated ONLY when the system's endpoint constant is captured (non-null) — else manual.
//   • automate()/revoke() (on approval) enqueue a provision_user/revoke_user gs_outbox op for the drainer to
//     replay; while the endpoint is uncaptured they create an honest manual task instead (never fake a write).
// The actual same-origin replay lives in the office pull / extension drainer (src/lib/gsPull.ts), gated on
// the SAME endpoint constant — so one capture flips both mode() and the drainer together.
class ReplayAdapter implements ProvisioningAdapter {
  constructor(
    public id: string,
    public system: string,
    private readonly sys: ReplaySystem,
  ) {}
  mode(): AdapterMode {
    // "automated" here means "replay-ready" — a captured endpoint the drainer can replay. Else manual.
    return hasCapturedEndpoint(this.sys, "provision") ? "automated" : "manual";
  }
  private captureReason(kind: "provision" | "revoke"): string {
    return `No captured ${this.system} ${kind === "provision" ? "invite" : "disable"} endpoint yet — do it by hand in ${this.system} (${PROVISION_ENDPOINTS[this.sys].origin}), then Mark Complete. See docs/provisioning-adapters.md to codify the replay.`;
  }
  private empData(emp: Employee): Record<string, unknown> {
    const { firstName, lastName } = splitName(emp.displayName);
    return { displayName: emp.displayName, firstName, lastName, email: emp.workEmail, phone: emp.phone, role: emp.role };
  }
  async automate(emp: Employee): Promise<ProvisioningResult> {
    if (!hasCapturedEndpoint(this.sys, "provision")) {
      return { ok: false, status: "manual_required", detail: this.captureReason("provision") };
    }
    const op = enqueueProvisioningOp({ kind: "provision", system: this.sys, employeeId: emp.id, label: `invite ${emp.displayName} to ${this.system}`, data: this.empData(emp) });
    return { ok: true, status: "in_progress", externalRef: `gs_outbox:${op.id}`, detail: `Queued for the logged-in ${this.system} session to replay the invite; completes when the drainer acks.` };
  }
  async revoke(emp: Employee): Promise<ProvisioningResult> {
    if (!hasCapturedEndpoint(this.sys, "revoke")) {
      return { ok: false, status: "manual_required", detail: this.captureReason("revoke") };
    }
    const op = enqueueProvisioningOp({ kind: "revoke", system: this.sys, employeeId: emp.id, label: `disable ${emp.displayName} in ${this.system}`, data: this.empData(emp) });
    return { ok: true, status: "in_progress", externalRef: `gs_outbox:${op.id}`, detail: `Queued for the logged-in ${this.system} session to replay the disable; completes when the drainer acks.` };
  }
  async status(): Promise<{ provisioned: boolean; detail: string }> {
    return { provisioned: false, detail: `No read-back — ${this.system} access is tracked via the lifecycle task.` };
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

// The registry. Connecteam is REAL automation (official API, gated on a verified write scope). Goodshuffle/
// Quo/Slack are the replay FRAMEWORK (automated once their endpoint is captured, else manual). Gusto/Google
// stay `future` (no mechanism exists at all).
const ADAPTERS: Record<string, ProvisioningAdapter> = {
  zoe_platform: new ZoePlatformAdapter(),
  connecteam: new ConnecteamAdapter(),
  quo: new ReplayAdapter("quo", "Quo (OpenPhone)", "quo"),
  slack: new ReplayAdapter("slack", "Slack", "slack"),
  goodshuffle: new ReplayAdapter("goodshuffle", "Goodshuffle Pro", "goodshuffle"),
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
