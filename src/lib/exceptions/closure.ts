// How an exception closes when its source signal is gone. Disappearing from a scan is NOT proof of a fix,
// but the SOURCE often records exactly how the problem ended: the risk engine re-checked and cleared it, a
// person dismissed it on the Risk board, the event day passed, or a dead-lettered write-back was retried
// and Goodshuffle accepted it. Those are real conditions, so the exception closes on them with the facts
// as evidence. When the source says nothing we can trust (row missing, still open), the exception stays
// unverifiable for a person to decide.
//
// PURE: the decision takes plain facts; lookupSourceFacts is the only part that reads the database.

import { getRiskBySignature } from "@/lib/risk/store";
import { getGsOpById } from "@/lib/db/repo";
import { todayInOpsTz } from "@/lib/dates";
import type { ExceptionResolution } from "./types";

/** What the source surface currently says about the item an exception came from. */
export type SourceFacts =
  | { kind: "risk"; status: string; date: string | null; resolvedAt: string | null }
  | { kind: "dead_letter"; status: string; updatedAt: string | null }
  | { kind: "missing" };

export interface SourceClosure {
  as: "resolved" | "disposed";
  disposition: string;
  by: string;
  evidence: Record<string, unknown>;
}

/** Decide whether the source's own record closes this exception. Returns null when it does not. */
export function sourceClosure(facts: SourceFacts, today: string): SourceClosure | null {
  if (facts.kind === "risk") {
    const evidence = { sourceStatus: facts.status, sourceDate: facts.date, sourceResolvedAt: facts.resolvedAt };
    if (facts.status === "DISMISSED") {
      return { as: "disposed", disposition: "Dismissed on the Event Risk board.", by: "Event Risk board", evidence };
    }
    // Fixed before its day came: the risk engine cleared it while it still mattered.
    const resolvedDay = facts.resolvedAt && Number.isFinite(Date.parse(facts.resolvedAt)) ? todayInOpsTz(new Date(facts.resolvedAt)) : null;
    if (facts.status === "RESOLVED" && (!facts.date || (resolvedDay !== null && resolvedDay <= facts.date))) {
      return {
        as: "resolved",
        disposition: "The Event Risk Engine checked again and closed this risk as fixed.",
        by: "Event Risk Engine",
        evidence,
      };
    }
    if (facts.date && facts.date < today) {
      return {
        as: "disposed",
        disposition: `The day this risk was about (${facts.date}) has passed, so it no longer applies.`,
        by: "Event Risk Engine",
        evidence,
      };
    }
    return null; // still open at the source, or a status we don't know: leave it for a person
  }
  if (facts.kind === "dead_letter") {
    if (facts.status === "done") {
      return {
        as: "resolved",
        disposition: "The write-back was retried and Goodshuffle accepted it.",
        by: "Write-back outbox",
        evidence: { opStatus: facts.status, opUpdatedAt: facts.updatedAt },
      };
    }
    if (facts.status === "dismissed") {
      return {
        as: "disposed",
        disposition: "A person dismissed the write-back, so it will not be retried.",
        by: "Write-back outbox",
        evidence: { opStatus: facts.status, opUpdatedAt: facts.updatedAt },
      };
    }
    return null;
  }
  return null;
}

/** Read the source record for an exception. Never throws; a read failure reads as "missing". */
export function lookupSourceFacts(r: Pick<ExceptionResolution, "source" | "sourceId">): SourceFacts {
  try {
    if (r.source === "risk") {
      const risk = getRiskBySignature(r.sourceId);
      if (!risk) return { kind: "missing" };
      return { kind: "risk", status: risk.status, date: risk.date ?? null, resolvedAt: risk.resolvedAt ?? null };
    }
    if (r.source === "dead_letter") {
      const op = getGsOpById(r.sourceId);
      if (!op) return { kind: "missing" };
      return { kind: "dead_letter", status: op.status, updatedAt: op.updatedAt ?? null };
    }
  } catch {
    /* fall through */
  }
  return { kind: "missing" };
}
