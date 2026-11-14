// Morning outreach, LIVE. Owner go ahead 2026-11-04 after validating the dry run (morningOutreach.ts).
//
// Each Monday to Saturday, on the 15 min runtime clock:
//   1. From 8:15 AM ET it PLANS every open quote with the same gate, cadence and drafter as the dry run.
//      Rows 3 days or less from an unsigned event queue a Goodshuffle "mark lost + archive" (markLost.ts).
//   2. Each due text goes out at its own random second between 9:12 and 9:17 AM (an in process timer; the
//      next tick catches up after a restart, until 11 AM, then the row is "missed" rather than late).
//      It is sent through the sanctioned Sales OS sender (smsSend.ts: SMS_SEND_ENABLED, dedupe, timeline,
//      audit) as the sales lead's Quo user, and writes a "Sales Bot texted ..." Goodshuffle note.
//   3. Once every row is settled it posts the recap to the Sales Bot channel.
// Safeguards: once per lead per day, a fresh recheck right before sending (a client who wrote back since
// the plan is skipped, as is a project signed since), a daily cap, and MORNING_OUTREACH_LIVE=false as the
// kill switch (SMS_SEND_ENABLED=false also stops the texts).

import { flagOn } from "@/lib/flags";
import { getJson, setJson } from "@/lib/kv";
import { todayInOpsTz, DISPLAY_TZ } from "@/lib/dates";
import { getBookingById } from "@/lib/db/repo";
import { ensureLeadThreadSynced } from "@/lib/comms/openphoneSync";
import { getOpenphoneUsers } from "@/lib/comms/openphone";
import { botAnnounce, appUrl, type BotCard } from "@/lib/notify/aiBots";
import { buildMorningPlan, isSendDay, clockLabel, spreadSendTimes, inAvoidMinute, type MorningPlanRow } from "./morningOutreach";
import { buildLeadTimeline } from "./timeline";
import { sendLeadSms } from "./smsSend";
import { queueMarkLost } from "./markLost";
import { outreachBlock } from "./outreachEligibility";

export const PLAN_FROM_MIN = 8 * 60 + 15; // 8:15 AM ET
export const SEND_UNTIL_MIN = 11 * 60; //    catch up a missed send until 11 AM ET, never later
export const DEFAULT_DAILY_MAX = 25;
const PLAN_LIMIT = 500;
const SALES_BOT = "Sales Bot";

export type LiveStatus = "pending" | "sending" | "sent" | "failed" | "skipped" | "missed" | "held" | "lost_queued" | "lost_skipped";

export interface LiveRow {
  leadId: string;
  eventName: string;
  clientName: string;
  value: number | null;
  whereWeAre: string[];
  signedAs: string | null;
  reason: string | null;
  draft: string | null;
  sendAt: string | null;
  status: LiveStatus;
  detail?: string | null;
  doneAt?: string | null;
  /** Structured hold, for the recap tables. */
  holdKind?: MorningPlanRow["holdKind"];
  daysToEvent?: number | null;
  nextOn?: string | null;
  last?: string | null;
  said?: string | null;
}

export interface LiveDay {
  ymd: string;
  status: "planning" | "ready" | "error";
  startedAt: string;
  plannedAt?: string;
  rows: LiveRow[];
  recapPosted?: boolean;
  error?: string;
}

export const liveKey = (ymd: string): string => `salesos.morningOutreach.live.${ymd}`;
export const morningLiveEnabled = (): boolean => flagOn("MORNING_OUTREACH_LIVE");

export function dailyMax(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.MORNING_OUTREACH_MAX);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_DAILY_MAX;
}

/** Minutes after midnight Eastern. */
export function etMinutes(now: Date): number {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: DISPLAY_TZ, hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(now);
  return Number(p.find((x) => x.type === "hour")?.value ?? 0) * 60 + Number(p.find((x) => x.type === "minute")?.value ?? 0);
}

/** Turn the plan into today's live rows: texts up to the daily cap (earliest send time first), the rest
 *  held; lose rows wait for the mark lost queue; everything else is a hold with the gate's reason. Pure. */
export function rowsFromPlan(rows: MorningPlanRow[], max: number, rng: () => number = Math.random): LiveRow[] {
  const sendable = rows.filter((r) => r.send && r.draft && r.sendAt).sort((a, b) => a.sendAt!.localeCompare(b.sendAt!));
  const kept = sendable.slice(0, max);
  const within = new Set(kept.map((r) => r.leadId));
  // Re-spread the texts that will really go out over the whole window (the cap could leave them bunched
  // early). Never 9:15, random seconds, each in its own slice.
  const day = kept[0]?.sendAt ? todayInOpsTz(new Date(kept[0].sendAt)) : null;
  const times = day ? spreadSendTimes(day, kept.length, rng) : [];
  const respread = new Map(kept.map((r, k) => [r.leadId, times[k] ?? r.sendAt!]));
  return rows.map((r) => {
    const base = {
      leadId: r.leadId, eventName: r.eventName, clientName: r.clientName, value: r.value, whereWeAre: r.whereWeAre, signedAs: r.signedAs, reason: r.reason,
      draft: null as string | null, sendAt: null as string | null,
      holdKind: r.holdKind ?? null, daysToEvent: r.daysToEvent ?? null, nextOn: r.nextOn ?? null, last: r.last ?? null, said: r.said ?? null,
    };
    if (r.send && r.draft && r.sendAt) {
      return within.has(r.leadId)
        ? { ...base, draft: r.draft, sendAt: respread.get(r.leadId) ?? r.sendAt, status: "pending" as const }
        : { ...base, draft: r.draft, status: "held" as const, reason: `Daily cap of ${max} texts reached, next morning instead.` };
    }
    if (r.lose) return { ...base, status: "lost_skipped" as const }; // becomes lost_queued once queued
    return { ...base, status: "held" as const };
  });
}

const load = (ymd: string): LiveDay | null => getJson<LiveDay | null>(liveKey(ymd), null);
const save = (d: LiveDay): void => setJson(liveKey(d.ymd), d);

function patchRow(ymd: string, leadId: string, patch: Partial<LiveRow>): LiveDay | null {
  const d = load(ymd);
  if (!d) return null;
  d.rows = d.rows.map((r) => (r.leadId === leadId ? { ...r, ...patch } : r));
  save(d);
  return d;
}

// ── Planning ─────────────────────────────────────────────────────────────────────────────────────────

let planning: Promise<void> | null = null;
/** For tests: wait for a planning run started by the tick. */
export const awaitPlanning = (): Promise<void> => planning ?? Promise.resolve();

function startPlanning(ymd: string, now: Date): void {
  if (planning) return;
  save({ ymd, status: "planning", startedAt: new Date().toISOString(), rows: [] });
  planning = (async () => {
    try {
      const rep = process.env.MORNING_OUTREACH_REP_NAME?.trim() || "Jessie"; // Jessie is the only salesperson now
      const plan = await buildMorningPlan({ limit: PLAN_LIMIT, now, repFirstName: rep });
      const rows = rowsFromPlan(plan.rows, dailyMax());
      for (const r of rows) {
        const p = plan.rows.find((x) => x.leadId === r.leadId);
        if (!p?.lose) continue;
        const q = queueMarkLost(r.leadId, p.reason ?? "3 days or less to the event with the quote unsigned.");
        r.status = q.queued ? "lost_queued" : "lost_skipped";
        r.detail = q.queued ? null : q.reason.replace(/_/g, " ");
      }
      save({ ymd, status: "ready", startedAt: load(ymd)?.startedAt ?? new Date().toISOString(), plannedAt: new Date().toISOString(), rows });
      scheduleTimers(ymd);
    } catch (e) {
      save({ ymd, status: "error", startedAt: new Date().toISOString(), rows: [], error: e instanceof Error ? e.message : String(e) });
    } finally {
      planning = null;
    }
  })();
}

// ── Sending ──────────────────────────────────────────────────────────────────────────────────────────

const g = globalThis as unknown as { __morningTimers?: Map<string, ReturnType<typeof setTimeout>> };
const timers = (g.__morningTimers ??= new Map());

function scheduleTimers(ymd: string): void {
  const d = load(ymd);
  if (!d) return;
  for (const r of d.rows) {
    const key = `${ymd}:${r.leadId}`;
    if (r.status !== "pending" || !r.sendAt || timers.has(key)) continue;
    const delay = Math.max(0, Date.parse(r.sendAt) - Date.now());
    const t = setTimeout(() => void sendRow(ymd, r.leadId).finally(() => timers.delete(key)), delay);
    (t as { unref?: () => void }).unref?.();
    timers.set(key, t);
  }
}

async function quoUserIdFor(firstName: string | null): Promise<string | undefined> {
  const want = (firstName ?? "").trim().toLowerCase();
  if (!want) return undefined;
  const users = await getOpenphoneUsers().catch(() => []);
  return users.find((u) => u.name.trim().toLowerCase().split(/\s+/)[0] === want)?.id;
}

/** Send one planned text, once. Rechecks the lead right before sending. */
export async function sendRow(ymd: string, leadId: string): Promise<LiveStatus> {
  const d = load(ymd);
  const row = d?.rows.find((r) => r.leadId === leadId);
  if (!d || !row || row.status !== "pending" || !row.draft) return row?.status ?? "skipped";
  patchRow(ymd, leadId, { status: "sending" }); // claim: a timer and a catch up tick never both send
  // Never in the 9:15 minute (owner): a catch up or a late timer waits until 9:16 plus a few random seconds.
  if (inAvoidMinute(new Date())) await holdPastAvoidMinute();
  const finish = (status: LiveStatus, detail: string | null = null): LiveStatus => {
    patchRow(ymd, leadId, { status, detail, doneAt: new Date().toISOString() });
    return status;
  };
  try {
    const b = getBookingById(leadId);
    if (!b) return finish("skipped", "The project is gone from Goodshuffle.");
    if (b.signed) return finish("skipped", "The contract was signed since the plan.");
    // The hard gate again, on the project as stored right now: archived, lost, no event date or a past event
    // never gets a text, whatever the plan said.
    const block = outreachBlock(b, todayInOpsTz());
    if (block) return finish("skipped", block.reason);
    await ensureLeadThreadSynced(leadId, b.clientPhone);
    const since = Date.parse(d.plannedAt ?? d.startedAt);
    const replied = buildLeadTimeline(leadId).some((e) => e.direction === "in" && (e.channel === "sms" || e.channel === "email" || e.channel === "call") && e.at && Date.parse(e.at) > since);
    if (replied) return finish("skipped", "The client reached out since the plan. A person should answer.");
    const res = await sendLeadSms({ id: leadId, body: row.draft, userId: await quoUserIdFor(row.signedAs), initials: SALES_BOT });
    if (res.ok && !res.duplicate) return finish("sent");
    if (res.duplicate) return finish("skipped", "The same text already went out a moment ago.");
    return finish("failed", res.error ?? "send failed");
  } catch (e) {
    return finish("failed", e instanceof Error ? e.message : String(e));
  }
}

// ── Recap ────────────────────────────────────────────────────────────────────────────────────────────

const money = (v: number | null): string => (v != null ? ` · $${Math.round(v).toLocaleString("en-US")}` : "");

const fit = (s: string | null | undefined, n: number): string => {
  const x = (s ?? "").replace(/\s+/g, " ").trim();
  return x.length > n ? `${x.slice(0, n - 1)}…` : x.padEnd(n);
};
const eventIn = (d: number | null | undefined): string => (d == null ? "no date" : d < 0 ? "passed" : d === 0 ? "today" : `${d}d`);
const FENCE = "```";

/** A monospace table (code block), split so every block stays under Slack's 3000 character section limit. */
export function tableBlocks(head: string, lines: string[], max = 2800): string[] {
  const wrap = (rows: string[]) => `${FENCE}\n${[head, ...rows].join("\n")}\n${FENCE}`;
  const out: string[] = [];
  let cur: string[] = [];
  for (const l of lines) {
    if (cur.length && wrap([...cur, l]).length > max) {
      out.push(wrap(cur));
      cur = [];
    }
    cur.push(l);
  }
  if (cur.length) out.push(wrap(cur));
  return out;
}

const NEEDS_PERSON = new Set(["waiting", "board_flag", "lose_waiting"]);

function personWhy(r: LiveRow): string {
  if (r.holdKind === "board_flag") return "Sales board: Action Needed";
  const when = r.holdKind === "lose_waiting" ? `event ${eventIn(r.daysToEvent)}, ` : "";
  return `${when}wrote last${r.said ? `: "${r.said}"` : ""}`;
}

function otherWhy(r: LiveRow): string {
  if (r.status === "failed") return `Send failed: ${r.detail ?? ""}`;
  if (r.status === "skipped") return `Skipped: ${r.detail ?? ""}`;
  if (r.status === "missed") return "Missed the send window";
  if (r.status === "lost_skipped" && r.detail) return `Not marked lost: ${r.detail}`;
  if (r.holdKind === "no_phone") return "No phone number";
  if (r.holdKind === "opt_out") return `Asked us to stop${r.said ? `: "${r.said}"` : ""}`;
  if (r.holdKind === "client_done") return `Said no${r.said ? `: "${r.said}"` : ""}`;
  return r.reason ?? "Held";
}

export function liveRecapCards(d: LiveDay): BotCard[] {
  const sent = d.rows.filter((r) => r.status === "sent");
  const lost = d.rows.filter((r) => r.status === "lost_queued");
  const rest = d.rows.filter((r) => !["sent", "lost_queued", "pending", "sending"].includes(r.status));
  const person = rest.filter((r) => r.status === "held" && NEEDS_PERSON.has(r.holdKind ?? ""));
  const notDue = rest.filter((r) => r.status === "held" && (r.holdKind === "cadence" || !!r.reason?.startsWith("Daily cap")));
  const other = rest.filter((r) => !person.includes(r) && !notDue.includes(r));
  const day = new Date(`${d.ymd}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "long", month: "short", day: "numeric" });
  const cards: BotCard[] = [
    {
      emoji: "☀️",
      title: `Morning outreach: ${sent.length} texted, ${lost.length} marked lost`,
      subtitle: `${day} · ${d.rows.length} open quotes checked`,
      fields: [
        { label: "Texted", value: String(sent.length) },
        { label: "Marked lost", value: String(lost.length) },
        { label: "Needs a person", value: String(person.length) },
        { label: "Not due yet", value: String(notDue.length) },
        ...(other.length ? [{ label: "Other", value: String(other.length) }] : []),
      ],
      context: "Sales Bot · live · MORNING_OUTREACH_LIVE=false stops it",
    },
  ];
  for (const r of sent) {
    cards.push({
      title: `${r.eventName} - ${r.clientName}`.slice(0, 140),
      subtitle: `Texted at ${r.doneAt ? clockLabel(r.doneAt) : "?"} as ${r.signedAs ?? "Zoe Events"}${money(r.value)}`,
      sections: [`*Based on context we were here:*\n${r.whereWeAre.map((l) => `• ${l}`).join("\n")}`, `*Sales Bot sent:*\n>${(r.draft ?? "").replace(/\n/g, "\n>")}`],
      link: { text: "Open in Sales OS", url: appUrl("/salesos") },
      context: "Sales Bot · note added to the Goodshuffle project",
    });
  }
  const usd = (v: number | null) => (v != null ? `$${Math.round(v).toLocaleString("en-US")}` : "");
  if (lost.length) {
    cards.push({
      emoji: "🗄️",
      title: `Marked lost and archived (${lost.length})`,
      subtitle: "3 days or less to the event and the quote is not signed. The office browser makes the change on its next pull.",
      sections: tableBlocks(`${fit("Client", 22)} ${fit("Event in", 8)} Value`, lost.map((r) => `${fit(r.clientName, 22)} ${fit(eventIn(r.daysToEvent), 8)} ${usd(r.value)}`)),
      context: "Sales Bot · live",
    });
  }
  if (person.length) {
    cards.push({
      emoji: "🙋",
      title: `Needs a person (${person.length})`,
      subtitle: "The client wrote last, or the Sales board flags it. Sales Bot does not text these.",
      sections: tableBlocks(`${fit("Client", 22)} ${fit("Event in", 8)} Why`, person.map((r) => `${fit(r.clientName, 22)} ${fit(eventIn(r.daysToEvent), 8)} ${fit(personWhy(r), 60).trimEnd()}`)),
      link: { text: "Open in Sales OS", url: appUrl("/salesos") },
      context: "Sales Bot · live",
    });
  }
  if (notDue.length) {
    const sorted = [...notDue].sort((a, b) => (a.daysToEvent ?? 9999) - (b.daysToEvent ?? 9999));
    cards.push({
      emoji: "🗓️",
      title: `Not due yet (${notDue.length})`,
      subtitle: "Followed up recently. The further out the event, the longer the gap: 3, 7, 14, 21 or 30 days.",
      sections: tableBlocks(
        `${fit("Client", 22)} ${fit("Event in", 8)} ${fit("Last touch", 14)} Next`,
        sorted.map((r) => `${fit(r.clientName, 22)} ${fit(eventIn(r.daysToEvent), 8)} ${fit(r.last ?? "", 14)} ${r.reason?.startsWith("Daily cap") ? "tomorrow (cap)" : r.nextOn ?? ""}`),
      ),
      context: "Sales Bot · live",
    });
  }
  if (other.length) {
    cards.push({
      title: `Other holds (${other.length})`,
      sections: tableBlocks(`${fit("Client", 22)} Why`, other.map((r) => `${fit(r.clientName, 22)} ${fit(otherWhy(r), 70).trimEnd()}`)),
      context: "Sales Bot · live",
    });
  }
  return cards;
}

async function postRecap(d: LiveDay): Promise<void> {
  // fallback:false: if the Sales Bot channel post fails, never spill the recap into the ops (delivery) channel
  for (const c of liveRecapCards(d)) await botAnnounce("sales", c, { fallback: false });
  const cur = load(d.ymd);
  if (cur) save({ ...cur, recapPosted: true });
}

// ── The tick ─────────────────────────────────────────────────────────────────────────────────────────

/** Runs on every runtime tick. Never throws. */
export async function runMorningOutreachTick(now: Date = new Date()): Promise<{ ok: boolean; detail: string }> {
  try {
    if (!morningLiveEnabled()) return { ok: true, detail: "MORNING_OUTREACH_LIVE off" };
    const ymd = todayInOpsTz(now);
    if (!isSendDay(ymd)) return { ok: true, detail: "Sunday, no outreach" };
    const m = etMinutes(now);
    let d = load(ymd);
    if (!d || (d.status === "planning" && !planning) || (d.status === "error" && m < SEND_UNTIL_MIN && !planning)) {
      if (m < PLAN_FROM_MIN) return { ok: true, detail: "waiting for 8:15 AM ET" };
      if (m >= SEND_UNTIL_MIN) return { ok: true, detail: d ? `no run today (${d.status})` : "no run today (too late to start)" };
      startPlanning(ymd, now);
      return { ok: true, detail: "planning today's outreach" };
    }
    if (d.status === "planning") return { ok: true, detail: "planning today's outreach" };
    if (d.status === "error") return { ok: false, detail: `planning failed: ${d.error ?? "unknown"}` };

    scheduleTimers(ymd);
    // Catch up after a restart: a text whose time has passed and whose timer is gone.
    for (const r of d.rows) {
      if (r.status !== "pending" || !r.sendAt || Date.parse(r.sendAt) > now.getTime() - 60_000) continue;
      if (m >= SEND_UNTIL_MIN) patchRow(ymd, r.leadId, { status: "missed", detail: "The server was down at send time.", doneAt: new Date().toISOString() });
      else if (!timers.has(`${ymd}:${r.leadId}`)) await sendRow(ymd, r.leadId);
    }
    d = load(ymd)!;
    const open = d.rows.filter((r) => r.status === "pending" || r.status === "sending").length;
    const count = (s: LiveStatus) => d!.rows.filter((r) => r.status === s).length;
    if (!open && !d.recapPosted) await postRecap(d);
    return { ok: count("failed") === 0, detail: `${count("sent")} texted, ${count("lost_queued")} marked lost, ${open} still to send, ${count("failed")} failed` };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

export function getMorningLiveDay(ymd: string = todayInOpsTz()): LiveDay | null {
  return load(ymd);
}

/** Wait out the 9:15 minute: until the next whole minute plus 5 to 40 random seconds. */
async function holdPastAvoidMinute(now: Date = new Date()): Promise<void> {
  const toNextMinute = 60_000 - (now.getTime() % 60_000);
  const extra = 5_000 + Math.floor(Math.random() * 35_000);
  await new Promise((r) => setTimeout(r, toNextMinute + extra));
}
