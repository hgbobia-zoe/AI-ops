// Post-Event Customer Experience — PURE shapes + option sets shared by the server stores and the client
// surfaces. No DB import (client-safe; mirrors the capabilityProfileShape.ts split). FACTS only.
//
// The module is a human-first post-event follow-up + service-recovery + review workflow. A review is the
// OUTCOME of a confirmed good experience, never the objective. The core distinctions below are DIFFERENT
// metrics and are never collapsed: Attempted contact != Successful contact != Customer responded !=
// Positive experience != Review requested != Review received.

// ── Workflow state (the Kanban columns) ────────────────────────────────────────────────────────────
export type PostEventState =
  | "needs_follow_up"
  | "follow_up_in_progress"
  | "customer_responded"
  | "experience_confirmed"
  | "review_requested"
  | "review_completed"
  | "closed";

export const POSTEVENT_STATE_ORDER: PostEventState[] = [
  "needs_follow_up",
  "follow_up_in_progress",
  "customer_responded",
  "experience_confirmed",
  "review_requested",
  "review_completed",
  "closed",
];

export const POSTEVENT_STATE_LABEL: Record<PostEventState, string> = {
  needs_follow_up: "Needs Follow-Up",
  follow_up_in_progress: "Follow-Up In Progress",
  customer_responded: "Customer Responded",
  experience_confirmed: "Experience Confirmed",
  review_requested: "Review Requested",
  review_completed: "Review Completed",
  closed: "Closed",
};

// The board shows the active pipeline; Closed is reached via the closure flow (structured reason), not a
// bare drag, so it renders as its own terminal column.
export const POSTEVENT_ACTIVE_STATES: PostEventState[] = POSTEVENT_STATE_ORDER.filter((s) => s !== "closed");

// ── Experience disposition (set once contact is established; a human sets it) ───────────────────────
export type Disposition =
  | "positive"
  | "positive_minor"
  | "issue"
  | "serious_issue"
  | "mixed_neutral"
  | "unable";

export const DISPOSITION_ORDER: Disposition[] = [
  "positive",
  "positive_minor",
  "issue",
  "serious_issue",
  "mixed_neutral",
  "unable",
];

export const DISPOSITION_LABEL: Record<Disposition, string> = {
  positive: "Positive",
  positive_minor: "Positive with minor feedback",
  issue: "Issue identified",
  serious_issue: "Serious issue",
  mixed_neutral: "Mixed / neutral",
  unable: "Unable to determine",
};

/** Positive experiences are the only ones that make a review invitation appropriate. */
export function isPositiveDisposition(d: Disposition | null): boolean {
  return d === "positive" || d === "positive_minor";
}
export function isIssueDisposition(d: Disposition | null): boolean {
  return d === "issue" || d === "serious_issue";
}

// ── Next action (always derivable; every active project shows one) ──────────────────────────────────
export type NextAction =
  | "call"
  | "sms"
  | "await_response"
  | "review_feedback"
  | "escalate"
  | "follow_resolution"
  | "send_review_request"
  | "close"
  | "none";

export const NEXT_ACTION_LABEL: Record<NextAction, string> = {
  call: "Call",
  sms: "SMS",
  await_response: "Await response",
  review_feedback: "Review feedback",
  escalate: "Escalate",
  follow_resolution: "Follow up on resolution",
  send_review_request: "Send review request",
  close: "Close",
  none: "None",
};

// ── Contact attempts ────────────────────────────────────────────────────────────────────────────────
export type ContactChannel = "phone" | "voicemail" | "sms" | "email" | "other";
export const CONTACT_CHANNEL_ORDER: ContactChannel[] = ["phone", "voicemail", "sms", "email", "other"];
export const CONTACT_CHANNEL_LABEL: Record<ContactChannel, string> = {
  phone: "Phone",
  voicemail: "Voicemail",
  sms: "SMS",
  email: "Email",
  other: "Other",
};

export type ContactOutcome =
  | "no_answer"
  | "left_voicemail"
  | "customer_responded"
  | "requested_callback"
  | "unavailable"
  | "positive"
  | "issue_reported"
  | "other";
export const CONTACT_OUTCOME_ORDER: ContactOutcome[] = [
  "no_answer",
  "left_voicemail",
  "customer_responded",
  "requested_callback",
  "unavailable",
  "positive",
  "issue_reported",
  "other",
];
export const CONTACT_OUTCOME_LABEL: Record<ContactOutcome, string> = {
  no_answer: "No answer",
  left_voicemail: "Left voicemail",
  customer_responded: "Customer responded",
  requested_callback: "Requested callback",
  unavailable: "Unavailable",
  positive: "Positive",
  issue_reported: "Issue reported",
  other: "Other",
};

/** Outcomes that mean the customer actually engaged (a SUCCESSFUL, two-way contact). */
export const RESPONDED_OUTCOMES: ContactOutcome[] = ["customer_responded", "requested_callback", "positive", "issue_reported"];

export interface ContactAttempt {
  id: string;
  bookingId: string;
  occurredAt: string;
  channel: ContactChannel;
  employee: string | null;
  outcome: ContactOutcome;
  direction: "outbound" | "inbound" | null;
  notes: string;
  source: "manual" | "comms";
  createdAt: string;
}

export interface ContactInput {
  occurredAt?: string;
  channel?: ContactChannel;
  employee?: string | null;
  outcome?: ContactOutcome;
  direction?: "outbound" | "inbound" | null;
  notes?: string;
}

// ── Review request / receipt ────────────────────────────────────────────────────────────────────────
export type ReviewRequestChannel = "sms" | "email" | "in_person" | "other";
export const REVIEW_REQUEST_CHANNELS: ReviewRequestChannel[] = ["sms", "email", "in_person", "other"];
export const REVIEW_REQUEST_CHANNEL_LABEL: Record<ReviewRequestChannel, string> = {
  sms: "SMS",
  email: "Email",
  in_person: "In person",
  other: "Other",
};

export interface ReviewRecord {
  id: string;
  bookingId: string;
  kind: "requested" | "received";
  occurredAt: string;
  employee: string | null;
  channel: string | null;
  destination: string | null;
  message: string | null;
  rating: number | null;
  link: string | null;
  createdAt: string;
}

// ── Service-recovery issue ──────────────────────────────────────────────────────────────────────────
export type IssueType = "damage" | "late" | "missing" | "staff" | "billing" | "quality" | "other";
export const ISSUE_TYPES: IssueType[] = ["damage", "late", "missing", "staff", "billing", "quality", "other"];
export const ISSUE_TYPE_LABEL: Record<IssueType, string> = {
  damage: "Damage",
  late: "Late delivery / pickup",
  missing: "Missing items",
  staff: "Staff / service",
  billing: "Billing",
  quality: "Quality",
  other: "Other",
};

export type IssueState =
  | "identified"
  | "escalated"
  | "resolution_in_progress"
  | "resolution_completed"
  | "customer_follow_up"
  | "closed";
export const ISSUE_STATE_ORDER: IssueState[] = [
  "identified",
  "escalated",
  "resolution_in_progress",
  "resolution_completed",
  "customer_follow_up",
  "closed",
];
export const ISSUE_STATE_LABEL: Record<IssueState, string> = {
  identified: "Issue identified",
  escalated: "Escalated",
  resolution_in_progress: "Resolution in progress",
  resolution_completed: "Resolution completed",
  customer_follow_up: "Customer follow-up",
  closed: "Closed",
};
export const ISSUE_OPEN_STATES: IssueState[] = ISSUE_STATE_ORDER.filter((s) => s !== "closed");

export type EscalationLevel = "none" | "supervisor" | "management" | "owner";
export const ESCALATION_LEVELS: EscalationLevel[] = ["none", "supervisor", "management", "owner"];
export const ESCALATION_LEVEL_LABEL: Record<EscalationLevel, string> = {
  none: "None",
  supervisor: "Supervisor",
  management: "Management",
  owner: "Owner",
};

export interface IssueRecord {
  id: string;
  bookingId: string;
  issueType: IssueType | null;
  description: string;
  state: IssueState;
  escalationLevel: EscalationLevel;
  assignedEmployee: string | null;
  resolution: string;
  refundCredit: number | null;
  resolutionAt: string | null;
  finalResponse: string;
  closureReason: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface IssueInput {
  issueType?: IssueType | null;
  description?: string;
  state?: IssueState;
  escalationLevel?: EscalationLevel;
  assignedEmployee?: string | null;
  resolution?: string;
  refundCredit?: number | null;
  finalResponse?: string;
  closureReason?: string | null;
}

// ── Closure reasons (REQUIRED on close; structured, grouped) ────────────────────────────────────────
export type ClosureReason =
  // Customer
  | "review_completed"
  | "customer_declined"
  | "customer_unavailable"
  | "no_response"
  | "requested_no_contact"
  | "feedback_no_review"
  // Operational
  | "issue_resolved"
  | "issue_escalated"
  | "refund_credit_issued"
  | "service_recovery_completed"
  | "management_follow_up"
  // Administrative
  | "duplicate"
  | "wrong_contact"
  | "invalid_project"
  | "internal_test"
  | "other";

export const CLOSURE_GROUPS: { group: string; reasons: ClosureReason[] }[] = [
  { group: "Customer", reasons: ["review_completed", "customer_declined", "customer_unavailable", "no_response", "requested_no_contact", "feedback_no_review"] },
  { group: "Operational", reasons: ["issue_resolved", "issue_escalated", "refund_credit_issued", "service_recovery_completed", "management_follow_up"] },
  { group: "Administrative", reasons: ["duplicate", "wrong_contact", "invalid_project", "internal_test", "other"] },
];

export const CLOSURE_REASON_LABEL: Record<ClosureReason, string> = {
  review_completed: "Review completed",
  customer_declined: "Customer declined",
  customer_unavailable: "Customer unavailable",
  no_response: "No response after full follow-up",
  requested_no_contact: "Requested no further contact",
  feedback_no_review: "Gave feedback but didn't review",
  issue_resolved: "Issue identified and resolved",
  issue_escalated: "Issue escalated",
  refund_credit_issued: "Refund or credit issued",
  service_recovery_completed: "Service recovery completed",
  management_follow_up: "Management follow-up required",
  duplicate: "Duplicate",
  wrong_contact: "Wrong contact info",
  invalid_project: "Invalid project",
  internal_test: "Internal test",
  other: "Other",
};

export const ALL_CLOSURE_REASONS: ClosureReason[] = CLOSURE_GROUPS.flatMap((g) => g.reasons);
export function isClosureReason(x: unknown): x is ClosureReason {
  return typeof x === "string" && (ALL_CLOSURE_REASONS as string[]).includes(x);
}

// ── Config (settings KV) ────────────────────────────────────────────────────────────────────────────
// The review destination and SLA thresholds are CONFIGURABLE, never hard-coded. Copy is warm/human and
// follows the house comms rule (no dashes as punctuation, no emoji).
export interface PostEventConfig {
  reviewDestinationLabel: string; // e.g. "Google"
  reviewDestinationUrl: string; // the review link handed to the customer
  reviewTemplate: string; // warm invite copy
  slaDays: Record<PostEventState, number>; // days-in-stage before a project is flagged stale
}

export const DEFAULT_REVIEW_TEMPLATE =
  "We're really glad everything went well with your event. If you have a minute, we'd appreciate you sharing your experience. It genuinely helps our small team.";

export const DEFAULT_SLA_DAYS: Record<PostEventState, number> = {
  needs_follow_up: 2,
  follow_up_in_progress: 3,
  customer_responded: 2,
  experience_confirmed: 3,
  review_requested: 7,
  review_completed: 0,
  closed: 0,
};

export function defaultConfig(): PostEventConfig {
  return { reviewDestinationLabel: "", reviewDestinationUrl: "", reviewTemplate: DEFAULT_REVIEW_TEMPLATE, slaDays: { ...DEFAULT_SLA_DAYS } };
}

// ── Project (workflow row) + views ──────────────────────────────────────────────────────────────────
export interface PostEventProject {
  bookingId: string;
  state: PostEventState;
  disposition: Disposition | null;
  nextAction: NextAction;
  assignedEmployee: string | null;
  eventDate: string | null;
  pickupAt: string | null;
  eligibleAt: string;
  stageEnteredAt: string;
  closureReason: ClosureReason | null;
  closureNote: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A card on the board / a row in a list — the workflow row joined to the read-only Goodshuffle facts. */
export interface PostEventCard {
  bookingId: string;
  state: PostEventState;
  disposition: Disposition | null;
  nextAction: NextAction;
  assignedEmployee: string | null;
  // Goodshuffle facts (referenced, not owned).
  customer: string;
  eventName: string;
  eventDate: string | null;
  venue: string | null;
  // Derived, deterministic.
  pickupAt: string | null;
  lastContactAt: string | null;
  lastContactOutcome: ContactOutcome | null; // outcome of the most recent attempt (null = no contact recorded)
  contactCount: number;
  respondedCount: number;
  openIssues: number;
  daysInStage: number;
  stateReason: string | null; // WHY it's in this state (latest transition note, else a deterministic fallback)
  dueAt: string | null; // ymd the current stage's next action is due (stageEnteredAt + SLA days), null if no SLA
  dueToday: boolean;
  overdue: boolean; // past due and still active
  stale: boolean; // days-in-stage over the configured SLA for this state
}

/** The customer-contact reality, kept as three DISTINCT facts (never collapsed to "0 contacts"):
 *  no attempt recorded / attempted but not reached / customer actually responded. */
export type ContactState = "none" | "attempted" | "responded";
export function contactState(contactCount: number, respondedCount: number): ContactState {
  if (respondedCount > 0) return "responded";
  if (contactCount > 0) return "attempted";
  return "none";
}
export const CONTACT_STATE_LABEL: Record<ContactState, string> = {
  none: "No contact recorded",
  attempted: "Contact attempted",
  responded: "Customer responded",
};

export type BoardColumns = Record<PostEventState, PostEventCard[]>;

// ── Metrics / funnel ────────────────────────────────────────────────────────────────────────────────
/** A rate is ALWAYS a numerator over a denominator; pct is null when the denominator is 0 (render
 *  "Unavailable", never a fabricated percentage). */
export interface Rate {
  num: number;
  den: number;
  pct: number | null;
}

export interface FunnelStep {
  key: string;
  label: string;
  count: number;
}

export interface Bottleneck {
  stageKey: string;
  headline: string; // "8 of 17 eligible projects have no successful contact yet"
  stuck: number;
  total: number;
}

export interface PostEventMetrics {
  periodDays: number | null; // null = all time
  start: string | null;
  end: string;
  funnel: FunnelStep[];
  counts: {
    completed: number;
    followUpInitiated: number;
    customerReached: number;
    experienceConfirmed: number;
    positiveExperiences: number;
    reviewRequestsSent: number;
    reviewsReceived: number;
    issues: number;
  };
  rates: {
    followUpCoverage: Rate;
    contactRate: Rate;
    experienceConfirmationRate: Rate;
    issueRate: Rate;
    reviewRequestRate: Rate;
    reviewConversion: Rate;
    overallReviewRate: Rate;
  };
  bottleneck: Bottleneck | null;
}

export function pct(num: number, den: number): number | null {
  return den > 0 ? Math.round((num / den) * 1000) / 10 : null;
}
export function rate(num: number, den: number): Rate {
  return { num, den, pct: pct(num, den) };
}
