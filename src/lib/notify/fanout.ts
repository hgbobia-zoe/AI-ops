// Action fan-out — the code replacement for the Zapier Zaps. Given a driver action
// and the affected stop(s), it sends the customer SMS, posts Slack alerts, creates
// tracking links, and records everything to the DB. Called fire-and-forget from the
// action intake so the tablet never waits. Every send is key-gated and never throws.

import type { ActionType, Stop, Vehicle } from "@/lib/types";
import { sendSms } from "./sms";
import { slackNotify } from "./slack";
import { alertOps } from "./alert";
import { createTracking, expireTracking, insertMessage, insertException, insertAudit } from "@/lib/db/repo";

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

// Customer-facing tracking link: prefer the truck's Zonar "ETA Link" (live location
// + ETA, configured per truck via IGNITION_ETALINK_JSON); else our self-hosted link.
function etaLink(truckId: string): string | undefined {
  try {
    const map = JSON.parse(process.env.IGNITION_ETALINK_JSON || "{}") as Record<string, string>;
    return map[truckId] || undefined;
  } catch {
    return undefined;
  }
}

// Customer "on the way" text — matches the Zoe Events Quo template.
function onWayText(stop: Stop, link?: string): string {
  const tail = link ? `\n\nYou can check the latest location here: ${link}` : "";
  return (
    `Hi ${firstName(stop.custName)},\n\n` +
    `This is just a quick update regarding your delivery. Our team is en route and will be arriving at your location within the next hour. Please ensure someone is available to receive your rentals.` +
    `${tail}\n\nThank you!`
  );
}

function arrivedText(stop: Stop): string {
  return `Hi ${firstName(stop.custName)}, your Zoe Events delivery team has arrived. We'll begin unloading shortly. Thank you!`;
}

// Day-of coordinator variants — same info, addressed to the coordinator.
function coordinatorOnWayText(stop: Stop, link?: string): string {
  const tail = link ? `\n\nLatest location: ${link}` : "";
  return (
    `Hi ${firstName(stop.dayOfName)},\n\n` +
    `Zoe Events here — our delivery team is en route to ${stop.custName || "your event"} and will arrive within the next hour. You're listed as the day-of coordinator.${tail}\n\nThank you!`
  );
}

function coordinatorArrivedText(stop: Stop): string {
  return `Hi ${firstName(stop.dayOfName)}, Zoe Events has arrived at ${stop.custName || "your event"}. We'll begin unloading shortly.`;
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
          etaLink(ctx.truckId) ||
          createTracking(cur.stopId, cur.routeId, ctx.baseUrl).url;
        await sms(cur, onWayText(cur, link));
        await smsCoordinator(cur, coordinatorOnWayText(cur, link));
        await slack(`🚚 ${truck} departed → ${cur.custName}${cur.dayOfName ? ` (day-of: ${cur.dayOfName})` : ""}`);
        break;
      }
      case "ARRIVED": {
        if (!cur) break;
        await sms(cur, arrivedText(cur));
        await smsCoordinator(cur, coordinatorArrivedText(cur));
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
            etaLink(ctx.truckId) ||
            createTracking(ctx.nextStop.stopId, ctx.nextStop.routeId, ctx.baseUrl).url;
          await sms(ctx.nextStop, onWayText(ctx.nextStop, link));
          await smsCoordinator(ctx.nextStop, coordinatorOnWayText(ctx.nextStop, link));
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
