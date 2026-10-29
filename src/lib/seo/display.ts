// SEO Growth — shared DISPLAY mappings for the blade (pure, no React, server-safe). One place that turns a
// workflow fact (stage, recommended action, source-health status, quality summary, finding kind) into the
// Nocturne tone + label the UI renders through the shared StatusBadge/StatusMark. Keeping this here means the
// board, the tables, the overview and the studios all read a status identically. FACTS ONLY — nothing here
// fabricates data; it only labels the states the data is actually in.

import type { Tone } from "@/lib/tone";
import type { SeoStage, SeoHealthStatus } from "./types";
import type { SeoFindingKind } from "./findings";

/** Kanban stage → status tone. Active-flow stages read as info/attention/positive by where they sit in the
 *  flow; the off-flow lanes read neutral except BLOCKED (critical). The stage LABEL comes from STAGE_META. */
export function stageTone(stage: SeoStage): Tone {
  switch (stage) {
    case "REVIEW":
      return "attention"; // needs a human decision
    case "APPROVED_FOR_PUBLISHING":
    case "PUBLISHED":
    case "MONITORING":
      return "positive";
    case "BLOCKED":
      return "critical";
    case "ANALYZING":
    case "APPROVED":
    case "DRAFTING":
      return "info"; // work in progress
    case "DISCOVERED":
    case "DEFERRED":
    case "CONSOLIDATED":
    case "REJECTED":
    default:
      return "neutral";
  }
}

/** Source-health status → tone. A rate-limit reads as attention (it clears itself), a hard failure as critical. */
export function healthTone(status: SeoHealthStatus, rateLimited = false): Tone {
  switch (status) {
    case "ok":
      return "positive";
    case "stale":
      return "attention";
    case "error":
      return rateLimited ? "attention" : "critical";
    case "never":
    case "not_configured":
    default:
      return "neutral";
  }
}

/** Competitive-finding kind → tone + short label for the status indicator. */
export function findingDisplay(kind: SeoFindingKind): { tone: Tone; label: string } {
  switch (kind) {
    case "gap":
      return { tone: "critical", label: "Gap" };
    case "improve":
      return { tone: "attention", label: "Improve" };
    case "defend":
      return { tone: "positive", label: "Defend" };
    case "none":
    default:
      return { tone: "neutral", label: "No signal" };
  }
}

/** A draft's quality roll-up → tone + label. Errors block; warnings need a look; otherwise the structural
 *  checks passed (a reviewer gate, NOT an auto-publish signal). */
export function qualityDisplay(errors: number, warnings: number): { tone: Tone; label: string } {
  if (errors > 0) return { tone: "critical", label: `${errors} error${errors === 1 ? "" : "s"}` };
  if (warnings > 0) return { tone: "attention", label: `${warnings} warning${warnings === 1 ? "" : "s"}` };
  return { tone: "positive", label: "Checks passed" };
}
