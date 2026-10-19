// INTENT → AI-EMPLOYEE routing. Viktor is a front door onto the whole AI workforce, so an actionable ask
// should be OWNED by the right employee — a schedule change by the Scheduling employee, a quote/outreach by
// Sales, an inventory conflict by Inventory — not hardcoded to "viktor". This classifier is DETERMINISTIC
// (keyword rules, no LLM): it maps a request to an owning registry agent id + the notify BotId that routes a
// proposal's approval card and its announcement to that employee's own channel (botForAgent).
//
// It changes NO authority. The governed path is unchanged: a classified request still becomes a PROPOSAL a
// human approves, and the FORBIDDEN categories (money / pricing / schedule / hiring / Instawork) stay
// propose-only — this just attributes the proposal to the correct employee and suggests an honest actionType.
// Everything it reads is DATA; it executes nothing.

import { getEmployee } from "@/lib/aiorg/registry";
import { botForAgent, type BotId } from "@/lib/notify/aiBots";
import { isForbiddenActionType, type ApprovalActionType } from "@/lib/aiorg/approvals";

export interface IntentRoute {
  /** The owning AI-employee id from the registry (always a real id; falls back to "viktor"). */
  agentId: string;
  /** The notify BotId whose channel/persona a proposal should announce under. */
  bot: BotId;
  /** A short domain label (for logging / the responder contract). */
  domain: string;
  /** The honest approval actionType this kind of ask maps to (the responder may override). */
  actionType: ApprovalActionType;
  /** True when that actionType is FORBIDDEN to execute in v2 (propose-only). */
  forbidden: boolean;
  /** True when a keyword rule matched; false means it fell back to Viktor (no clear owner). */
  matched: boolean;
}

interface DomainRule {
  domain: string;
  agentId: string;
  actionType: ApprovalActionType;
  /** Matched as whole words (case-insensitive) anywhere in the message. */
  keywords: string[];
}

// Ordered by specificity: the FIRST rule with a keyword hit wins, so money/schedule/hiring (narrow, forbidden)
// are checked before the broad sales/ops buckets. Every agentId must exist in the registry (asserted by test).
const DOMAIN_RULES: DomainRule[] = [
  // Money / pricing — FORBIDDEN to execute (quote-analyst owns pricing/quote work in Sales).
  { domain: "pricing", agentId: "quote-analyst", actionType: "change_pricing", keywords: ["price", "pricing", "discount", "delivery fee", "rate", "markup", "quote amount", "charge"] },
  // Hiring / firing — FORBIDDEN.
  { domain: "hiring", agentId: "hiring", actionType: "hiring", keywords: ["hire", "hiring", "recruit", "onboard", "fire", "terminate", "applicant", "candidate"] },
  // Instawork gig — FORBIDDEN (no captured write path).
  { domain: "instawork", agentId: "staffing", actionType: "instawork_gig", keywords: ["instawork", "temp worker", "gig", "temp labor"] },
  // Scheduling / staffing / shifts — schedule_change is FORBIDDEN (operationally significant).
  { domain: "scheduling", agentId: "scheduling", actionType: "schedule_change", keywords: ["schedule", "reschedule", "shift", "staffing", "staff", "crew", "roster", "assign", "reassign", "swap", "coverage", "move a worker", "day off", "time off"] },
  // Dispatch / routes / ETA — a route or stop progress ask (append_note is the safe wired outcome).
  { domain: "dispatch", agentId: "dispatch-route", actionType: "append_note", keywords: ["route", "dispatch", "stop", "eta", "driver", "truck", "delivery status", "on the way", "arrived", "unload"] },
  // Inventory / items / stock.
  { domain: "inventory", agentId: "inventory-exception", actionType: "append_note", keywords: ["inventory", "item", "stock", "overbook", "overbooked", "double booked", "quantity", "conflict"] },
  // Finance / revenue / labor.
  { domain: "finance", agentId: "business-intelligence", actionType: "append_note", keywords: ["revenue", "finance", "financial", "labor cost", "margin", "contribution", "payroll"] },
  // Marketing / content.
  { domain: "marketing", agentId: "content", actionType: "append_note", keywords: ["campaign", "content", "marketing", "social", "newsletter"] },
  // Sales / outreach / quotes / leads — the broad Sales bucket (email/SMS to a client is the common action).
  { domain: "sales", agentId: "outreach", actionType: "send_email", keywords: ["quote", "lead", "follow up", "follow-up", "outreach", "customer", "client", "email", "text", "sms", "call", "proposal", "win back", "winback", "sales"] },
];

/** Match whole words / phrases case-insensitively. A multi-word keyword is matched as a substring on word
 *  boundaries; a single word uses a \b word-boundary so "rate" doesn't fire on "accurate". PURE. */
function hasKeyword(haystack: string, kw: string): boolean {
  const k = kw.toLowerCase();
  if (k.includes(" ")) return haystack.includes(k);
  return new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(haystack);
}

/** Classify a free-text request to its owning AI employee. Deterministic; falls back to Viktor (ops) with a
 *  safe append_note actionType when nothing matches. PURE (reads only the static registry + action tables). */
export function classifyIntentAgent(text: string): IntentRoute {
  const hay = (text || "").toLowerCase();
  for (const rule of DOMAIN_RULES) {
    if (rule.keywords.some((kw) => hasKeyword(hay, kw))) {
      // Guard against a typo'd agentId: only route to a real registry employee, else fall through to Viktor.
      const agentId = getEmployee(rule.agentId) ? rule.agentId : "viktor";
      return {
        agentId,
        bot: botForAgent(agentId),
        domain: rule.domain,
        actionType: rule.actionType,
        forbidden: isForbiddenActionType(rule.actionType),
        matched: agentId !== "viktor",
      };
    }
  }
  return { agentId: "viktor", bot: botForAgent("viktor"), domain: "general", actionType: "append_note", forbidden: false, matched: false };
}
