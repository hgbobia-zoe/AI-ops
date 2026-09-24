// VOICE LAB — validate context assembly BEFORE a real call is ever on the line. Given a caller number,
// a scenario, and (optionally) a specific customer/event, it builds the exact Context Pack the agent
// would receive, classifies the reason, runs the READ-ONLY tools that would fire (for real, so you see
// the actual data), and shows which controlled actions the scenario implies — each returned by the
// executor as BLOCKED (proving the agent can't self-authorize). Sona isn't connected, so the AI response
// is an explicit placeholder; NO real call is ever placed. This is a test harness, not a live line.

import { classifyReason, REASON_LABEL, type CallReason } from "./reasons";
import { buildContextPack } from "./context";
import { executeTool, type ToolResult } from "./tools";
import type { ContextPack } from "./types";

export interface SimulationRequest {
  phone: string | null;
  scenario: string; // what the caller says / why they're calling
  bookingId?: string | null; // optional disambiguation anchor
}

export interface SimulationResult {
  request: SimulationRequest;
  reason: CallReason;
  reasonLabel: string;
  reasonConfidence: number;
  context: ContextPack;
  readTools: ToolResult[]; // the read-only tools that would fire, with their real results
  actionTools: ToolResult[]; // the controlled actions the scenario implies — returned BLOCKED
  aiResponse: string; // placeholder — Sona is not connected
  expectedResult: string; // deterministic, honest expectation
}

// Which read-only tools an agent would call for a given reason (always identify first).
function readPlanFor(reason: CallReason): string[] {
  const base = ["identifyCaller", "getRecentInteractions"];
  switch (reason) {
    case "DELIVERY_STATUS": return [...base, "getDeliveryStatus", "getOrder", "getOperationalRisk"];
    case "PICKUP_STATUS": return [...base, "getPickupStatus", "getOrder"];
    case "EXISTING_ORDER":
    case "EVENT_CHANGE": return [...base, "getOrder", "getEvent", "getOperationalRisk"];
    case "QUOTE_FOLLOW_UP": return [...base, "getQuote", "getUpcomingEvents"];
    case "SALES_INQUIRY":
    case "INVENTORY_QUESTION": return [...base, "getUpcomingEvents", "getAvailableInventory"];
    case "BILLING":
    case "PAYMENT": return [...base, "getOrder"];
    case "DAMAGE":
    case "COMPLAINT": return [...base, "getOrder", "getOperationalRisk"];
    default: return base;
  }
}

// The controlled action a scenario tends to imply — shown blocked, never executed.
function actionPlanFor(reason: CallReason): string | null {
  switch (reason) {
    case "CANCELLATION":
    case "COMPLAINT":
    case "DAMAGE": return "requestHumanTransfer";
    case "PAYMENT":
    case "BILLING": return "createCallbackRequest";
    case "EVENT_CHANGE": return "createInternalTask";
    case "QUOTE_FOLLOW_UP":
    case "SALES_INQUIRY": return "sendCustomerSMS";
    default: return null;
  }
}

export async function simulateCall(req: SimulationRequest): Promise<SimulationResult> {
  const verdict = classifyReason(req.scenario);
  const reason = verdict.reason;
  const context = await buildContextPack(req.phone, { anchorBookingId: req.bookingId ?? null });

  const phone = context.customer?.phone ?? req.phone;
  const bookingId = context.customer?.bookingId ?? req.bookingId ?? null;

  // Run the read-only plan for real, as the agent ("sona") would — enforced read-only.
  const readTools: ToolResult[] = [];
  for (const name of readPlanFor(reason)) {
    readTools.push(await executeTool(name, { phone, bookingId }, { caller: "sona", dryRun: true }));
  }

  // The implied controlled action, invoked as the agent — the executor returns it BLOCKED.
  const actionTools: ToolResult[] = [];
  const action = actionPlanFor(reason);
  if (action) actionTools.push(await executeTool(action, { phone, bookingId }, { caller: "sona", dryRun: true }));

  const aiResponse =
    "Sona is not connected. With the Context Pack above, the AI response would be generated here — grounded in verified facts only, and never inventing inventory, pricing, delivery windows, or identity.";

  const expectedResult = expectation(reason, context);

  return {
    request: req,
    reason,
    reasonLabel: REASON_LABEL[reason],
    reasonConfidence: verdict.confidence,
    context,
    readTools,
    actionTools,
    aiResponse,
    expectedResult,
  };
}

function expectation(reason: CallReason, ctx: ContextPack): string {
  if (ctx.caller.confidence === "UNKNOWN") return "Caller is UNIDENTIFIED — the agent should verify identity before sharing or changing any account detail.";
  if (ctx.caller.confidence === "MULTIPLE_MATCHES") return "Caller matches MULTIPLE customers — the agent should disambiguate before proceeding.";
  switch (reason) {
    case "DELIVERY_STATUS":
    case "PICKUP_STATUS":
      return ctx.delivery.availability === "UNAVAILABLE" && ctx.pickup.availability === "UNAVAILABLE"
        ? "No dispatch stop matched — the agent should say the window is Unavailable and route to a human, not guess a time."
        : "The agent can share the real dispatch window/ETA from the pack.";
    case "PAYMENT":
    case "BILLING":
      return "The agent should route to billing and confirm the balance in Goodshuffle, never quote adjustments verbally.";
    default:
      return "The agent answers from the Context Pack and escalates anything that needs a human — the implied action is blocked pending approval.";
  }
}
