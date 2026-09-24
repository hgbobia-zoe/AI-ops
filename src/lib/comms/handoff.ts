// Human handoff. When a human is needed, the Tower generates a concise brief so the rep has context
// BEFORE they accept — customer, event, reason, what we know vs what's requested, inventory availability
// (always honest), an AI recommendation (INFERENCE, labelled), and the conversation summary. It is built
// from the Context Pack (verified facts) plus the classified reason; it never fabricates.

import { REASON_LABEL, type CallReason } from "./reasons";
import type { ContextPack, HandoffBrief } from "./types";

function fmtMoney(n: number | null): string {
  return n == null ? "Unavailable" : `$${n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

/** Compose the current-state line from the pack's verified facts. */
function currentState(ctx: ContextPack): string {
  const parts: string[] = [];
  if (ctx.customer) parts.push(`Customer: ${ctx.customer.name}`);
  const primaryEvent = ctx.events[0];
  if (primaryEvent) parts.push(`Event: ${primaryEvent.name}${primaryEvent.eventDate ? ` on ${primaryEvent.eventDate}` : ""} (${primaryEvent.status || "status unknown"})`);
  const order = ctx.orders[0];
  if (order) parts.push(`Order total ${fmtMoney(order.total)}, balance ${fmtMoney(order.amountDue)}`);
  if (ctx.delivery.availability !== "UNAVAILABLE") parts.push(`Delivery ${ctx.delivery.availability.toLowerCase()}${ctx.delivery.window ? ` (${ctx.delivery.window})` : ""}`);
  if (ctx.operationalRisk.length) parts.push(`${ctx.operationalRisk.length} open operational risk(s)`);
  return parts.length ? parts.join(". ") : "No verified account facts on file for this caller.";
}

/** A deterministic, honest recommendation from the reason + facts. Labelled INFERENCE in the UI; this is
 *  guidance, not an instruction, and it never claims a capability we don't have. */
function recommend(ctx: ContextPack, reason: CallReason): string {
  switch (reason) {
    case "DELIVERY_STATUS":
    case "PICKUP_STATUS":
      return ctx.delivery.availability === "UNAVAILABLE" && ctx.pickup.availability === "UNAVAILABLE"
        ? "No matching stop found — verify the order in Goodshuffle before quoting a window."
        : "Confirm the window/ETA shown, then reassure the caller with the dispatch fact.";
    case "BILLING":
    case "PAYMENT":
      return "Route to billing; do not quote adjustments verbally — confirm the balance in Goodshuffle.";
    case "COMPLAINT":
    case "DAMAGE":
      return "Handle with care; log a service-recovery issue and avoid committing to a remedy on the call.";
    case "CANCELLATION":
      return "Escalate to a manager; cancellations are never processed by the agent.";
    case "QUOTE_FOLLOW_UP":
    case "SALES_INQUIRY":
      return ctx.customer ? "Warm lead with history — pull the quote and continue the conversation." : "New inquiry — capture details and open an intake.";
    default:
      return ctx.caller.confidence === "UNKNOWN"
        ? "Caller is unidentified — verify identity before sharing or changing any account detail."
        : "Review the context pack and continue with the caller's request.";
  }
}

export function buildHandoffBrief(ctx: ContextPack, reason: CallReason, opts: { summary?: string | null; requestedChange?: string | null } = {}): HandoffBrief {
  return {
    generatedAt: new Date().toISOString(),
    customer: ctx.customer?.name ?? ctx.caller.displayName,
    event: ctx.events[0]?.name ?? null,
    reason,
    reasonLabel: REASON_LABEL[reason],
    currentState: currentState(ctx),
    requestedChange: opts.requestedChange ?? null,
    // There is no live inventory source — always honest.
    inventoryAvailability: "Unavailable — no live inventory source is connected.",
    aiRecommendation: recommend(ctx, reason),
    conversationSummary: (opts.summary ?? "").trim() || "Summary unavailable.",
    identityConfidence: ctx.caller.confidence,
  };
}
