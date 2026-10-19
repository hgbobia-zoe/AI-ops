// WS05 — source ADAPTERS. Each reads an EXISTING exception surface (read-only — it never mutates the
// source) and normalizes it into a CanonicalException. Adding a new surface = adding an adapter here, NOT a
// new queue or bus. Today: the Event Risk Engine (risk_items) and the WS03 outbox dead-letter backlog.
//
// Why these two first (mission "Scope" — chosen by evidence, not preference):
//   • risk_items is a TRUE live queue with a stable `signature` identity, deterministic scan, an explicit
//     recommendedAction + actionTarget + owner + deadline, and a clean subset (actionTarget="goodshuffle"
//     with a transactionID) whose authorized resolution is an ungated, proven outbox write — so it can run
//     the FULL detect→propose→verify→resolve loop. Its other subsets exercise delegate + escalate.
//   • the dead-letter backlog is handed to us directly by WS03 (listDeadLetterGsOps) and is the canonical
//     "a prior action FAILED, bounded retries are exhausted" signal — the pure escalate path.

import { getRiskQueue, type StoredRisk } from "@/lib/risk/store";
import { listDeadLetterGsOps } from "@/lib/db/repo";
import { normalizeRiskSeverity } from "./policy";
import type { CanonicalException } from "./types";

/** Read the active risk queue and normalize each risk into a canonical exception (read-only). */
export function detectRiskExceptions(risks: StoredRisk[] = getRiskQueue()): CanonicalException[] {
  return risks.map((r) => ({
    source: "risk" as const,
    sourceId: r.signature, // the risk engine's STABLE cross-scan identity
    type: r.riskType,
    severity: normalizeRiskSeverity(r.severity),
    title: r.title,
    detail: r.description,
    actionTarget: r.actionTarget ?? null,
    transactionId: r.eventId ?? null, // Goodshuffle transactionID of the project/event, when known
    deadline: r.deadline ?? null,
    recommendedAction: r.recommendedAction ?? null,
    ownerHint: r.owner ?? null,
    firstDetectedAt: r.firstDetectedAt,
    evidence: {
      riskId: r.id,
      category: r.category,
      routeId: r.routeId ?? null,
      truckId: r.truckId ?? null,
      affectedEntity: r.affectedEntity ?? null,
      date: r.date ?? null,
    },
  }));
}

/** Read the outbox dead-letter backlog (WS03) and normalize each exhausted op into a canonical exception. */
export function detectDeadLetterExceptions(ops = listDeadLetterGsOps(100)): CanonicalException[] {
  return ops.map((o) => {
    // A dead-lettered customer email is higher-impact than an internal note/task.
    const severity = o.op === "email_send" ? "high" : "medium";
    return {
      source: "dead_letter" as const,
      sourceId: o.id,
      type: `dead_letter:${o.op}`,
      severity,
      title: `Write-back failed: ${o.label ?? o.op}`,
      detail: `The ${o.op} op exhausted its retries (${o.attempts} attempt${o.attempts === 1 ? "" : "s"}) and never reached Goodshuffle. Last error: ${o.lastError ?? "unknown"}.`,
      actionTarget: "goodshuffle",
      transactionId: o.transactionId ?? null,
      deadline: null,
      recommendedAction: "Re-run the action from a logged-in office session, or cancel it if it is no longer needed.",
      ownerHint: null,
      firstDetectedAt: o.deadLetteredAt ?? o.createdAt,
      evidence: { op: o.op, attempts: o.attempts, lastError: o.lastError ?? null, label: o.label ?? null, outboxOpId: o.id },
    };
  });
}

/** All detectors, in one call — the engine's detection surface. */
export function detectAllExceptions(): CanonicalException[] {
  return [...detectRiskExceptions(), ...detectDeadLetterExceptions()];
}
