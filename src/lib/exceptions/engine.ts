// WS05 — the coordination ENGINE. Thin, deterministic glue that ties the detectors, the DETERMINISTIC
// policy, the SHARED approval→outbox path (WS02/aiorg), and WS03's verification contract together into one
// honest lifecycle per exception:
//
//   detect → dedupe/classify → (propose authorized action | delegate to a role | escalate) → VERIFY via
//   getApprovalLifecycle → resolve on a confirmed landing | escalate on failure | surface as unverifiable.
//
// What this engine does NOT do (by design, per the brief):
//   • It never executes an action itself — it PROPOSES via createApproval; a human approves; WS02's
//     decideApproval enqueues the proven gs_outbox op; WS03's ackGsOp/reconcileApprovalForOp verifies.
//   • It never adds a second reconciliation path or a new orchestration bus.
//   • It never silently marks-done: `resolved` requires a VERIFIED landing (getApprovalLifecycle=confirmed)
//     or a human disposition. Disappearance from a scan becomes `unverifiable`, never `resolved`.
//   • It never proposes a money/pricing/schedule/hiring/instawork action — the policy downgrades those to
//     delegate, and the approval path forbids them even if one slipped through.

import { createApproval, getApprovalLifecycle, type ApprovalCard } from "@/lib/aiorg/approvals";
import { slackNotify } from "@/lib/notify/slack";
import { botAnnounce, type BotId } from "@/lib/notify/aiBots";
import { getJson, setJson } from "@/lib/kv";
import { decideJobAlert, type JobAlertRecord } from "@/lib/ai/responderHealth";
import { detectAllExceptions } from "./adapters";
import { escalationTier, ownerRoleFor, planResolution } from "./policy";
import {
  exceptionSummary,
  getException,
  listOpenNotIn,
  setFields,
  upsertException,
  type ExceptionSummary,
} from "./store";
import {
  exceptionKey,
  TERMINAL_STATUSES,
  type CanonicalException,
  type EscalationTier,
  type ExceptionResolution,
  type OwnerRole,
} from "./types";

// ── Owner-role → Slack bot (team-tier escalation posts to the owning domain's channel) ─────────────────
const ROLE_BOT: Record<OwnerRole, BotId> = {
  scheduling: "scheduling",
  dispatch: "ops",
  warehouse: "inventory",
  sales: "sales",
  finance: "ops",
  ops: "ops",
};

const ESCALATION_COOLOFF_MS = 2 * 60 * 60 * 1000; // 2h — house convention (matches the sibling alarms)
const ESCALATION_KEY_PREFIX = "ai.exception.escalation."; // its OWN kv namespace (per key+tier)

// ── Card builder (deterministic — the six fields come straight from the facts; no LLM decision) ─────────
function buildCard(e: CanonicalException, reason: string): ApprovalCard {
  const action = e.recommendedAction ?? e.detail;
  return {
    what: `Create a Goodshuffle task on the project: ${action}`,
    why: `${e.title} — ${e.detail}`,
    dataUsed: `Event Risk Engine signal ${e.sourceId} (type ${e.type}), Goodshuffle transaction ${e.transactionId ?? "n/a"}.`,
    expectedOutcome: "The recommended action is tracked on the Goodshuffle project so the responsible team sees and acts on it.",
    risk: "Low — this writes a tracking task only; it changes no money, schedule, or crew. A human approves before it sends.",
    whatIfApproved: reason,
  };
}

// ── Verify-after-act: read WS03's lifecycle and honestly reconcile OUR exception state ─────────────────
function verifyLanded(resolution: ExceptionResolution, now: Date): ExceptionResolution {
  const key = resolution.key;
  if (!resolution.approvalId) return resolution;
  const lc = getApprovalLifecycle(resolution.approvalId);
  if (!lc) {
    return (
      setFields(key, { status: "unverifiable", nextAction: "The linked approval record vanished; the resolution cannot be verified. Needs a human." }, now) ??
      resolution
    );
  }
  const nowIso = now.toISOString();
  switch (lc.phase) {
    case "confirmed":
      return (
        setFields(
          key,
          {
            status: "resolved",
            resolvedAt: nowIso,
            verificationEvidence: { phase: "confirmed", outboxOpId: lc.op?.id ?? null, attempts: lc.op?.attempts ?? null, confirmedAt: nowIso },
            nextAction: "Resolution landed — Goodshuffle accepted the write (destination acceptance, not a recipient read receipt).",
          },
          now,
        ) ?? resolution
      );
    case "failed":
      return (
        setFields(
          key,
          {
            status: "failed",
            resolveAttempts: resolution.resolveAttempts + 1,
            lastAttemptAt: nowIso,
            nextAction: "The approved resolution failed to land (dead-lettered). Escalating for a human to intervene.",
          },
          now,
        ) ?? resolution
      );
    case "queued":
      return setFields(key, { status: "acting", nextAction: "Approved and queued to Goodshuffle; awaiting the office drainer to confirm it landed." }, now) ?? resolution;
    case "held":
      return (
        setFields(
          key,
          {
            status: "delegated",
            assignedRole: resolution.assignedRole ?? "ops",
            nextAction: "Approved, but execution is held (send gate off / not autonomously executable). A human must complete it.",
          },
          now,
        ) ?? resolution
      );
    case "rejected":
      return (
        setFields(
          key,
          { status: "disposed", disposition: "A human rejected the proposed resolution.", disposedBy: lc.approval.decidedBy ?? "human" },
          now,
        ) ?? resolution
      );
    case "proposed":
    case "needs_input":
      return setFields(key, { status: "awaiting_approval", nextAction: "Awaiting a human decision on the proposed Goodshuffle task." }, now) ?? resolution;
    default:
      return setFields(key, { status: "unverifiable", nextAction: "The resolution is in an unknown state; a human should check it." }, now) ?? resolution;
  }
}

// ── Route a FRESH resolution (only for a still-`active` exception) ──────────────────────────────────────
function routeResolution(resolution: ExceptionResolution, e: CanonicalException, now: Date): ExceptionResolution {
  const key = resolution.key;
  const plan = planResolution(e);
  const nowIso = now.toISOString();

  if (plan.kind === "propose" && plan.actionType === "create_gs_task" && e.transactionId) {
    // Idempotent: createApproval keys on `exc:<key>`, so re-proposing never duplicates (mission #3).
    const approval = createApproval({
      agentId: "event-risk",
      owner: e.ownerHint ?? "Ops",
      title: e.title,
      actionType: "create_gs_task",
      actionPayload: { transactionId: e.transactionId, title: `Risk: ${e.title}`, note: e.recommendedAction ?? e.detail },
      card: buildCard(e, plan.reason),
      idempotencyKey: `exc:${key}`,
    });
    return (
      setFields(
        key,
        {
          status: "awaiting_approval",
          approvalId: approval.id,
          assignedRole: plan.role ?? ownerRoleFor(e),
          nextAction: "Proposed a Goodshuffle tracking task. Awaiting human approval; it sends on the next office sync and auto-verifies when it lands.",
          lastAttemptAt: nowIso,
        },
        now,
      ) ?? resolution
    );
  }

  if (plan.kind === "delegate") {
    const role = plan.role ?? ownerRoleFor(e);
    const out =
      setFields(
        key,
        {
          status: "delegated",
          assignedRole: role,
          nextAction: `${e.recommendedAction ?? e.detail} — owned by the ${role} team${e.deadline ? `, due ${e.deadline}` : ""}.`,
          lastAttemptAt: nowIso,
        },
        now,
      ) ?? resolution;
    notifyTeam(role, `Delegated: ${e.title}. ${out.nextAction ?? ""}`, `${key}:delegate`, now);
    return out;
  }

  // plan.kind === "escalate" (dead-letter): record it as a FAILED action; maybeEscalate pushes it up.
  return (
    setFields(
      key,
      { status: "failed", assignedRole: plan.role ?? ownerRoleFor(e), nextAction: plan.reason, lastAttemptAt: nowIso },
      now,
    ) ?? resolution
  );
}

// ── Escalation (team before owner), deduped per (key, tier) via the shared pure decider ─────────────────
const TIER_RANK: Record<EscalationTier, number> = { none: 0, team: 1, owner: 2 };

function escalationAlertOnce(key: string, tier: EscalationTier, now: Date): boolean {
  const kvKey = `${ESCALATION_KEY_PREFIX}${key}.${tier}`;
  const prev = getJson<JobAlertRecord | undefined>(kvKey, undefined);
  const { alert, next } = decideJobAlert(prev, true, now.getTime(), ESCALATION_COOLOFF_MS);
  setJson(kvKey, next ?? {});
  return alert === "down";
}

function notifyTeam(role: OwnerRole, text: string, dedupeId: string, now: Date): void {
  if (!escalationAlertOnce(dedupeId, "team", now)) return;
  void botAnnounce(ROLE_BOT[role], `🧭 ${text}`).catch(() => {});
}

function notifyEscalation(resolution: ExceptionResolution, tier: EscalationTier, now: Date): void {
  if (!escalationAlertOnce(resolution.key, tier, now)) return; // 2h cool-off per (key, tier) — no floods
  const role = resolution.assignedRole ?? "ops";
  const line = `${resolution.title} — ${resolution.nextAction ?? resolution.detail ?? ""}`.trim();
  if (tier === "owner") {
    // Owner tier → the ops/general channel the owner watches, clearly labelled as an owner escalation.
    void slackNotify(
      `🚨 OWNER ESCALATION (${resolution.severity}): ${line} [${resolution.key}]. Reached the owner because it is high-impact, repeatedly failing, or overdue after team escalation.`,
    ).catch(() => {});
  } else {
    // Team tier → the owning domain's bot channel (team-level path BEFORE any owner escalation).
    void botAnnounce(ROLE_BOT[role], `⚠️ Team escalation (${resolution.severity}): ${line} [owner: ${role}]`).catch(() => {});
  }
}

function maybeEscalate(resolution: ExceptionResolution, now: Date): ExceptionResolution {
  if (TERMINAL_STATUSES.has(resolution.status)) return resolution;
  const tier = escalationTier({
    severity: resolution.severity,
    status: resolution.status,
    resolveAttempts: resolution.resolveAttempts,
    firstDetectedAt: resolution.firstDetectedAt,
    deadline: resolution.deadline,
    currentTier: resolution.escalationTier,
    now: now.getTime(),
  });
  if (tier === "none" || TIER_RANK[tier] <= TIER_RANK[resolution.escalationTier]) return resolution; // nothing NEW
  // A "stuck" exception (no live resolution in flight) also flips status to `escalated`; an in-flight
  // awaiting_approval/acting keeps its status but still records the tier + posts the escalation.
  const stuck = ["active", "delegated", "failed", "unverifiable"].includes(resolution.status);
  const out =
    setFields(resolution.key, { escalationTier: tier, escalatedAt: now.toISOString(), status: stuck ? "escalated" : resolution.status }, now) ?? resolution;
  notifyEscalation(out, tier, now);
  return out;
}

// ── The per-exception coordination step ────────────────────────────────────────────────────────────────

/**
 * Coordinate ONE exception end-to-end for this tick: dedupe it, verify any resolution already in flight,
 * route a fresh resolution when it is still active, then apply the escalation check. Idempotent — safe to
 * call every tick. A closed (resolved/disposed) exception is only refreshed (last_seen_at), never re-acted.
 */
export function coordinateException(e: CanonicalException, now: Date = new Date()): ExceptionResolution {
  const { resolution } = upsertException(e, now);
  if (TERMINAL_STATUSES.has(resolution.status)) return resolution;

  let current = resolution;
  if (current.approvalId) {
    current = verifyLanded(current, now); // verify-after-act always runs before re-routing
  } else if (current.status === "active") {
    current = routeResolution(current, e, now);
  }
  return maybeEscalate(current, now);
}

/**
 * Handle an OPEN exception whose source signal DISAPPEARED this scan. Disappearance is NOT proof of
 * resolution: a resolution we drove to `resolved`/`disposed` is already terminal (and excluded); anything
 * still open that we never VERIFIED becomes `unverifiable` (a human confirms + disposes), NEVER auto-closed.
 * In-flight items (awaiting a human decision or a drainer) are left alone — their lifecycle still governs.
 */
function reconcileDisappeared(resolution: ExceptionResolution, now: Date): ExceptionResolution {
  if (resolution.status === "awaiting_approval" || resolution.status === "acting" || resolution.status === "unverifiable") return resolution;
  return (
    setFields(
      resolution.key,
      {
        status: "unverifiable",
        nextAction: "The source stopped reporting this, but no resolution was verified. Confirm it was actually handled, then record a disposition.",
      },
      now,
    ) ?? resolution
  );
}

export interface ExceptionTick {
  ok: boolean;
  detail: string;
  summary: ExceptionSummary;
}

/**
 * The runtime-job tick: detect from every source, coordinate each (dedupe → act/delegate/escalate →
 * verify), reconcile disappeared signals honestly, and return a status line + a by-status summary. Never
 * throws — a Slack hiccup never fails the tick.
 */
export async function runExceptionResolutionTick(now: Date = new Date()): Promise<ExceptionTick> {
  const detected = detectAllExceptions();
  const detectedKeys = new Set(detected.map((e) => exceptionKey(e)));
  for (const e of detected) {
    try {
      coordinateException(e, now);
    } catch {
      /* one bad exception never wedges the whole tick */
    }
  }
  for (const r of listOpenNotIn(detectedKeys)) {
    try {
      reconcileDisappeared(r, now);
    } catch {
      /* best effort */
    }
  }
  const summary = exceptionSummary();
  const ok = summary.failed === 0 && summary.unverifiable === 0;
  const detail =
    summary.total === 0
      ? "no exceptions"
      : `active ${summary.active}, awaiting ${summary.awaitingApproval}, acting ${summary.acting}, delegated ${summary.delegated}, escalated ${summary.escalated}, failed ${summary.failed}, unverifiable ${summary.unverifiable}, resolved ${summary.resolved}, disposed ${summary.disposed}`;
  return { ok, detail, summary };
}

// ── Human disposition (the ONLY other way an exception closes — a justified, recorded decision) ─────────

/** Record a human's explicit, justified disposition of an exception. `resolved` is used when a human
 *  confirms the real condition is met; `disposed` for any other justified close (won't-fix, duplicate, …).
 *  This is the human authority the engine never usurps. */
export function disposeException(
  key: string,
  disposition: string,
  by: string,
  as: "resolved" | "disposed" = "disposed",
  now: Date = new Date(),
): ExceptionResolution | null {
  const existing = getException(key);
  if (!existing) return null;
  return setFields(
    key,
    { status: as, disposition, disposedBy: by, resolvedAt: as === "resolved" ? now.toISOString() : existing.resolvedAt },
    now,
  );
}
