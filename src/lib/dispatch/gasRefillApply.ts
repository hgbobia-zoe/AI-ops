// Server side of the gas tank refill (rules in gasRefill.ts): runs on every route import, between the stop
// reconcile and the write, so the refill stop is re-placed on each pull (the per-stop upsert deletes any stop
// not in the write) and never duplicated. When the truck can't make it before closing, it queues the office
// a next-day task on the Goodshuffle project (the existing create_gs_task op, deduped per route) and posts it
// in the dispatch Slack channel once. Kill switch: GAS_REFILL=false.

import type { Stop } from "@/lib/types";
import { flagOn } from "@/lib/flags";
import { getSettings } from "@/lib/settings";
import { geocode, type LatLng } from "@/lib/eta/geo";
import { cachedDrive } from "@/lib/pricing/routeDistance";
import { enqueueGsOp, gsOpDedupeKeyExists, insertAudit } from "@/lib/db/repo";
import { slackNotify } from "@/lib/notify/slack";
import { formatClockTime, shiftYmd } from "@/lib/dates";
import {
  DEFAULT_GAS_REFILL,
  DEFAULT_REFILL_COORDS,
  gasTaskDedupeKey,
  isRefillStop,
  planGasRefill,
  triggerSummary,
  closeLabel,
  isEchoOfRefill,
  parseUsAddress,
  REFILL_ON_SITE_MIN,
  type GasRefillSettings,
  type GasTrigger,
} from "./gasRefill";

const DRIVE_LOOKUP_TIMEOUT_MS = 8000;

/** "Isuzu NPR 1" for "NPR-1" (VEHICLES_JSON, same source as the driver fanout), else the id. */
export function truckLabelFor(truckId: string): string {
  try {
    const list = JSON.parse(process.env.VEHICLES_JSON || "[]") as Array<{ truckId?: string; name?: string }>;
    return list.find((v) => v.truckId === truckId)?.name || truckId;
  } catch {
    return truckId;
  }
}

export interface GasRefillDeps {
  settings: () => GasRefillSettings;
  driveMinutes: (fromAddress: string, toAddress: string) => Promise<number | null>;
  taskExists: (dedupeKey: string) => boolean;
  /** Does an outbox op of this kind with this dedupe key exist? */
  taskExistsFor: (op: string, dedupeKey: string) => boolean;
  queueTask: (task: { transactionId: string; routeId: string; title: string; note: string; dueDate: string; dedupeKey: string }) => void;
  /** Queue the Goodshuffle route write (extension "refill_stop" op). Deduped by key: false = already queued. */
  queueGsStop: (op: { routeId: string; gsRouteId: string; dedupeKey: string; payload: Record<string, unknown> }) => boolean;
  notify: (text: string) => Promise<void>;
  audit: (action: string, routeId: string, after: Record<string, unknown>) => void;
}

async function refillCoords(address: string): Promise<LatLng | null> {
  return address.trim() === DEFAULT_GAS_REFILL.address ? DEFAULT_REFILL_COORDS : geocode(address);
}

async function driveMinutes(fromAddress: string, toAddress: string): Promise<number | null> {
  const lookup = (async () => {
    const [a, b] = await Promise.all([geocode(fromAddress), refillCoords(toAddress)]);
    if (!a || !b) return null;
    const d = await cachedDrive(a, b);
    return d ? d.minutes : null;
  })();
  const timeout = new Promise<null>((res) => setTimeout(() => res(null), DRIVE_LOOKUP_TIMEOUT_MS));
  try {
    return await Promise.race([lookup, timeout]);
  } catch {
    return null;
  }
}

export const defaultGasRefillDeps: GasRefillDeps = {
  settings: () => getSettings().gasRefill ?? DEFAULT_GAS_REFILL,
  driveMinutes,
  taskExists: (key) => gsOpDedupeKeyExists("create_gs_task", key),
  taskExistsFor: (op, key) => gsOpDedupeKeyExists(op, key),
  queueTask: (t) =>
    enqueueGsOp({
      op: "create_gs_task",
      routeId: t.routeId,
      transactionId: t.transactionId,
      label: "refill the gas tanks",
      payload: { transactionID: t.transactionId, title: t.title, note: t.note, dueDate: t.dueDate, dedupeKey: t.dedupeKey },
    }),
  queueGsStop: (op) => {
    if (gsOpDedupeKeyExists("refill_stop", op.dedupeKey)) return false;
    enqueueGsOp({ op: "refill_stop", routeId: op.routeId, gsRouteId: op.gsRouteId, label: "gas refill stop", payload: { ...op.payload, dedupeKey: op.dedupeKey } });
    return true;
  },
  notify: async (text) => {
    await slackNotify(text);
  },
  audit: (action, routeId, after) => {
    try {
      insertAudit({ actor: "gas-refill", action, entity: "route", entityId: routeId, after });
    } catch {
      /* audit never blocks a save */
    }
  },
};

/** The office's next-day task when the truck can't reach the refill place before closing. */
export async function queueNextDayRefill(
  input: { routeId: string; date: string; truckLabel: string; triggers: GasTrigger[]; arrivalMs: number; closeTime: string },
  deps: GasRefillDeps,
): Promise<"queued" | "exists" | "no_project"> {
  const key = gasTaskDedupeKey(input.routeId);
  if (deps.taskExists(key)) return "exists";
  const txId = input.triggers.find((t) => t.txId)?.txId;
  const summary = triggerSummary(input.triggers);
  const eta = formatClockTime(new Date(input.arrivalMs).toISOString());
  const due = shiftYmd(input.date, 1);
  const from = input.triggers.map((t) => t.custName).join(", ");
  if (!txId) {
    deps.audit("GAS_REFILL_TASK_NO_PROJECT", input.routeId, { summary });
    await deps.notify(`${input.truckLabel} route ${input.date} picks up gas tanks (${summary}) but gets to the refill place after closing (about ${eta}). No Goodshuffle project to put the task on, so refill them tomorrow by hand.`);
    return "no_project";
  }
  deps.queueTask({
    transactionId: txId,
    routeId: input.routeId,
    title: `Refill the gas tanks from the ${input.truckLabel} route on ${input.date}`,
    note: `${summary}, picked up from ${from}. The truck reaches the refill place about ${eta}, after it closes, so the tanks come back empty.`,
    dueDate: due,
    dedupeKey: key,
  });
  deps.audit("GAS_REFILL_TASK_QUEUED", input.routeId, { summary, due, eta });
  await deps.notify(`Refill tomorrow: ${input.truckLabel} route ${input.date} brings back gas tanks (${summary}) from ${from}. It reaches the refill place about ${eta}, after it closes at ${closeLabel(input.closeTime)}. A Goodshuffle task is set for ${due}.`);
  return "queued";
}

/** Place (or drop) the refill stop on freshly reconciled stops; queue the next-day task when it's too late. */
export async function applyGasRefill(
  input: { routeId: string; date: string; truckId: string; stops: Stop[]; gsRouteId?: string; previous?: Stop[] },
  deps: GasRefillDeps = defaultGasRefillDeps,
): Promise<Stop[]> {
  if (!flagOn("GAS_REFILL")) return input.stops;
  const settings = deps.settings();
  // A puller that doesn't skip our Goodshuffle refill waypoint brings it back as a blank stop: drop it.
  const prevAt = input.previous?.find(isRefillStop)?.plannedWindow;
  input = { ...input, stops: input.stops.filter((s) => !isEchoOfRefill(s, prevAt)) };
  const customer = input.stops.filter((s) => !isRefillStop(s)).sort((a, b) => a.sequence - b.sequence);
  const last = customer[customer.length - 1];
  const hasGas = planGasRefill({ routeId: input.routeId, date: input.date, stops: input.stops, settings, driveMin: 0 }).triggers.length > 0;
  const driveMin = hasGas && last?.address ? await deps.driveMinutes(last.address, settings.address) : null;
  const { stops, plan, triggers } = planGasRefill({ routeId: input.routeId, date: input.date, stops: input.stops, settings, driveMin });
  if (input.gsRouteId) syncGsRefillStop({ routeId: input.routeId, gsRouteId: input.gsRouteId, stops, plan, address: settings.address }, deps);
  if (plan.kind === "task") {
    await queueNextDayRefill({ routeId: input.routeId, date: input.date, truckLabel: truckLabelFor(input.truckId), triggers, arrivalMs: plan.arrivalMs, closeTime: settings.closeTime }, deps);
  }
  return stops;
}

/** Mirror the refill stop onto the Goodshuffle route (owner: "Dispatch and Goodshuffle"). Added once per route
 *  when Dispatch places it; removed once if Dispatch later drops it. Kill switch: GAS_REFILL_GS=false. */
export function syncGsRefillStop(
  input: { routeId: string; gsRouteId: string; stops: Stop[]; plan: ReturnType<typeof planGasRefill>["plan"]; address: string },
  deps: GasRefillDeps,
): "added" | "removed" | "none" {
  if (!flagOn("GAS_REFILL_GS")) return "none";
  const addKey = `gas-refill-gs:${input.routeId}:add`;
  const gas = input.stops.find(isRefillStop);
  if (input.plan.kind === "stop" && gas && !input.plan.kept) {
    const addr = parseUsAddress(input.address);
    if (!addr || !gas.plannedWindow) {
      deps.audit("GAS_REFILL_GS_SKIPPED", input.routeId, { reason: !addr ? "address not street, city, ST zip" : "no arrival time" });
      return "none";
    }
    const arrival = new Date(gas.plannedWindow);
    const departure = new Date(arrival.getTime() + REFILL_ON_SITE_MIN * 60_000);
    const queued = deps.queueGsStop({
      routeId: input.routeId,
      gsRouteId: input.gsRouteId,
      dedupeKey: addKey,
      payload: { action: "add", name: gas.custName, address: addr, arrivalTime: arrival.toISOString(), departureTime: departure.toISOString() },
    });
    return queued ? "added" : "none";
  }
  if (input.plan.kind !== "stop" && deps.taskExistsFor("refill_stop", addKey)) {
    return deps.queueGsStop({ routeId: input.routeId, gsRouteId: input.gsRouteId, dedupeKey: `gas-refill-gs:${input.routeId}:remove`, payload: { action: "remove" } }) ? "removed" : "none";
  }
  return "none";
}
