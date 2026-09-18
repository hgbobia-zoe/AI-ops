// Bid pursuit — PURE shapes (types, status labels, empty state) shared by the server generator/store
// (bidPackage.ts / pursuitState.ts) and the client Pursue workspace. No DB import. FACTS ONLY: the
// package is assembled from the capability profile + the opportunity's own facts; nothing is invented,
// and a HUMAN reviews and submits every bid (never auto-submit).

export type PursuitStatus = "DRAFTING" | "READY" | "SUBMITTED" | "WON" | "LOST" | "PASSED";
export const PURSUIT_STATUS_LABEL: Record<PursuitStatus, string> = {
  DRAFTING: "Drafting",
  READY: "Ready to submit",
  SUBMITTED: "Submitted",
  WON: "Won",
  LOST: "Lost",
  PASSED: "Passed",
};
export const PURSUIT_STATUS_ORDER: PursuitStatus[] = ["DRAFTING", "READY", "SUBMITTED", "WON", "LOST", "PASSED"];

export type ChecklistKind = "blocker" | "todo" | "info";

export interface ChecklistItem {
  id: string; // stable, so saved done-state maps across regenerations
  label: string;
  detail?: string;
  kind: ChecklistKind;
  suggestedDone: boolean; // deterministic suggestion from known facts (human can override)
}

/** The generated, review-ready bid package. Deterministic floor; narrative optionally AI-refined. */
export interface BidPackage {
  opportunityId: string;
  opportunityName: string;
  buyer: string | null;
  jurisdictionLabel: string;
  deadline: string | null; // YYYY-MM-DD or null
  sourceUrl: string | null;
  solicitationNumber: string | null;
  capabilityStatement: string;
  responseLetter: string;
  checklist: ChecklistItem[];
  gaps: string[]; // readiness warnings (profile gaps + missing opportunity facts)
  narrativeSource: "template" | "ai";
  profileCompleteness: number; // 0..1
  aiAvailable: boolean; // whether "Refine with AI" is usable (LLM configured)
}

/** Human-owned pursuit state, persisted per opportunity. Overrides win over the generated draft. */
export interface PursuitState {
  status: PursuitStatus;
  statementOverride: string | null; // human-edited capability statement; null = use generated
  responseOverride: string | null; // human-edited response letter; null = use generated
  checklistDone: Record<string, boolean>; // itemId -> done (human tick; falls back to suggestedDone)
  portalUrl: string; // where the human will submit (defaults to the source link)
  notes: string;
  submittedAt: string | null;
  submittedBy: string | null;
  updatedAt: string | null;
}

export function emptyPursuitState(): PursuitState {
  return {
    status: "DRAFTING",
    statementOverride: null,
    responseOverride: null,
    checklistDone: {},
    portalUrl: "",
    notes: "",
    submittedAt: null,
    submittedBy: null,
    updatedAt: null,
  };
}

/** Effective done-state for a checklist item: the human's tick if present, else the deterministic suggestion. */
export function itemDone(item: ChecklistItem, state: PursuitState): boolean {
  return item.id in state.checklistDone ? state.checklistDone[item.id] : item.suggestedDone;
}
