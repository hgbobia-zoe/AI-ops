// Post-Event service worklist — the deterministic "what to do next" derivation for the overview.
//
// RULES CALCULATE. This groups the ACTIVE board cards (current open work, not a reporting period) by
// their already-derived next action into a small, service-first set of operational buckets, each with a
// real count, an overdue count, and a link to the scoped records. It invents nothing: every number is a
// count of real cards, and a card lands in exactly one bucket (chosen from its own nextAction/state).
//
// Service-first ordering: resolve issues and confirm experiences BEFORE chasing reviews. A customer whose
// experience is simply not yet confirmed is WORK IN PROGRESS, never a dissatisfied or lost customer — the
// labels below are deliberately supportive and never imply loss.

import type { Tone } from "@/lib/tone";
import type { PostEventCard, NextAction } from "./types";

export type WorklistKey = "recover" | "confirm" | "reach_out" | "awaiting" | "invite" | "wrap_up";

export interface WorklistGroup {
  key: WorklistKey;
  /** Short operational label for the task. */
  label: string;
  /** Supportive, factual sentence (the count is rendered by the caller). */
  description: string;
  /** The specific next customer-service action. */
  actionLabel: string;
  count: number;
  /** How many of those are past their stage SLA (overdue) — surfaced, never fabricated. */
  overdue: number;
  tone: Tone;
  /** Link to the underlying scoped records (board / issues), as close a scope as the board supports. */
  href: string;
}

// Service-first priority: lower index = more important. Issues and confirmations come before reviews.
const ORDER: WorklistKey[] = ["recover", "confirm", "reach_out", "awaiting", "invite", "wrap_up"];

/** Which bucket a card belongs to, from its deterministic next action. Closed cards are not work. */
function bucketFor(card: PostEventCard): WorklistKey | null {
  if (card.state === "closed") return null;
  // An open issue always routes to service recovery first, whatever the stage's generic next action is.
  if (card.openIssues > 0) return "recover";
  const next: NextAction = card.nextAction;
  switch (next) {
    case "escalate":
    case "follow_resolution":
      return "recover";
    case "review_feedback":
      return "confirm";
    case "call":
    case "sms":
      return "reach_out";
    case "await_response":
      return "awaiting";
    case "send_review_request":
      return "invite";
    case "close":
      return "wrap_up";
    case "none":
      return null;
  }
}

interface Meta {
  label: string;
  actionLabel: string;
  tone: Tone;
  href: (overdue: number) => string;
  describe: (count: number, overdue: number) => string;
}

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

const META: Record<WorklistKey, Meta> = {
  recover: {
    label: "Service recovery",
    actionLabel: "Work service recovery",
    tone: "critical",
    href: () => "/postevent/issues",
    describe: (n) => `${plural(n, "customer needs", "customers need")} service recovery: an open issue or an identified problem to work. This comes first.`,
  },
  confirm: {
    label: "Confirm experience",
    actionLabel: "Confirm experiences",
    tone: "info",
    href: () => "/postevent/kanban",
    describe: (n) =>
      `${plural(n, "customer was", "customers were")} reached and ${plural(n, "is", "are")} waiting for us to confirm how the event went. These are supported and in progress, not lost.`,
  },
  reach_out: {
    label: "Reach out",
    actionLabel: "Make contact",
    tone: "neutral",
    href: (overdue) => (overdue > 0 ? "/postevent/kanban?queue=overdue" : "/postevent/kanban"),
    describe: (n) => `${plural(n, "customer is", "customers are")} waiting on a first or follow-up contact from us.`,
  },
  awaiting: {
    label: "Awaiting the customer",
    actionLabel: "Review awaiting",
    tone: "neutral",
    href: () => "/postevent/kanban?queue=awaiting",
    describe: (n) => `${plural(n, "customer has", "customers have")} been contacted and we are waiting on their response.`,
  },
  invite: {
    label: "Invite a review",
    actionLabel: "Send review invites",
    tone: "positive",
    href: () => "/postevent/kanban",
    describe: (n) => `${plural(n, "customer had", "customers had")} a confirmed positive experience and could be invited to review.`,
  },
  wrap_up: {
    label: "Ready to close",
    actionLabel: "Close out",
    tone: "neutral",
    href: () => "/postevent/kanban",
    describe: (n) => `${plural(n, "project is", "projects are")} complete and ready to close with a reason.`,
  },
};

export interface ServiceWorklist {
  groups: WorklistGroup[];
  /** Total active (non-closed) cards represented. */
  activeTotal: number;
}

/** Build the service-first worklist from the active board cards. Pure; unit-tested. */
export function buildServiceWorklist(cards: PostEventCard[]): ServiceWorklist {
  const counts = new Map<WorklistKey, { count: number; overdue: number }>();
  let activeTotal = 0;
  for (const c of cards) {
    const key = bucketFor(c);
    if (!key) continue;
    activeTotal++;
    const cur = counts.get(key) ?? { count: 0, overdue: 0 };
    cur.count++;
    if (c.overdue) cur.overdue++;
    counts.set(key, cur);
  }
  const groups: WorklistGroup[] = [];
  for (const key of ORDER) {
    const agg = counts.get(key);
    if (!agg || agg.count === 0) continue;
    const m = META[key];
    groups.push({
      key,
      label: m.label,
      description: m.describe(agg.count, agg.overdue),
      actionLabel: m.actionLabel,
      count: agg.count,
      overdue: agg.overdue,
      tone: m.tone,
      href: m.href(agg.overdue),
    });
  }
  return { groups, activeTotal };
}
