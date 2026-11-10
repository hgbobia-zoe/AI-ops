// Viktor's tools: what the in-app agent may READ, plus the two governed WRITES it may make (raise an
// approval card, file a feature request). This replaces the office-machine responder's curl calls with
// direct in-process function calls over the same data and the same governed paths.
//
// Governing law: RULES CALCULATE, AI INTERPRETS. Every read tool returns facts the app already computed.
// The only writes are (1) proposeFromSession, which creates a PENDING approval a human must decide (the
// forbidden categories money / pricing / schedule / hiring / Instawork never execute, even after approval),
// either one card (propose_action) or the follow ups from a finished call (act_on_call), and
// (2) createRequest, which files a backlog row. Nothing here sends, schedules, or changes operational
// data. Money fields are stripped unless the person asking may see financials.

import type Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import { todayInOpsTz } from "@/lib/dates";
import { getActiveVehicles } from "@/lib/vehicles";
import { getRoutesForDate, getOpenExceptions, searchBookings } from "@/lib/db/repo";
import { getCrewForDateSafe } from "@/lib/connecteam";
import { getRiskQueue } from "@/lib/risk/store";
import { listPendingApprovals, type ApprovalActionType, type ApprovalCard, isForbiddenActionType } from "@/lib/aiorg/approvals";
import { getEmployee } from "@/lib/aiorg/registry";
import { proposeFromSession } from "@/lib/ai/propose";
import { createRequest } from "@/lib/ai/requests";
import { classifyIntentAgent } from "@/lib/ai/intentRouting";
import { recordToolRun } from "@/lib/ai/sessions";
import { actOnCall } from "@/lib/calls/actOnCall";

/** Who is asking and where, so tools can attribute writes and redact money. */
export interface ViktorToolContext {
  sessionId: string;
  /** The instruction's timestamp: the idempotency anchor for any write this turn makes. */
  instructionTs: string;
  /** The human who gave the instruction (Slack user id or app user label). */
  askedBy: string;
  /** The instruction text (used to classify the owning AI employee when the model omits one). */
  instruction: string;
  /** Whether money fields may be shown to the person asking. */
  showMoney: boolean;
  /** Session blade, if any (default blade for filed requests). */
  blade: string | null;
}

export const ACTION_TYPES: ApprovalActionType[] = [
  "send_email",
  "send_sms",
  "append_note",
  "create_gs_task",
  "modify_quote",
  "change_pricing",
  "schedule_change",
  "hiring",
  "firing",
  "instawork_gig",
];

const YMD = /^\d{4}-\d{2}-\d{2}$/;

// Tool list is a constant, deterministic in order and content, so the prompt prefix caches.
export const VIKTOR_TOOLS: Anthropic.Tool[] = [
  {
    name: "ops_snapshot",
    description:
      "Today's operations at a glance: routes, stops done and remaining, trucks used, open exceptions, crew on the schedule, attention items, and capacity flags for the next days. Use first for broad questions like 'how is today going'.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "routes_for_date",
    description:
      "Delivery and pickup routes for one date (YYYY-MM-DD): truck, driver, status, and each stop in order with customer, kind, planned window and state.",
    input_schema: {
      type: "object",
      properties: { date: { type: "string", description: "YYYY-MM-DD in the ops timezone (America/New_York)." } },
      required: ["date"],
      additionalProperties: false,
    },
  },
  {
    name: "crew_for_date",
    description:
      "Connecteam shifts for one date: who works, their shift title, start and end time, and open (unassigned) shifts. Returns verified=false when Connecteam could not be reached; never treat that as 'nobody scheduled'.",
    input_schema: {
      type: "object",
      properties: { date: { type: "string", description: "YYYY-MM-DD" } },
      required: ["date"],
      additionalProperties: false,
    },
  },
  {
    name: "search_bookings",
    description:
      "Search Goodshuffle projects (bookings, quotes, leads) by client name, event name, venue, email or phone. Returns event date, status, client, venue, sales lead and bookingId (the Goodshuffle transactionID).",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 25 },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "risk_queue",
    description: "The Event Risk Engine's open early-warning queue: upcoming events or routes with a scored risk, why, and the recommended action.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "open_exceptions",
    description: "Unresolved dispatch exceptions (stop problems drivers reported), newest first.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "pending_approvals",
    description: "Action requests waiting for a human decision in the app (title, owning AI employee, action type, when raised).",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "propose_action",
    description:
      "Raise an approval card for something the person wants DONE in the business (send an email or text, add a note or task, change a schedule, a quote or pricing). This does NOT do the action: a human approves it in the app first. Money, pricing, schedule, hiring and Instawork types are accepted as proposals but never execute, even after approval. Fill every card field from real facts you looked up.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short action headline." },
        actionType: { type: "string", enum: ACTION_TYPES },
        agentId: {
          type: "string",
          description:
            "Owning AI employee id: scheduling, outreach, quote-analyst, inventory-exception, dispatch-route, hiring, staffing, or viktor when no clear owner. Omit to let the app classify.",
        },
        actionPayload: {
          type: "object",
          description: "The concrete action, e.g. {transactionId, subject, content} for an email or {transactionId, content} for a note.",
        },
        card: {
          type: "object",
          properties: {
            what: { type: "string" },
            why: { type: "string" },
            dataUsed: { type: "string" },
            expectedOutcome: { type: "string" },
            risk: { type: "string" },
            whatIfApproved: { type: "string" },
          },
          required: ["what", "why", "dataUsed", "expectedOutcome", "risk", "whatIfApproved"],
          additionalProperties: false,
        },
      },
      required: ["title", "actionType", "card"],
      additionalProperties: false,
    },
  },
  {
    name: "act_on_call",
    description:
      "Act on a finished phone call (Quo). Reads the call transcript, links it to the client's Goodshuffle project by phone, and raises approval cards for the follow ups: an email to the client, a call note on the project, tasks for the commitments made, a drafted text, and a quote update proposal when pricing came up. Use this instead of propose_action when the person asks you to act on, follow up on, or handle a call. Nothing sends until a human approves. Re-running the same call finds the cards already raised instead of duplicating them.",
    input_schema: {
      type: "object",
      properties: {
        contact: {
          type: "string",
          description: "Client name or phone digits the call was with. Omit to use the most recent call that has a transcript.",
        },
        callId: { type: "string", description: "Exact call id, only if the person gave one." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "file_feature_request",
    description:
      "File a change to the PRODUCT itself (the app or a blade should do something new or differently) into the Requests backlog. Not for business actions; use propose_action for those.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        body: { type: "string", description: "The full ask in the person's own words." },
        blade: { type: "string", description: "Which blade it concerns, if clear." },
      },
      required: ["title", "body"],
      additionalProperties: false,
    },
  },
];

export type ToolWrite = { kind: "approval"; id: string; title: string; forbidden: boolean } | { kind: "request"; id: string; title: string };

/** What happened when a tool ran: the text handed back to the model plus any governed write it made. */
export interface ToolOutcome {
  content: string;
  isError: boolean;
  /** Set when the tool raised an approval or filed a request, so the worker can report it. */
  write?: ToolWrite;
  /** For a tool that raises several approvals in one call (act_on_call). */
  writes?: ToolWrite[];
}

function ok(data: unknown): ToolOutcome {
  return { content: JSON.stringify(data), isError: false };
}
function fail(message: string): ToolOutcome {
  return { content: JSON.stringify({ error: message }), isError: true };
}
function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}
function shortHash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 10);
}

/** Validate a propose_action card: all six fields must be non-empty strings. PURE. */
export function parseCard(v: unknown): ApprovalCard | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const keys: (keyof ApprovalCard)[] = ["what", "why", "dataUsed", "expectedOutcome", "risk", "whatIfApproved"];
  const card = {} as ApprovalCard;
  for (const k of keys) {
    const s = str(o[k]);
    if (!s) return null;
    card[k] = s;
  }
  return card;
}

const MONEY_KEYS = new Set(["grandTotal", "contractTotal", "amountPaid", "amountDue", "scheduledRevenue", "finance", "revenue", "sales", "pipeline"]);

/** Drop money fields (recursively) when the asker may not see financials. PURE. */
export function redactMoney<T>(value: T, showMoney: boolean): T {
  if (showMoney || value == null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redactMoney(v, false)) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (MONEY_KEYS.has(k)) continue;
    out[k] = redactMoney(v, false);
  }
  return out as T;
}

function fmtUnix(unix: number, tz: string): string {
  try {
    return new Date(unix * 1000).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz || "America/New_York" });
  } catch {
    return new Date(unix * 1000).toISOString();
  }
}

async function runTool(name: string, input: Record<string, unknown>, ctx: ViktorToolContext): Promise<ToolOutcome> {
  switch (name) {
    case "ops_snapshot": {
      // Lazy import: commandCenter pulls a wide dependency graph; keep it off the module's load path.
      const { commandCenter } = await import("@/lib/command/service");
      const cc = await commandCenter();
      return ok(
        redactMoney(
          {
            today: cc.today,
            status: cc.status,
            brief: cc.brief,
            todayOps: cc.today_ops,
            people: { verified: cc.people.verified, peopleCount: cc.people.peopleCount, drivers: cc.people.drivers, prep: cc.people.prep, openShifts: cc.people.openShifts },
            attention: cc.attention.slice(0, 10).map((a) => ({ priority: a.priority, title: a.title, detail: a.detail })),
            capacity: cc.capacity,
            finance: cc.finance,
            revenue: cc.revenue,
          },
          ctx.showMoney,
        ),
      );
    }
    case "routes_for_date": {
      const date = str(input.date);
      if (!YMD.test(date)) return fail("date must be YYYY-MM-DD");
      const routes = getActiveVehicles().flatMap((t) => getRoutesForDate(t.truckId, date).map((r) => ({ r, truck: t.name })));
      return ok({
        date,
        routes: routes.map(({ r, truck }) => ({
          truck,
          driver: r.driverName ?? null,
          status: r.status,
          stops: r.stops.map((s) => ({ seq: s.sequence, customer: s.custName, kind: s.kind ?? "delivery", window: s.plannedWindow ?? null, state: s.state, address: s.address })),
        })),
      });
    }
    case "crew_for_date": {
      const date = str(input.date);
      if (!YMD.test(date)) return fail("date must be YYYY-MM-DD");
      const crew = await getCrewForDateSafe(date);
      return ok({
        date,
        verified: crew.ok,
        shifts: crew.shifts.map((s) => ({ who: s.isOpen ? null : s.schedulerName || null, title: s.title, start: fmtUnix(s.startUnix, s.timezone), end: fmtUnix(s.endUnix, s.timezone), open: s.isOpen })),
      });
    }
    case "search_bookings": {
      const query = str(input.query);
      if (!query) return fail("query required");
      const limit = typeof input.limit === "number" ? Math.min(25, Math.max(1, Math.floor(input.limit))) : 10;
      const rows = searchBookings(query, limit).map((b) => ({
        bookingId: b.bookingId,
        eventName: b.eventName,
        eventDate: b.eventDate,
        status: b.statusLabel,
        signed: b.signed,
        client: b.clientName,
        venue: b.venue,
        salesLead: b.salesLead ?? null,
        quoteSent: b.quoteSentDate,
        archived: b.archived,
        grandTotal: b.grandTotal,
        amountDue: b.amountDue,
      }));
      return ok({ query, results: redactMoney(rows, ctx.showMoney) });
    }
    case "risk_queue": {
      const risks = getRiskQueue(todayInOpsTz()).slice(0, 25);
      return ok(risks.map((r) => ({ severity: r.severity, category: r.category, title: r.title, description: r.description, date: r.date ?? null, recommendedAction: r.recommendedAction ?? null, status: r.status })));
    }
    case "open_exceptions": {
      return ok(getOpenExceptions().slice(0, 25).map((e) => ({ type: e.type, reason: e.reason, truckId: e.truckId, at: e.ts })));
    }
    case "pending_approvals": {
      return ok(listPendingApprovals(25).map((a) => ({ title: a.title, agentId: a.agentId, actionType: a.actionType, status: a.status, raisedAt: a.createdAt })));
    }
    case "propose_action": {
      const title = str(input.title);
      if (!title) return fail("title required");
      const actionType = input.actionType as ApprovalActionType;
      if (!ACTION_TYPES.includes(actionType)) return fail("unknown actionType");
      const card = parseCard(input.card);
      if (!card) return fail("card needs all six fields filled from real facts");
      const explicit = str(input.agentId);
      const agentId = explicit && getEmployee(explicit) ? explicit : classifyIntentAgent(ctx.instruction).agentId;
      const payload = input.actionPayload && typeof input.actionPayload === "object" ? (input.actionPayload as Record<string, unknown>) : {};
      const approval = proposeFromSession(
        ctx.sessionId,
        {
          agentId,
          owner: ctx.askedBy,
          title,
          actionType,
          actionPayload: payload,
          card,
          financial: actionType === "modify_quote" || actionType === "change_pricing",
          idempotencyKey: `viktor:${ctx.instructionTs}:${shortHash(title + actionType)}`,
        },
        "Viktor",
      );
      if (!approval) return fail("session is closed; cannot raise an approval");
      const forbidden = isForbiddenActionType(actionType);
      return {
        content: JSON.stringify({ ok: true, approvalId: approval.id, status: approval.status, owner: agentId, executesAfterApproval: !forbidden }),
        isError: false,
        write: { kind: "approval", id: approval.id, title, forbidden },
      };
    }
    case "act_on_call": {
      const result = await actOnCall({
        callId: str(input.callId) || undefined,
        contactQuery: str(input.contact) || undefined,
        requestedBy: ctx.askedBy,
        // Link every card to this Viktor session, so it shows on the session timeline like propose_action.
        raise: (approval) => proposeFromSession(ctx.sessionId, approval, "Viktor"),
      });
      if (!result.ok) return fail(result.error ?? "could not act on the call");
      const writes: ToolWrite[] = result.created
        .filter((c) => c.isNew)
        .map((c) => ({ kind: "approval", id: c.id, title: c.title, forbidden: isForbiddenActionType(c.actionType as ApprovalActionType) }));
      return {
        content: JSON.stringify({
          ok: true,
          callId: result.callId,
          contact: result.contact ?? null,
          cards: result.created.map((c) => ({
            title: c.title,
            actionType: c.actionType,
            status: c.isNew ? "raised now, waiting for approval" : "already waiting for approval",
            executesAfterApproval: !isForbiddenActionType(c.actionType as ApprovalActionType),
          })),
          skipped: result.skipped,
        }),
        isError: false,
        writes,
      };
    }
    case "file_feature_request": {
      const title = str(input.title);
      const body = str(input.body);
      if (!title || !body) return fail("title and body required");
      const req = createRequest({
        title,
        body,
        type: "feature",
        blade: str(input.blade) || ctx.blade,
        sessionId: ctx.sessionId,
        requestedBy: ctx.askedBy,
        changeKey: `req:${ctx.instructionTs}:${shortHash(title)}`,
      });
      return { content: JSON.stringify({ ok: true, requestId: req.id, status: req.status }), isError: false, write: { kind: "request", id: req.id, title } };
    }
    default:
      return fail(`unknown tool ${name}`);
  }
}

/** The tools that make a governed write (everything else only reads). */
const WRITE_TOOLS = new Set(["propose_action", "act_on_call", "file_feature_request"]);

/** Run one tool call, record it on the session timeline, and never throw. */
export async function executeViktorTool(name: string, input: unknown, ctx: ViktorToolContext): Promise<ToolOutcome> {
  const args = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  let outcome: ToolOutcome;
  try {
    outcome = await runTool(name, args, ctx);
  } catch (e) {
    outcome = fail(`tool failed: ${String(e instanceof Error ? e.message : e).slice(0, 200)}`);
  }
  try {
    recordToolRun(ctx.sessionId, {
      toolId: name,
      category: WRITE_TOOLS.has(name) ? "write" : "read",
      perm: name === "propose_action" || name === "act_on_call" ? "approval" : "read",
      args,
      result: {
        size: outcome.content.length,
        ...(outcome.write ? { write: outcome.write } : {}),
        ...(outcome.writes?.length ? { writes: outcome.writes } : {}),
      },
      status: outcome.isError ? "error" : "ok",
      error: outcome.isError ? outcome.content.slice(0, 300) : undefined,
    });
  } catch {
    /* timeline logging is best-effort */
  }
  return outcome;
}
