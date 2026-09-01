// Action fan-out — the code replacement for the Zapier Zaps. Given a driver action
// and the affected stop(s), it sends the customer SMS, posts Slack alerts, creates
// tracking links, and records everything to the DB. Called fire-and-forget from the
// action intake so the tablet never waits. Every send is key-gated and never throws.

import type { ActionType, Stop, Vehicle } from "@/lib/types";
import { sendSms } from "./sms";
import { slackNotify } from "./slack";
import { alertOps } from "./alert";
import { createTracking, expireTracking, insertMessage, insertException, insertAudit } from "@/lib/db/repo";
import { getSettings, renderTemplate, templateForKind, type AppSettings } from "@/lib/settings";
import { formatClockTime } from "@/lib/dates";

export interface FanoutCtx {
  action: ActionType;
  truckId: string;
  driverId?: string;
  gps?: unknown;
  payload?: Record<string, unknown>;
  baseUrl: string;
  currentStop: Stop | null;
  nextStop: Stop | null;
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
        // The kiosk generates a per-stop Zonar etaLink (in its hidden Ignition
        // webview) and passes it in the payload; else a static per-truck link;
        // else our own /track link.
        const link =
          (ctx.payload?.etaLink as string | undefined) ||
          s.ignitionEtaLinks[ctx.truckId] ||
          createTracking(cur.stopId, cur.routeId, ctx.baseUrl).url;
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
          const link =
            (ctx.payload?.etaLink as string | undefined) ||
            s.ignitionEtaLinks[ctx.truckId] ||
            createTracking(ctx.nextStop.stopId, ctx.nextStop.routeId, ctx.baseUrl).url;
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
      case "ARRIVED_WAREHOUSE":
        await slack(`🏁 ${truck} back at the warehouse — route complete`);
        break;
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
