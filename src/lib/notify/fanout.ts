// Action fan-out — the code replacement for the Zapier Zaps. Given a driver action
// and the affected stop(s), it sends the customer SMS, posts Slack alerts, creates
// tracking links, and records everything to the DB. Called fire-and-forget from the
// action intake so the tablet never waits. Every send is key-gated and never throws.

import type { ActionType, CloseoutResult, Stop, Vehicle } from "@/lib/types";
import { sendSms } from "./sms";
import { slackNotify } from "./slack";
import { alertOps } from "./alert";
import { createTracking, expireTracking, insertMessage, insertException, insertAudit } from "@/lib/db/repo";
import { getSettings, renderTemplate, templateForKind, type AppSettings } from "@/lib/settings";
import { formatClockTime } from "@/lib/dates";

export interface FanoutCtx {
  action: ActionType;
  truckId: string;
  routeId?: string;
  driverId?: string;
  gps?: unknown;
  payload?: Record<string, unknown>;
  baseUrl: string;
  currentStop: Stop | null;
  nextStop: Stop | null;
}

// Human labels for the closeout items, in checklist order — used to name what a driver
// couldn't confirm when flagging the closeout to the office.
const CLOSEOUT_LABELS: [keyof CloseoutResult, string][] = [
  ["refueled", "Refuel"],
  ["itemsUnloaded", "Unload returned rentals"],
  ["discrepanciesReported", "Report discrepancies"],
  ["damageInspected", "Inspect for damage"],
  ["securedKeysReturned", "Secure truck & return keys"],
  ["notesSubmitted", "Submit route notes"],
];

// The customer tracking link. We now ALWAYS send our own /track link — it renders real server-side
// live GPS + ETA, so it is "the real link, not a fallback," and we never hand Zonar the customer's
// number (so the notify-line rule is moot). The Zoe main line (301-291-5296) stays the only notify
// number on any residual Zonar link.
//
// TODO(remove next release): the tablet-minted Zonar `payload.etaLink` and the static per-truck
// `ignitionEtaLinks` are the retired device-login path. Kept DORMANT one release as a rollback:
// set GS_ETALINK_LEGACY=1 to restore their old priority over /track. Delete this branch (and the
// setting / kioskBridge minting) next release.
function trackingLink(
  ctx: FanoutCtx,
  stop: Stop,
  settings: AppSettings,
): string {
  if (process.env.GS_ETALINK_LEGACY === "1") {
    const legacy = (ctx.payload?.etaLink as string | undefined) || settings.ignitionEtaLinks[ctx.truckId];
    if (legacy) return legacy;
  }
  return createTracking(stop.stopId, stop.routeId, ctx.baseUrl).url;
}

function truckLabel(truckId: string): string {
  try {
    const list = JSON.parse(process.env.VEHICLES_JSON || "[]") as Vehicle[];
    return list.find((v) => v.truckId === truckId)?.name || truckId;
  } catch {
    return truckId;
  }
}

// First name only, e.g. "Kadzo Mwangi" → "Kadzo".
function firstName(name?: string): string {
  return (name || "there").trim().split(/\s+/)[0] || "there";
}

// How to address the customer in a text. Prefer the real first name from Goodshuffle's
// renter (custFirstName); fall back to the first token of the display name — which is
// often an event/last-name label ("Lebensohn - Wedding"), hence the preference.
export function greetName(stop: Stop): string {
  return firstName(stop.custFirstName || stop.custName);
}


// Values a message template can reference. `who` is the greeting name — the customer's
// first name on customer texts, the coordinator's on coordinator texts.
function templateVars(
  s: AppSettings,
  stop: Stop,
  truck: string,
  who: string,
  link?: string,
): Record<string, string | undefined> {
  return {
    firstName: who,
    custName: stop.custName || "your event",
    company: s.companyName,
    truck,
    address: stop.address,
    eta: formatClockTime(stop.eta),
    window: formatClockTime(stop.plannedWindow),
    link, // undefined → its line is dropped by renderTemplate
  };
}

const slotText = (
  s: AppSettings,
  stop: Stop,
  slot: "onWay" | "arrived" | "coordinatorOnWay" | "coordinatorArrived",
): string => templateForKind(s.templates, stop.kind, slot);

// Customer texts (editable in /admin; defaults match the original Quo wording).
function onWayText(s: AppSettings, stop: Stop, truck: string, link?: string): string {
  return renderTemplate(slotText(s, stop, "onWay"), templateVars(s, stop, truck, greetName(stop), link));
}
function arrivedText(s: AppSettings, stop: Stop, truck: string): string {
  return renderTemplate(slotText(s, stop, "arrived"), templateVars(s, stop, truck, greetName(stop)));
}

// Day-of coordinator variants — same info, addressed to the coordinator.
function coordinatorOnWayText(s: AppSettings, stop: Stop, truck: string, link?: string): string {
  return renderTemplate(
    slotText(s, stop, "coordinatorOnWay"),
    templateVars(s, stop, truck, firstName(stop.dayOfName), link),
  );
}
function coordinatorArrivedText(s: AppSettings, stop: Stop, truck: string): string {
  return renderTemplate(
    slotText(s, stop, "coordinatorArrived"),
    templateVars(s, stop, truck, firstName(stop.dayOfName)),
  );
}

async function sendTo(stopId: string, phone: string, body: string): Promise<void> {
  const r = await sendSms(phone, body);
  insertMessage({
    stopId,
    channel: "SMS",
    provider: "openphone",
    toPhone: phone,
    body,
    providerMsgId: r.providerMsgId,
    status: r.ok ? "sent" : r.skipped ? "skipped" : "failed",
    error: r.error,
  });
  if (r.skipped) console.log("[fanout] SMS not configured — would send:", body.slice(0, 80));
  else if (!r.ok) {
    console.error("[fanout] SMS failed:", r.error);
    // The customer/coordinator never got their text — surface it to dispatch.
    void alertOps("SMS (Quo/OpenPhone)", `to ${phone}: ${r.error ?? "unknown error"}`);
  }
}

/** Text the customer. */
async function sms(stop: Stop, body: string): Promise<void> {
  await sendTo(stop.stopId, stop.custPhone, body);
}

/** Text the day-of coordinator too, if this stop has one. */
async function smsCoordinator(stop: Stop, body: string): Promise<void> {
  if (!stop.dayOfPhone) return;
  await sendTo(stop.stopId, stop.dayOfPhone, body);
}

async function slack(text: string): Promise<void> {
  const r = await slackNotify(text);
  if (r.skipped) console.log("[fanout] Slack not configured — would post:", text);
  else if (!r.ok) console.error("[fanout] Slack failed:", r.error);
}

export async function runFanout(ctx: FanoutCtx): Promise<void> {
  const s = getSettings();
  const truck = truckLabel(ctx.truckId);
  const cur = ctx.currentStop;
  try {
    switch (ctx.action) {
      case "LEAVING_WAREHOUSE": {
        if (!cur) break;
        // Our own /track link — real server-side live GPS + ETA (see trackingLink).
        const link = trackingLink(ctx, cur, s);
        await sms(cur, onWayText(s, cur, truck, link));
        await smsCoordinator(cur, coordinatorOnWayText(s, cur, truck, link));
        await slack(`🚚 ${truck} departed → ${cur.custName}${cur.dayOfName ? ` (day-of: ${cur.dayOfName})` : ""}`);
        break;
      }
      case "ARRIVED": {
        if (!cur) break;
        await sms(cur, arrivedText(s, cur, truck));
        await smsCoordinator(cur, coordinatorArrivedText(s, cur, truck));
        await slack(`📍 ${truck} arrived at ${cur.custName}`);
        break;
      }
      case "HEADING_NEXT": {
        if (cur) {
          expireTracking(cur.stopId);
          await slack(`✅ ${truck} completed ${cur.custName}`);
        }
        if (ctx.nextStop) {
          const link = trackingLink(ctx, ctx.nextStop, s);
          await sms(ctx.nextStop, onWayText(s, ctx.nextStop, truck, link));
          await smsCoordinator(ctx.nextStop, coordinatorOnWayText(s, ctx.nextStop, truck, link));
          await slack(`🚚 ${truck} heading to ${ctx.nextStop.custName}${ctx.nextStop.dayOfName ? ` (day-of: ${ctx.nextStop.dayOfName})` : ""}`);
        }
        break;
      }
      case "COMPLETE_AND_RETURN": {
        if (cur) expireTracking(cur.stopId);
        await slack(`✅ ${truck} completed final stop${cur ? ` (${cur.custName})` : ""} — heading back to the warehouse`);
        break;
      }
      case "ARRIVED_WAREHOUSE": {
        const closeout = ctx.payload?.closeout as CloseoutResult | undefined;
        const photoIds = (ctx.payload?.photoIds as string[] | undefined) ?? [];
        if (!closeout) {
          // Legacy tap with no closeout payload — keep the plain completion message.
          await slack(`🏁 ${truck} back at the warehouse — route complete`);
          break;
        }
        // Accountability record for the office (driver, truck, route, timestamp, answers).
        insertAudit({
          actor: ctx.driverId || ctx.truckId,
          action: "ROUTE_CLOSEOUT",
          entity: "route",
          entityId: ctx.routeId ?? "",
          after: { ...closeout, photoIds },
        });
        const missing = CLOSEOUT_LABELS.filter(([k]) => !closeout[k]).map(([, label]) => label);
        const flagged = missing.length > 0 || closeout.hasIssue;
        if (!flagged) {
          await slack(`🏁 ${truck} back at the warehouse — route complete. Closeout clean ✓`);
          break;
        }
        // Something couldn't be confirmed, or the driver reported an issue → flag the office.
        const lines = [`⚠️ ${truck} route closeout needs attention`];
        if (missing.length) {
          lines.push(`• Not confirmed: ${missing.join(", ")}`);
          if (closeout.overrideReason) lines.push(`• Reason: ${closeout.overrideReason}`);
        }
        if (closeout.hasIssue) {
          lines.push(`• Issue reported: ${closeout.issueNote || "(no note)"}`);
          if (photoIds.length) lines.push(`• Photo${photoIds.length > 1 ? "s" : ""} attached (${photoIds.length})`);
        }
        await slack(lines.join("\n"));
        break;
      }
      case "REPORT_EXCEPTION": {
        const type = String(ctx.payload?.type ?? "Other");
        const reason = String(ctx.payload?.reason ?? "");
        insertException({
          stopId: cur?.stopId,
          type,
          reason,
          driverId: ctx.driverId,
          truckId: ctx.truckId,
          gps: ctx.gps,
        });
        insertAudit({
          actor: ctx.driverId || ctx.truckId,
          action: "REPORT_EXCEPTION",
          entity: "stop",
          entityId: cur?.stopId ?? "",
          after: { type, reason },
        });
        await slack(`⚠️ ${truck} exception${cur ? ` at ${cur.custName}` : ""}: ${type} — ${reason}`);
        break;
      }
      case "RESOLVE_CONTINUE":
        await slack(`${truck} exception resolved — continuing`);
        break;
      case "RETURN_ITEM":
        await slack(`↩️ ${truck} returning item to the warehouse`);
        break;
      case "NOTIFY_DISPATCH":
        await slack(`💬 ${truck}: ${String(ctx.payload?.message ?? "")}`);
        break;
      case "GAS_LOG":
        await slack(`⛽ ${truck} fuel ${ctx.payload?.putGas ? "logged" : "not needed"}`);
        break;
      default:
        break;
    }
  } catch (err) {
    console.error("[fanout] error:", err);
    void alertOps(`fan-out (${ctx.action})`, `${truck}: ${String(err)}`);
  }
}
