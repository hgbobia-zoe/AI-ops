// The voice-agent TOOL REGISTRY (metadata only — no implementations here, so the Context Engine can
// import the allowed-action names without a cycle). Every tool carries an explicit PERMISSION CLASS.
// This is the contract boundary: QUO/SONA → ZOE COMMUNICATIONS API → CONTEXT ENGINE → data → RULES →
// ACTION. The voice agent never gets unrestricted access; it may only ever attempt what is declared
// here, and the executor (tools.ts) enforces the class server-side. AI can NEVER bypass a permission.

export type PermissionClass =
  | "READ_ONLY" // safe reads over verified data — the agent may call freely
  | "CUSTOMER_CONFIRMED_ACTION" // side effect allowed only after the CUSTOMER confirms in-call
  | "HUMAN_APPROVAL_REQUIRED" // side effect allowed only after a Zoe human approves
  | "ADMIN_ONLY" // owner/admin operator only
  | "DISABLED"; // declared for the roadmap, but never executable yet

export const PERMISSION_LABEL: Record<PermissionClass, string> = {
  READ_ONLY: "Read-only",
  CUSTOMER_CONFIRMED_ACTION: "Customer-confirmed",
  HUMAN_APPROVAL_REQUIRED: "Human approval",
  ADMIN_ONLY: "Admin only",
  DISABLED: "Disabled",
};

export interface ToolSpec {
  name: string;
  permission: PermissionClass;
  description: string;
  implemented: boolean; // is there a live implementation, or is this a declared-but-stubbed action?
  args: string[]; // the inputs it accepts (documentation)
}

export const TOOL_REGISTRY: ToolSpec[] = [
  // ── READ-ONLY — implemented for real against existing data ──────────────────────────────────────
  { name: "identifyCaller", permission: "READ_ONLY", implemented: true, description: "Resolve a phone number to a customer identity with explicit confidence (CONFIRMED / MULTIPLE_MATCHES / UNKNOWN).", args: ["phone"] },
  { name: "getCustomer", permission: "READ_ONLY", implemented: true, description: "Fetch the matched customer's name, email and phone.", args: ["bookingId"] },
  { name: "getUpcomingEvents", permission: "READ_ONLY", implemented: true, description: "List the caller's related events (upcoming and recent).", args: ["bookingId", "phone"] },
  { name: "getEvent", permission: "READ_ONLY", implemented: true, description: "Fetch one event's date, status, venue and location.", args: ["bookingId"] },
  { name: "getQuote", permission: "READ_ONLY", implemented: true, description: "Fetch an unsigned quote's total, sent date and balance.", args: ["bookingId"] },
  { name: "getOrder", permission: "READ_ONLY", implemented: true, description: "Fetch a signed order's totals, balance and captured line items.", args: ["bookingId"] },
  { name: "getDeliveryStatus", permission: "READ_ONLY", implemented: true, description: "Delivery window / ETA / state from the dispatch layer, matched by phone. Unavailable when no stop exists.", args: ["bookingId", "phone"] },
  { name: "getPickupStatus", permission: "READ_ONLY", implemented: true, description: "Pickup window / state from the dispatch layer, matched by phone. Unavailable when no stop exists.", args: ["bookingId", "phone"] },
  { name: "getRecentInteractions", permission: "READ_ONLY", implemented: true, description: "The caller's recent calls, texts and email history.", args: ["bookingId", "phone"] },
  { name: "getOperationalRisk", permission: "READ_ONLY", implemented: true, description: "Open operational risks on the caller's event(s), from the Event Risk engine.", args: ["bookingId"] },
  { name: "getAvailableInventory", permission: "READ_ONLY", implemented: false, description: "Real-time inventory availability. No live inventory source is connected — always returns Unavailable.", args: ["item", "date"] },
  { name: "getKnowledgeArticle", permission: "READ_ONLY", implemented: false, description: "A policy / FAQ answer from a knowledge base. No knowledge base is connected — always returns Unavailable.", args: ["topic"] },

  // ── CONTROLLED — declared + gated. Never fired by the AI; a human/customer must authorize. ───────
  { name: "createCallbackRequest", permission: "HUMAN_APPROVAL_REQUIRED", implemented: true, description: "Queue a callback for a Zoe rep. Recorded to the event log; never texts or calls on its own.", args: ["bookingId", "phone", "note"] },
  { name: "createInternalTask", permission: "HUMAN_APPROVAL_REQUIRED", implemented: true, description: "Create an internal follow-up task for the team. Recorded only; no outward message.", args: ["bookingId", "note"] },
  { name: "sendCustomerSMS", permission: "HUMAN_APPROVAL_REQUIRED", implemented: true, description: "Send an SMS to the customer via the existing provider. Gated: only fires on explicit human approval, never from the agent.", args: ["phone", "body"] },
  { name: "requestHumanTransfer", permission: "CUSTOMER_CONFIRMED_ACTION", implemented: true, description: "Escalate to a human with a generated handoff brief. Produces the brief; the transfer itself is performed by telephony.", args: ["bookingId", "phone", "reason"] },

  // ── FUTURE — declared so the boundary is explicit, but hard-DISABLED until built + authorized. ───
  { name: "modifyOrder", permission: "DISABLED", implemented: false, description: "Change line items on an order. Not enabled — order mutations require a human in Goodshuffle.", args: ["bookingId", "changes"] },
  { name: "rescheduleDelivery", permission: "DISABLED", implemented: false, description: "Move a delivery/pickup window. Not enabled — dispatch changes require a human.", args: ["bookingId", "window"] },
  { name: "processPayment", permission: "DISABLED", implemented: false, description: "Take a payment. Not enabled — payments are never handled by the voice agent.", args: ["bookingId", "amount"] },
  { name: "cancelOrder", permission: "DISABLED", implemented: false, description: "Cancel an order. Not enabled — cancellations require a human.", args: ["bookingId"] },
];

export function getToolSpec(name: string): ToolSpec | null {
  return TOOL_REGISTRY.find((t) => t.name === name) ?? null;
}

/** Tool names an agent MAY attempt for a caller (everything not hard-DISABLED). The executor still
 *  enforces each tool's permission class — appearing here is not authorization to cause a side effect. */
export function allowedActionNames(): string[] {
  return TOOL_REGISTRY.filter((t) => t.permission !== "DISABLED").map((t) => t.name);
}
