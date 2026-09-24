// The voice-agent TOOL EXECUTOR — the single, server-side enforcement point for the tool registry. The
// AI can NEVER bypass a permission: read-only tools run against real data; every controlled action is
// gated (a human must be the caller AND have approved), and DISABLED tools never run. To keep the Tower
// safe by construction the API drives this in dryRun mode — an authorized controlled action reports what
// it WOULD do and performs NO outward side effect until a human explicitly wires approval. AI SAFETY:
// missing data → "Unavailable"; we never claim success on a blocked/failed action.

import { getBookingById } from "@/lib/db/repo";
import { getRiskQueue } from "@/lib/risk/store";
import { getToolSpec, type PermissionClass } from "./toolRegistry";
import { resolveCallerIdentity, buildContextPack } from "./context";
import { getLogisticsByPhone, appendCommsLog } from "./store";
import type { ContextEventRef } from "./types";

export interface ToolContext {
  caller: "sona" | "human" | "lab" | "system"; // who is invoking the tool
  actor?: string | null; // human label for the audit log
  approved?: boolean; // a human explicitly approved this controlled action
  dryRun?: boolean; // report the decision without performing the side effect (default for the API)
}

export interface ToolResult {
  ok: boolean;
  tool: string;
  permission: PermissionClass;
  blocked?: boolean; // a permission stopped it (not an error — an enforced boundary)
  dryRun?: boolean;
  reason?: string; // why blocked / unavailable
  data?: unknown;
}

const toEventRef = (bookingId: string): ContextEventRef | null => {
  const b = getBookingById(bookingId);
  if (!b) return null;
  return { bookingId: b.bookingId, name: b.eventName || "Untitled event", eventDate: b.eventDate, status: b.statusLabel, signed: b.signed, venue: b.venue, location: b.location };
};

// ── READ-ONLY implementations (real data; honest Unavailable) ─────────────────────────────────────
type ReadInput = { phone?: string | null; bookingId?: string | null; item?: string; topic?: string; date?: string };

async function runReadOnly(name: string, input: ReadInput): Promise<unknown> {
  switch (name) {
    case "identifyCaller":
      return resolveCallerIdentity(input.phone ?? null);
    case "getCustomer": {
      const b = input.bookingId ? getBookingById(input.bookingId) : null;
      return b ? { bookingId: b.bookingId, name: b.clientName, email: b.clientEmail || null, phone: b.clientPhone || null } : { available: false, reason: "No customer for that id." };
    }
    case "getUpcomingEvents": {
      if (input.phone) return (await buildContextPack(input.phone, { anchorBookingId: input.bookingId ?? null })).events;
      const e = input.bookingId ? toEventRef(input.bookingId) : null;
      return e ? [e] : [];
    }
    case "getEvent": {
      const e = input.bookingId ? toEventRef(input.bookingId) : null;
      return e ?? { available: false, reason: "No event for that id." };
    }
    case "getQuote": {
      const b = input.bookingId ? getBookingById(input.bookingId) : null;
      if (!b) return { available: false, reason: "No quote for that id." };
      return { bookingId: b.bookingId, name: b.eventName, eventDate: b.eventDate, status: b.statusLabel, total: b.grandTotal, quoteSentDate: b.quoteSentDate, amountDue: b.amountDue, signed: b.signed };
    }
    case "getOrder": {
      const b = input.bookingId ? getBookingById(input.bookingId) : null;
      if (!b) return { available: false, reason: "No order for that id." };
      return { bookingId: b.bookingId, name: b.eventName, eventDate: b.eventDate, total: b.grandTotal, amountPaid: b.amountPaid, amountDue: b.amountDue, signed: b.signed, lineItems: b.lineItems };
    }
    case "getDeliveryStatus":
      return getLogisticsByPhone(input.phone ?? getBookingById(input.bookingId ?? "")?.clientPhone ?? null).delivery;
    case "getPickupStatus":
      return getLogisticsByPhone(input.phone ?? getBookingById(input.bookingId ?? "")?.clientPhone ?? null).pickup;
    case "getRecentInteractions": {
      const phone = input.phone ?? getBookingById(input.bookingId ?? "")?.clientPhone ?? null;
      return (await buildContextPack(phone, { anchorBookingId: input.bookingId ?? null })).recentInteractions;
    }
    case "getOperationalRisk": {
      const id = input.bookingId ?? "";
      return getRiskQueue()
        .filter((r) => r.eventId === id && (r.status === "OPEN" || r.status === "ACKNOWLEDGED" || r.status === "IN_PROGRESS"))
        .map((r) => ({ severity: r.severity, title: r.title, date: r.date ?? null, category: r.category }));
    }
    case "getAvailableInventory":
      return { available: "Unavailable", reason: "No live inventory source is connected. Do not quote availability." };
    case "getKnowledgeArticle":
      return { found: false, reason: "No knowledge base is connected. Do not answer policy questions from memory." };
    default:
      return { available: false, reason: "Not a read-only tool." };
  }
}

/** Execute a registered tool with full permission enforcement. This is the ONLY sanctioned path from a
 *  voice agent to Zoe's systems. */
export async function executeTool(name: string, input: ReadInput & Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const spec = getToolSpec(name);
  if (!spec) return { ok: false, tool: name, permission: "DISABLED", blocked: true, reason: "Unknown tool — not in the registry." };
  const base = { tool: name, permission: spec.permission };

  if (spec.permission === "DISABLED") {
    return { ...base, ok: false, blocked: true, reason: "This action is disabled. It requires a human in Goodshuffle / dispatch." };
  }

  if (spec.permission === "READ_ONLY") {
    const data = await runReadOnly(name, input);
    return { ...base, ok: true, data };
  }

  // Controlled action — gated. The agent can never authorize; only a human who explicitly approved.
  const authorized = ctx.caller === "human" && ctx.approved === true;
  if (!authorized) {
    return { ...base, ok: false, blocked: true, reason: `Requires explicit human approval (${spec.permission}). The voice agent cannot authorize this — routed for human review.` };
  }

  // Authorized. In dryRun (the API default) we report the decision but perform no outward side effect.
  if (ctx.dryRun !== false) {
    return { ...base, ok: true, dryRun: true, data: { wouldExecute: name, input } };
  }

  // Perform (only reachable when a caller explicitly opts out of dryRun with an approved human).
  return performAction(name, input, ctx, spec.permission);
}

async function performAction(name: string, input: ReadInput & Record<string, unknown>, ctx: ToolContext, permission: PermissionClass): Promise<ToolResult> {
  const base = { tool: name, permission };
  switch (name) {
    case "createCallbackRequest":
    case "createInternalTask": {
      // Internal-only: recorded to the immutable log. No outward message is ever sent from here.
      appendCommsLog({
        conversationId: String(input.bookingId ?? input.phone ?? "adhoc"),
        source: "system",
        eventType: name === "createCallbackRequest" ? "action.callback_requested" : "action.task_created",
        payload: { input, actor: ctx.actor ?? null },
      });
      return { ...base, ok: true, data: { recorded: true } };
    }
    case "requestHumanTransfer":
      // Produces the decision to escalate; the actual transfer is telephony's job. No side effect here.
      return { ...base, ok: true, data: { escalate: true } };
    case "sendCustomerSMS":
      // The wire to the real SMS provider exists (src/lib/notify/sms.ts), but the console never auto-fires
      // it — going live requires an explicit approval UI. Refuse to send from here.
      return { ...base, ok: false, blocked: true, reason: "Outbound SMS send is not yet wired to a human-approval UI. No message sent." };
    default:
      return { ...base, ok: false, blocked: true, reason: "No implementation." };
  }
}
