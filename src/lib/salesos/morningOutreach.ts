// Morning outreach: one automated follow-up text per open quote, sent at a random time between 9:12 and
// 9:17 AM Eastern so it reads like a person, not a scheduler (the Quo hours analysis showed weekday
// mornings before 10 connect best).
//
// Before planning a text it gathers the full context for the lead:
//   • Quo texts, refreshed live from the Quo API into the timeline (ensureLeadThreadSynced)
//   • Quo calls, read live from the Quo API (the stored call feed can lag)
//   • Goodshuffle client emails, quote milestones, the sales audit trail and the Goodshuffle notes
//     (all merged by buildLeadTimeline, the same source the lead drawer and the drafter read)
// A deterministic gate then decides whether a text is appropriate at all (no phone, event passed or too
// close, client waiting on a person, reached out recently, asked to stop, too many unanswered follow ups).
// Only leads that pass get an LLM draft, from the same context aware drafter the Sales panel uses.
//
// This file is the DRY RUN: it plans and posts a recap to the Sales Bot channel. It sends nothing and
// writes nothing to Goodshuffle or Quo. The live daily send is a follow up once the dry run is validated.

import type { LeadCard } from "./boardTypes";
import { getLead } from "./service";
import { buildLeadTimeline, type TimelineEntry } from "./timeline";
import { draftLeadOutreach } from "./outreachService";
import { humanize } from "./outreach";
import { STAGE_LABEL } from "./calc";
import { openQuoteCards, SUBSTATUS_LABEL, type OpenQuoteSubStatus } from "./bulkOutreach";
import { ensureLeadThreadSynced } from "@/lib/comms/openphoneSync";
import { getOpenphonePhoneNumbers, listOpenphoneCalls, openphoneApiKey, type QuoNumber } from "@/lib/comms/openphone";
import { botAnnounce, appUrl, type BotCard } from "@/lib/notify/aiBots";
import { todayInOpsTz, shiftYmd, opsLocalInputToIso, DISPLAY_TZ } from "@/lib/dates";
import { getJson, setJson } from "@/lib/kv";

// ── Send time ────────────────────────────────────────────────────────────────────────────────────────

/** Send window in minutes after midnight Eastern: 9:12:00 through 9:17:59. */
export const SEND_WINDOW = { fromMin: 9 * 60 + 12, toMin: 9 * 60 + 17 };

/** Send days: Monday through Saturday (owner call). Never Sunday. */
export function isSendDay(ymd: string): boolean {
  return new Date(`${ymd}T12:00:00Z`).getUTCDay() !== 0;
}

/** The morning the next send would happen: today if it is a send day and the window has not opened yet,
 *  else the next send day. */
export function nextSendDay(now: Date = new Date()): string {
  const today = todayInOpsTz(now);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: DISPLAY_TZ, hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(now);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  let day = isSendDay(today) && h * 60 + m < SEND_WINDOW.fromMin ? today : shiftYmd(today, 1);
  while (!isSendDay(day)) day = shiftYmd(day, 1);
  return day;
}

/** A random instant inside the send window on `day` (Eastern), to the second. `rng` is injectable for tests. */
export function randomSendTime(day: string, rng: () => number = Math.random): string {
  const span = (SEND_WINDOW.toMin - SEND_WINDOW.fromMin + 1) * 60; // seconds in the window
  const s = Math.min(span - 1, Math.floor(rng() * span));
  const total = SEND_WINDOW.fromMin * 60 + s;
  const hh = String(Math.floor(total / 3600)).padStart(2, "0");
  const mm = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const base = opsLocalInputToIso(`${day}T${hh}:${mm}`);
  return new Date(Date.parse(base ?? `${day}T14:00:00Z`) + (total % 60) * 1000).toISOString();
}

/** "9:14:37 AM" in Eastern. */
export function clockLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", { timeZone: DISPLAY_TZ, hour: "numeric", minute: "2-digit", second: "2-digit" });
}

// ── Context gate (pure) ──────────────────────────────────────────────────────────────────────────────

export interface LiveCall {
  direction: "in" | "out";
  at: string;
  secs: number | null;
}

export interface GateInput {
  hasPhone: boolean;
  daysToEvent: number | null;
  subStatus: OpenQuoteSubStatus;
  timeline: TimelineEntry[]; // newest first (buildLeadTimeline order)
  liveCalls: LiveCall[];
  now: number;
}

export interface GateResult {
  send: boolean;
  reason: string | null;
}

/** Recently reached out: no automated text within this many hours of our last outbound touch. */
export const RECENT_OUTBOUND_HOURS = 48;
/** Unanswered follow ups in a row (since the client last said anything) before we stop chasing. */
export const MAX_UNANSWERED = 5;
/** Events this close (or closer) belong to a person, not an automated nudge. */
export const MIN_DAYS_TO_EVENT = 3;

// A bare "STOP" reply, or an explicit opt out phrase ("stop by Friday" is not an opt out).
const STOP_RE = /^\s*(stop|unsubscribe|end|quit)\W*$|\b(unsubscribe|stop texting|do not (text|contact) (me|us)|don'?t (text|contact) (me|us)|remove me)\b/i;
const DONE_RE =
  /\b(went with (another|someone|a different)|booked (with )?(another|someone else|a different)|found (another|someone)|no longer (need|interested)|not interested|we('| a)re (all set|good)|cancel(l)?ing|cancelled the event|decided not to)\b/i;

const TOUCH: ReadonlySet<TimelineEntry["channel"]> = new Set(["sms", "call", "email", "quote"]);
const t = (iso: string | null | undefined): number => (iso ? Date.parse(iso.length > 10 ? iso : `${iso}T00:00:00Z`) : NaN);

/** Merge the stored timeline touches with the live Quo calls into one newest-first list of dated touches. */
export function touches(timeline: TimelineEntry[], liveCalls: LiveCall[]): { at: number; dir: "in" | "out"; channel: string; detail: string | null }[] {
  const out = timeline
    // a quote OPEN is "in" on the timeline but it is not the client talking to us
    .filter((e) => e.at && e.direction && TOUCH.has(e.channel) && !(e.channel === "quote" && e.direction === "in"))
    .map((e) => ({ at: t(e.at), dir: e.direction as "in" | "out", channel: e.channel, detail: e.detail ?? null }));
  for (const c of liveCalls) {
    const at = t(c.at);
    // the stored call feed and the live read can hold the same call; same direction within a minute = same
    if (!out.some((x) => x.channel === "call" && x.dir === c.direction && Math.abs(x.at - at) < 60_000)) {
      out.push({ at, dir: c.direction, channel: "call", detail: c.secs != null ? `${c.secs}s` : null });
    }
  }
  return out.filter((x) => Number.isFinite(x.at)).sort((a, b) => b.at - a.at);
}

export function gateLead(g: GateInput): GateResult {
  if (!g.hasPhone) return { send: false, reason: "No phone number on file." };
  if (g.daysToEvent != null && g.daysToEvent < 0) return { send: false, reason: "The event date has passed." };
  if (g.daysToEvent != null && g.daysToEvent < MIN_DAYS_TO_EVENT) {
    return { send: false, reason: `The event is ${g.daysToEvent === 0 ? "today" : `in ${g.daysToEvent} day${g.daysToEvent === 1 ? "" : "s"}`}, a person should handle this one.` };
  }
  const inboundTexts = g.timeline.filter((e) => e.direction === "in" && (e.channel === "sms" || e.channel === "email") && e.detail);
  const stop = inboundTexts.find((e) => STOP_RE.test(e.detail ?? ""));
  if (stop) return { send: false, reason: `The client asked us to stop: "${clip(stop.detail, 90)}".` };
  const done = inboundTexts.find((e) => DONE_RE.test(e.detail ?? ""));
  if (done) return { send: false, reason: `The client said: "${clip(done.detail, 110)}".` };

  const list = touches(g.timeline, g.liveCalls);
  const latest = list[0];
  if (g.subStatus === "action_needed" || latest?.dir === "in") {
    const said = list.find((x) => x.dir === "in" && x.detail && x.channel !== "call");
    return { send: false, reason: `The client is waiting on us${said ? ` (their last message: "${clip(said.detail, 90)}")` : ""}. A person should answer.` };
  }
  const lastOut = list.find((x) => x.dir === "out");
  if (lastOut && g.now - lastOut.at < RECENT_OUTBOUND_HOURS * 3_600_000) {
    const h = Math.max(1, Math.round((g.now - lastOut.at) / 3_600_000));
    return { send: false, reason: `We already reached out ${h < 24 ? `${h}h` : `${Math.round(h / 24)}d`} ago (${lastOut.channel === "sms" ? "text" : lastOut.channel}).` };
  }
  const lastIn = list.findIndex((x) => x.dir === "in");
  const unanswered = (lastIn === -1 ? list : list.slice(0, lastIn)).filter((x) => x.dir === "out").length;
  if (unanswered >= MAX_UNANSWERED) {
    return { send: false, reason: `${unanswered} follow ups with no reply${lastIn === -1 ? "" : " since their last message"}. Pause instead of chasing.` };
  }
  return { send: true, reason: null };
}

function clip(s: string | null | undefined, n: number): string {
  const x = (s ?? "").replace(/\s+/g, " ").trim();
  return x.length > n ? `${x.slice(0, n - 1).trimEnd()}...` : x;
}

// ── Where we are (deterministic, facts only) ─────────────────────────────────────────────────────────

const shortDate = (ms: number): string => new Date(ms).toLocaleDateString("en-US", { timeZone: DISPLAY_TZ, month: "short", day: "numeric" });
const word = (channel: string): string => (channel === "sms" ? "text" : channel === "quote" ? "quote email" : channel);

export interface ContextCounts {
  quoTexts: number;
  quoCalls: number;
  liveCalls: number;
  emails: number;
  notes: number;
}

export function contextCounts(timeline: TimelineEntry[], liveCalls: LiveCall[]): ContextCounts {
  return {
    quoTexts: timeline.filter((e) => e.channel === "sms").length,
    quoCalls: timeline.filter((e) => e.channel === "call").length,
    liveCalls: liveCalls.length,
    emails: timeline.filter((e) => e.channel === "email").length,
    notes: timeline.filter((e) => e.channel === "note").length,
  };
}

export function whereWeAre(input: {
  value: number | null;
  quoteSentDate: string | null;
  eventDate: string | null;
  daysToEvent: number | null;
  timeline: TimelineEntry[];
  liveCalls: LiveCall[];
  now: number;
}): string[] {
  const lines: string[] = [];
  const money = input.value != null ? `$${Math.round(input.value).toLocaleString("en-US")}` : null;
  if (input.quoteSentDate) {
    const sent = t(input.quoteSentDate.slice(0, 10));
    const days = Math.max(0, Math.round((t(todayInOpsTz(new Date(input.now))) - sent) / 86_400_000)); // calendar days
    const opened = input.timeline.find((e) => e.channel === "quote" && e.direction === "in");
    lines.push(`Quote${money ? ` for ${money}` : ""} sent ${shortDate(sent + 12 * 3_600_000)} (${days} day${days === 1 ? "" : "s"} ago)${opened?.at ? `, opened ${shortDate(t(opened.at))}` : ", no open recorded"}.`);
  } else if (money) {
    lines.push(`Quote for ${money}.`);
  }
  if (input.eventDate) {
    lines.push(`Event ${shortDate(t(input.eventDate) + 12 * 3_600_000)}${input.daysToEvent != null ? ` (${input.daysToEvent} days out)` : ""}.`);
  }
  const list = touches(input.timeline, input.liveCalls);
  const lastIn = list.find((x) => x.dir === "in");
  if (lastIn) {
    lines.push(`Last from the client: ${word(lastIn.channel)} on ${shortDate(lastIn.at)}${lastIn.detail && lastIn.channel !== "call" ? `, "${clip(lastIn.detail, 140)}"` : ""}.`);
  } else {
    lines.push("No reply from the client on any channel yet.");
  }
  const lastOut = list.find((x) => x.dir === "out");
  if (lastOut) lines.push(`Last from us: ${word(lastOut.channel)} on ${shortDate(lastOut.at)}.`);
  const idx = list.findIndex((x) => x.dir === "in");
  const since = (idx === -1 ? list : list.slice(0, idx)).filter((x) => x.dir === "out").length;
  if (since > 0) lines.push(`${since} touch${since === 1 ? "" : "es"} from us${idx === -1 ? " in total" : " since they last replied"}.`);
  const notes = input.timeline.filter((e) => e.channel === "note" && e.detail);
  const lastNote = notes[notes.length - 1];
  if (lastNote) lines.push(`Latest note${lastNote.rawDate ? ` (${lastNote.rawDate})` : ""}: "${clip(lastNote.detail, 140)}".`);
  return lines;
}

/** Who the text is from: the project's Goodshuffle sales lead (first name), else MORNING_OUTREACH_REP_NAME,
 *  else nobody (the drafter then opens with "it's Zoe Events"). */
export function senderFirstName(salesLead: string | null | undefined, fallback: string | null | undefined): string | null {
  const first = (salesLead ?? "").trim().split(/\s+/)[0];
  return first || (fallback ?? "").trim() || null;
}

// ── The dry run ──────────────────────────────────────────────────────────────────────────────────────

export interface MorningPlanRow {
  leadId: string;
  eventName: string;
  clientName: string;
  stageLabel: string;
  subStatusLabel: string;
  value: number | null;
  whereWeAre: string[];
  context: ContextCounts;
  send: boolean;
  reason: string | null;
  draft: string | null;
  caution: string | null;
  draftSource: "ai" | "template" | null;
  sendAt: string | null;
  salesLead: string | null; // Goodshuffle sales lead on the project
  signedAs: string | null; // first name the text introduces; null = "Zoe Events"
}

export interface MorningPlan {
  dryRun: true;
  generatedAt: string;
  sendDay: string;
  rows: MorningPlanRow[];
  posted: boolean;
}

export interface MorningRunState {
  status: "idle" | "running" | "done" | "error";
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  plan?: MorningPlan;
}

const KEY = "salesos.morningOutreach.dryRun";
let running = false;

const SUB_ORDER: Record<OpenQuoteSubStatus, number> = { follow_up: 0, quote_sent: 1, action_needed: 2 };

/** Which open quotes to look at: dormant ones first, then the recent ones, then replied; biggest first. */
export function pickLeads(cards: LeadCard[], limit: number): LeadCard[] {
  return [...cards]
    .sort((a, b) => SUB_ORDER[a.status as OpenQuoteSubStatus] - SUB_ORDER[b.status as OpenQuoteSubStatus] || (b.value ?? 0) - (a.value ?? 0))
    .slice(0, Math.max(0, limit));
}

async function readLiveCalls(phone: string, numbers: QuoNumber[]): Promise<LiveCall[]> {
  const d10 = phone.replace(/\D/g, "").slice(-10);
  if (d10.length !== 10 || !numbers.length) return [];
  const out: LiveCall[] = [];
  for (const n of numbers) {
    const { calls } = await listOpenphoneCalls(n.id, `+1${d10}`);
    for (const c of calls) {
      if (!c.occurredAt) continue;
      out.push({ direction: c.direction === "outgoing" ? "out" : "in", at: c.occurredAt, secs: c.durationSec });
    }
  }
  return out;
}

async function planLead(card: LeadCard, numbers: QuoNumber[], sendDay: string, now: number, fallbackRep: string | null): Promise<MorningPlanRow> {
  const lead = getLead(card.id);
  const signedAs = senderFirstName(lead?.salesLead, fallbackRep);
  const phone = lead?.clientPhone ?? "";
  await ensureLeadThreadSynced(card.id, phone); // fresh Quo texts into the timeline before we read it
  const liveCalls = phone ? await readLiveCalls(phone, numbers) : [];
  const timeline = buildLeadTimeline(card.id);
  const subStatus = card.status as OpenQuoteSubStatus;
  const daysToEvent = lead?.signals.daysToEvent ?? card.daysToEvent;
  const gate = gateLead({ hasPhone: phone.trim().length > 0, daysToEvent, subStatus, timeline, liveCalls, now });

  let draft: string | null = null;
  let caution: string | null = null;
  let draftSource: MorningPlanRow["draftSource"] = null;
  if (gate.send) {
    const d = await draftLeadOutreach(card.id, signedAs);
    const body = d?.draft.sms?.trim();
    if (body) {
      draft = humanize(body);
      caution = d?.draft.caution ?? null;
      draftSource = d?.draft.source === "ai" ? "ai" : "template";
    }
  }
  const send = gate.send && !!draft;
  return {
    leadId: card.id,
    eventName: card.eventName,
    clientName: card.clientName,
    stageLabel: lead ? STAGE_LABEL[lead.stage] : card.statusLabel,
    subStatusLabel: SUBSTATUS_LABEL[subStatus] ?? card.statusLabel,
    value: card.value,
    whereWeAre: whereWeAre({ value: card.value, quoteSentDate: card.quoteSentDate, eventDate: card.eventDate, daysToEvent, timeline, liveCalls, now }),
    context: contextCounts(timeline, liveCalls),
    send,
    reason: gate.send && !draft ? "The drafter found no sensible next step." : gate.reason,
    draft: send ? draft : null,
    caution: send ? caution : null,
    draftSource: send ? draftSource : null,
    sendAt: send ? randomSendTime(sendDay) : null,
    salesLead: lead?.salesLead ?? null,
    signedAs,
  };
}

/** Build the plan for `limit` open quotes. Sends nothing. */
export async function buildMorningPlan(opts: { limit?: number; now?: Date; repFirstName?: string | null } = {}): Promise<MorningPlan> {
  const now = opts.now ?? new Date();
  const sendDay = nextSendDay(now);
  const numbers = openphoneApiKey() ? await getOpenphonePhoneNumbers() : [];
  const cards = pickLeads(openQuoteCards(), opts.limit ?? 10);
  const repFirstName = opts.repFirstName ?? (process.env.MORNING_OUTREACH_REP_NAME?.trim() || null);
  const rows: MorningPlanRow[] = [];
  for (const c of cards) rows.push(await planLead(c, numbers, sendDay, now.getTime(), repFirstName));
  rows.sort((a, b) => Number(b.send) - Number(a.send) || (a.sendAt ?? "").localeCompare(b.sendAt ?? ""));
  return { dryRun: true, generatedAt: new Date().toISOString(), sendDay, rows, posted: false };
}

// ── Slack recap ──────────────────────────────────────────────────────────────────────────────────────

const dayLabel = (ymd: string): string => new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "long", month: "short", day: "numeric" });

export function headerCard(plan: MorningPlan): BotCard {
  const sends = plan.rows.filter((r) => r.send).length;
  return {
    emoji: "🧪",
    title: `Morning outreach dry run: ${plan.rows.length} projects`,
    subtitle: `Nothing was sent. This is what Sales Bot would do on ${dayLabel(plan.sendDay)} between 9:12 and 9:17 AM. Each text is signed by the project's sales lead from Goodshuffle.`,
    fields: [
      { label: "Would text", value: String(sends) },
      { label: "Would hold back", value: String(plan.rows.length - sends) },
    ],
    body: "Context checked for every project: Quo texts (refreshed live), Quo calls (read live), Goodshuffle emails, quote opens, notes and the sales log. Reply in thread with anything that looks off.",
    context: "Sales Bot · dry run",
  };
}

export function projectCard(r: MorningPlanRow): BotCard {
  const c = r.context;
  const sections = [`*Based on context we are here:*\n${r.whereWeAre.map((l) => `• ${l}`).join("\n")}`];
  if (r.send && r.draft) {
    sections.push(`*Sales Bot would have sent this* (text at ${clockLabel(r.sendAt!)}, as ${r.signedAs ?? "Zoe Events"}):\n>${r.draft.replace(/\n/g, "\n>")}`);
    if (r.caution) sections.push(`_Heads up: ${r.caution}_`);
  } else {
    sections.push(`*Sales Bot would not text this one:* ${r.reason ?? "no reason recorded"}`);
  }
  return {
    title: `${r.eventName} - ${r.clientName}`.slice(0, 140),
    subtitle: `${r.subStatusLabel} · ${r.stageLabel}${r.value != null ? ` · $${Math.round(r.value).toLocaleString("en-US")}` : ""} · Sales lead: ${r.salesLead ?? "not captured yet"}`,
    sections,
    link: { text: "Open in Sales OS", url: appUrl("/salesos") },
    context: `Read: ${c.quoTexts} Quo texts, ${c.quoCalls} stored calls + ${c.liveCalls} live from Quo, ${c.emails} emails, ${c.notes} notes${r.draftSource ? ` · draft: ${r.draftSource}` : ""}`,
  };
}

export async function postPlan(plan: MorningPlan): Promise<boolean> {
  const h = await botAnnounce("sales", headerCard(plan));
  let ok = h.ok;
  for (const r of plan.rows) ok = (await botAnnounce("sales", projectCard(r))).ok && ok;
  return ok;
}

// ── Background runner (the request returns right away; GET polls) ───────────────────────────────────

export function getMorningRunState(): MorningRunState {
  const s = getJson<MorningRunState>(KEY, { status: "idle" });
  return s.status === "running" && !running ? { ...s, status: "error", error: "The run stopped (the server likely restarted). POST again." } : s;
}

export function startMorningDryRun(opts: { limit?: number; post?: boolean } = {}): MorningRunState {
  if (running) return getMorningRunState();
  running = true;
  const startedAt = new Date().toISOString();
  setJson(KEY, { status: "running", startedAt } satisfies MorningRunState);
  void (async () => {
    try {
      const plan = await buildMorningPlan({ limit: opts.limit });
      if (opts.post !== false) plan.posted = await postPlan(plan);
      setJson(KEY, { status: "done", startedAt, finishedAt: new Date().toISOString(), plan } satisfies MorningRunState);
    } catch (e) {
      setJson(KEY, { status: "error", startedAt, error: e instanceof Error ? e.message : String(e) } satisfies MorningRunState);
    } finally {
      running = false;
    }
  })();
  return { status: "running", startedAt };
}
