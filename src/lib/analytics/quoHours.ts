// Sales-hours analysis over Quo (OpenPhone) history: when do customers actually call and text, how many
// calls go unanswered, and how fast we reply, by weekday x hour (Eastern). Runs server-side with the stored
// Quo key and returns ONLY aggregates (no phone numbers, names or message text leave the server).
//
// Quo's API lists calls/messages per (our number x one participant), so the runner first lists
// conversations to learn the participants, then pages each one. Slow (thousands of requests), so it runs in
// the background and stores progress + the result in KV; the route polls it.

import { openphoneApiKey } from "@/lib/comms/openphone";
import { createHash } from "node:crypto";
import { getJson, setJson } from "@/lib/kv";

export interface QuoEvent {
  kind: "call" | "text";
  dir: "in" | "out";
  at: string; // ISO
  missed?: boolean; // inbound call never answered
  who: string; // participant key (only used in memory for reply-time pairing)
}

export const TZ = "America/New_York";
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Weekday (0=Sun), hour, month (1-12) of an instant in Eastern time. */
export function localParts(iso: string, tz = TZ): { dow: number; hour: number; month: number; ymd: string } {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "numeric", hourCycle: "h23", month: "numeric", day: "numeric", year: "numeric" });
  const p = Object.fromEntries(f.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return {
    dow: DOW.indexOf(p.weekday),
    hour: Number(p.hour) % 24,
    month: Number(p.month),
    ymd: `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`,
  };
}

/** Is this local time inside the posted sales hours (M-F 10-18, Sat 10-13)? */
export function inSalesHours(dow: number, hour: number): boolean {
  if (dow >= 1 && dow <= 5) return hour >= 10 && hour < 18;
  if (dow === 6) return hour >= 10 && hour < 13;
  return false;
}

/** Peak season = April through October (event rental season). */
export function isPeak(month: number): boolean {
  return month >= 4 && month <= 10;
}

export interface Cell {
  callsIn: number;
  callsMissed: number;
  callsOut: number;
  textsIn: number;
  textsOut: number;
  replyMins: number[]; // minutes from an inbound text/missed call to our next outbound touch
}
const emptyCell = (): Cell => ({ callsIn: 0, callsMissed: 0, callsOut: 0, textsIn: 0, textsOut: 0, replyMins: [] });

export interface HoursReport {
  generatedAt: string;
  from: string;
  to: string;
  totals: { callsIn: number; callsMissed: number; callsOut: number; textsIn: number; textsOut: number; conversations: number };
  /** [season][dow][hour] where season is "all" | "peak" | "off". */
  grid: Record<"all" | "peak" | "off", { callsIn: number; callsMissed: number; callsOut: number; textsIn: number; textsOut: number; medianReplyMins: number | null; n: number }[][]>;
  /** Inbound contacts (calls + texts) outside posted hours, and how many of those were missed calls. */
  afterHours: { inbound: number; share: number; missedCalls: number };
  byMonth: { month: string; callsIn: number; textsIn: number; callsMissed: number }[];
  /** Distinct days in the window per weekday (to turn totals into per-day averages). */
  daysPerDow: number[];
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Running totals that can be saved to KV mid run and picked up again after a restart. Holds counts and
 *  reply minutes only: no participant keys, numbers, names or text. */
export interface HoursAcc {
  cells: Record<"all" | "peak" | "off", Cell[][]>;
  totals: { callsIn: number; callsMissed: number; callsOut: number; textsIn: number; textsOut: number };
  months: Record<string, { callsIn: number; textsIn: number; callsMissed: number }>;
  afterIn: number;
  afterMissed: number;
}

const SEASONS = ["all", "peak", "off"] as const;
export function newAcc(): HoursAcc {
  const grid = () => DOW.map(() => Array.from({ length: 24 }, emptyCell));
  return {
    cells: { all: grid(), peak: grid(), off: grid() },
    totals: { callsIn: 0, callsMissed: 0, callsOut: 0, textsIn: 0, textsOut: 0 },
    months: {},
    afterIn: 0,
    afterMissed: 0,
  };
}

/** Fold ONE participant's events (every event for one of our numbers x one person) into the totals.
 *  Reply time = inbound text or missed call, then our next outbound call/text to the same person within 48h
 *  (longer gaps are a new conversation, not a reply). Events outside [from, to] are ignored. */
export function addParticipant(acc: HoursAcc, events: QuoEvent[], from: string, to: string): void {
  const list = events.filter((e) => e.at >= from && e.at <= to).sort((a, b) => a.at.localeCompare(b.at));
  const { cells, totals } = acc;
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    const lp = localParts(e.at);
    const targets = [cells.all[lp.dow][lp.hour], cells[isPeak(lp.month) ? "peak" : "off"][lp.dow][lp.hour]];
    const mk = lp.ymd.slice(0, 7);
    const mo = (acc.months[mk] ??= { callsIn: 0, textsIn: 0, callsMissed: 0 });
    if (e.kind === "call" && e.dir === "in") {
      totals.callsIn++;
      mo.callsIn++;
      targets.forEach((c) => c.callsIn++);
      if (e.missed) {
        totals.callsMissed++;
        mo.callsMissed++;
        targets.forEach((c) => c.callsMissed++);
      }
    } else if (e.kind === "call") {
      totals.callsOut++;
      targets.forEach((c) => c.callsOut++);
    } else if (e.dir === "in") {
      totals.textsIn++;
      mo.textsIn++;
      targets.forEach((c) => c.textsIn++);
    } else {
      totals.textsOut++;
      targets.forEach((c) => c.textsOut++);
    }
    const inbound = e.dir === "in";
    if (inbound && !inSalesHours(lp.dow, lp.hour)) {
      acc.afterIn++;
      if (e.kind === "call" && e.missed) acc.afterMissed++;
    }
    // Reply time: only for things that need a reply (inbound text, missed call), and only for the first
    // of a burst (skip if the previous event was also an unanswered inbound from them).
    const needsReply = (e.kind === "text" && inbound) || (e.kind === "call" && inbound && e.missed);
    const prev = list[i - 1];
    const prevUnanswered = prev && prev.dir === "in" && (prev.kind === "text" || prev.missed);
    if (needsReply && !prevUnanswered) {
      const next = list.slice(i + 1).find((x) => x.dir === "out");
      if (next) {
        const mins = Math.round(((Date.parse(next.at) - Date.parse(e.at)) / 60000) * 100) / 100;
        if (mins >= 0 && mins <= 48 * 60) targets.forEach((c) => c.replyMins.push(mins));
      }
    }
  }
}

/** Pure aggregation over a flat event list (groups by participant, then folds and finalizes). */
export function aggregate(events: QuoEvent[], from: string, to: string, conversations = 0): HoursReport {
  const byWho = new Map<string, QuoEvent[]>();
  for (const e of events) (byWho.get(e.who) ?? byWho.set(e.who, []).get(e.who)!).push(e);
  const acc = newAcc();
  for (const list of byWho.values()) addParticipant(acc, list, from, to);
  return finalize(acc, from, to, conversations);
}

/** Turn the running totals into the report. */
export function finalize(acc: HoursAcc, from: string, to: string, conversations = 0): HoursReport {
  const seasons = SEASONS;
  const { cells, afterIn, afterMissed } = acc;
  const totals = { ...acc.totals, conversations };
  const grid = Object.fromEntries(
    seasons.map((s) => [
      s,
      cells[s].map((row) =>
        row.map((c) => ({
          callsIn: c.callsIn,
          callsMissed: c.callsMissed,
          callsOut: c.callsOut,
          textsIn: c.textsIn,
          textsOut: c.textsOut,
          medianReplyMins: median(c.replyMins) == null ? null : Math.round(median(c.replyMins)!),
          n: c.replyMins.length,
        })),
      ),
    ]),
  ) as HoursReport["grid"];

  const daysPerDow = [0, 0, 0, 0, 0, 0, 0];
  for (let t = Date.parse(from); t <= Date.parse(to); t += 86400000) daysPerDow[localParts(new Date(t).toISOString()).dow]++;

  const inboundAll = totals.callsIn + totals.textsIn;
  return {
    generatedAt: new Date().toISOString(),
    from,
    to,
    totals,
    grid,
    afterHours: { inbound: afterIn, share: inboundAll ? Math.round((afterIn / inboundAll) * 1000) / 10 : 0, missedCalls: afterMissed },
    byMonth: Object.entries(acc.months).sort(([a], [b]) => a.localeCompare(b)).map(([month, v]) => ({ month, ...v })),
    daysPerDow,
  };
}


// ── Runner (I/O) ─────────────────────────────────────────────────────────────────────────────────────
//
// A run takes over an hour and lives inside the web process, so a deploy or machine restart kills it.
// Two things make that survivable:
//  1. Every save stamps updatedAt. GET reports "interrupted" when the KV says running but this process
//     is not running it, and "stale" when this process is but nothing has been saved for STALE_MS.
//  2. A checkpoint (separate KV key, never returned by GET) holds the partial aggregates plus short salted
//     hashes of the participants already folded in. A new POST with the same window picks up from there.

const KEY = "analytics.quoHours";
const CKPT_KEY = "analytics.quoHours.checkpoint";
/** No progress save for this long while "running" means the run is hung. */
export const STALE_MS = 15 * 60_000;
/** Older checkpoints are dropped and the run starts over (the window would be too far out of date). */
export const RESUME_MAX_AGE_MS = 48 * 3_600_000;
const SAVE_EVERY = 25;

export type RunStatus = "idle" | "running" | "done" | "error" | "interrupted" | "stale";
export interface RunState {
  status: RunStatus;
  startedAt?: string;
  finishedAt?: string;
  /** Last time the runner saved progress (heartbeat). */
  updatedAt?: string;
  days?: number;
  progress?: { conversations: number; done: number; requests: number };
  /** How many times this run was picked up again after a restart. */
  resumes?: number;
  /** True when a POST with the same days will continue from the checkpoint instead of starting over. */
  resumable?: boolean;
  note?: string;
  error?: string;
  report?: HoursReport;
}

/** Partial work saved mid run. Aggregates and hashes only: no numbers, names or text. */
export interface Checkpoint {
  v: 1;
  days: number;
  from: string;
  to: string;
  startedAt: string;
  updatedAt: string;
  resumes: number;
  salt: string;
  /** Salted, truncated hashes of the (our number, participant) pairs already folded into acc. */
  processed: string[];
  acc: HoursAcc;
}

export function hashPair(salt: string, num: string, who: string): string {
  return createHash("sha256").update(`${salt}|${num}|${who}`).digest("hex").slice(0, 16);
}

function readRaw(): RunState {
  return getJson<RunState>(KEY, { status: "idle" });
}
function readCheckpoint(): Checkpoint | null {
  const c = getJson<Checkpoint | null>(CKPT_KEY, null);
  return c && c.v === 1 && Array.isArray(c.processed) && c.acc ? c : null;
}

/** Is this checkpoint good to continue for a run over `days`? */
export function canResume(ck: Checkpoint | null, days: number, now = Date.now()): ck is Checkpoint {
  return !!ck && ck.days === days && now - Date.parse(ck.startedAt) < RESUME_MAX_AGE_MS;
}

/** Pure: what the stored state really means, given whether this process is running it right now. */
export function deriveState(raw: RunState, ctx: { live: boolean; now: number; checkpoint: Checkpoint | null }): RunState {
  const days = raw.days ?? ctx.checkpoint?.days ?? 365;
  const resumable = canResume(ctx.checkpoint, days, ctx.now);
  const p = raw.progress;
  const where = p ? `${p.done} of ${p.conversations} conversations` : "the start";
  const next = resumable ? `POST again to resume from ${where}.` : "POST again to start over.";
  if (raw.status === "running") {
    if (!ctx.live) {
      return { ...raw, status: "interrupted", resumable, note: `The run stopped at ${where} (the server likely restarted). ${next}` };
    }
    const last = Date.parse(raw.updatedAt ?? raw.startedAt ?? "");
    if (Number.isFinite(last) && ctx.now - last > STALE_MS) {
      const mins = Math.round((ctx.now - last) / 60000);
      return { ...raw, status: "stale", resumable, note: `No progress saved for ${mins} minutes at ${where}. ${next}` };
    }
    return raw;
  }
  if (raw.status === "error") return { ...raw, resumable };
  return raw;
}

// One run at a time per process. A superseded loop notices its id is no longer active and exits quietly.
let active: { id: number } | null = null;
let runSeq = 0;
let paceScale = 1;
/** Tests only: scale every sleep (0 = no waiting). */
export function setPaceScaleForTests(x: number): void {
  paceScale = x;
}

export function getRunState(): RunState {
  return deriveState(readRaw(), { live: active !== null, now: Date.now(), checkpoint: readCheckpoint() });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms * paceScale));
async function qGet(path: string, apiKey: string, ctr: { requests: number }): Promise<Record<string, unknown> | null> {
  for (let attempt = 0; attempt < 4; attempt++) {
    await sleep(120); // stay under Quo's ~10 req/s
    ctr.requests++;
    try {
      const res = await fetch(`https://api.openphone.com/v1${path}`, { headers: { authorization: apiKey } });
      if (res.status === 429 || res.status >= 500) {
        await sleep(1500 * (attempt + 1));
        continue;
      }
      if (!res.ok) return null;
      return (await res.json().catch(() => null)) as Record<string, unknown> | null;
    } catch {
      await sleep(1000);
    }
  }
  return null;
}

async function pages(path: string, apiKey: string, ctr: { requests: number }, max = 200): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  let token: string | null = null;
  for (let i = 0; i < max; i++) {
    const sep = path.includes("?") ? "&" : "?";
    const j = await qGet(`${path}${sep}maxResults=100${token ? `&pageToken=${encodeURIComponent(token)}` : ""}`, apiKey, ctr);
    if (!j) break;
    out.push(...(((j.data as Record<string, unknown>[]) ?? [])));
    token = (j.nextPageToken as string) || null;
    if (!token) break;
  }
  return out;
}

/** Every call and text between one of our numbers and one participant since `from`. */
async function fetchParticipant(num: string, who: string, from: string, apiKey: string, ctr: { requests: number }): Promise<QuoEvent[]> {
  const q = `phoneNumberId=${encodeURIComponent(num)}&participants=${encodeURIComponent(who)}&createdAfter=${encodeURIComponent(from)}`;
  const events: QuoEvent[] = [];
  for (const c of await pages(`/calls?${q}`, apiKey, ctr, 20)) {
    const at = (c.createdAt as string) || (c.completedAt as string);
    if (!at) continue;
    const dir = c.direction === "outgoing" ? "out" : "in";
    const status = String(c.status ?? "");
    // Prefer answeredAt (null = nobody picked up); fall back to the status word if the field is absent.
    const missed = dir === "in" && ("answeredAt" in c ? !c.answeredAt : /missed|no-answer|voicemail|abandoned/i.test(status));
    events.push({ kind: "call", dir, at, missed, who: "p" });
  }
  for (const m of await pages(`/messages?${q}`, apiKey, ctr, 20)) {
    const at = m.createdAt as string;
    if (!at) continue;
    events.push({ kind: "text", dir: m.direction === "outgoing" || m.direction === "outbound" ? "out" : "in", at, who: "p" });
  }
  return events;
}

/** Start a background run over the last `days` days, or continue an interrupted one with the same window.
 *  No-op while a healthy run is going. `fresh` throws away any checkpoint and starts over. */
export function startRun(days = 365, opts: { fresh?: boolean } = {}): RunState {
  const current = getRunState();
  if (active && current.status === "running") return current;
  const apiKey = openphoneApiKey();
  if (!apiKey) {
    const s: RunState = { status: "error", error: "Quo is not configured" };
    setJson(KEY, s);
    return s;
  }

  const now = Date.now();
  const saved = readCheckpoint();
  const resume = !opts.fresh && canResume(saved, days, now);
  const ck: Checkpoint =
    resume && saved
      ? { ...saved, resumes: saved.resumes + 1 }
      : {
          v: 1,
          days,
          from: new Date(now - days * 86400000).toISOString(),
          to: new Date(now).toISOString(),
          startedAt: new Date(now).toISOString(),
          updatedAt: new Date(now).toISOString(),
          resumes: 0,
          salt: createHash("sha256").update(`${now}|${Math.random()}`).digest("hex").slice(0, 16),
          processed: [],
          acc: newAcc(),
        };
  setJson(CKPT_KEY, ck);

  const runId = ++runSeq;
  active = { id: runId }; // also supersedes a stale loop in this process
  const mine = () => active?.id === runId;
  const ctr = { requests: 0 };
  const processed = new Set(ck.processed);
  const prevReport = readRaw().report; // keep showing the last finished report while this one runs
  const state: RunState & { progress: NonNullable<RunState["progress"]> } = {
    status: "running",
    startedAt: ck.startedAt,
    updatedAt: new Date().toISOString(),
    days,
    resumes: ck.resumes,
    progress: { conversations: 0, done: processed.size, requests: 0 },
    note: resume ? `Resumed with ${processed.size} conversations already counted.` : undefined,
  };
  const save = (withCheckpoint: boolean) => {
    const at = new Date().toISOString();
    state.updatedAt = at;
    state.progress.requests = ctr.requests;
    if (withCheckpoint) setJson(CKPT_KEY, { ...ck, updatedAt: at, processed: [...processed] });
    setJson(KEY, { ...state, report: prevReport });
  };
  save(false);

  void (async () => {
    try {
      const numbers = ((await qGet("/phone-numbers", apiKey, ctr))?.data as { id?: string }[] | undefined)?.filter((n) => n.id) ?? [];
      // hash -> pair. Keying by hash also dedupes a participant seen in several conversations.
      const pairs = new Map<string, { num: string; who: string }>();
      for (const n of numbers) {
        const num = String(n.id);
        const convs = await pages(`/conversations?phoneNumbers[]=${encodeURIComponent(num)}&updatedAfter=${encodeURIComponent(ck.from)}`, apiKey, ctr, 100);
        if (!mine()) return;
        for (const c of convs) {
          const parts = Array.isArray(c.participants) ? (c.participants as unknown[]).map(String) : [];
          for (const who of parts) pairs.set(hashPair(ck.salt, num, who), { num, who });
        }
        save(false); // heartbeat while listing
      }
      const todo = [...pairs].filter(([h]) => !processed.has(h));
      state.progress = { conversations: pairs.size, done: pairs.size - todo.length, requests: ctr.requests };
      save(false);

      for (const [h, { num, who }] of todo) {
        const events = await fetchParticipant(num, who, ck.from, apiKey, ctr);
        if (!mine()) return; // superseded while we were waiting on Quo
        addParticipant(ck.acc, events, ck.from, ck.to);
        processed.add(h);
        state.progress.done++;
        if (state.progress.done % SAVE_EVERY === 0) save(true);
      }
      if (!mine()) return;
      const report = finalize(ck.acc, ck.from, ck.to, pairs.size);
      const doneAt = new Date().toISOString();
      setJson(KEY, {
        status: "done",
        startedAt: ck.startedAt,
        finishedAt: doneAt,
        updatedAt: doneAt,
        days,
        resumes: ck.resumes,
        progress: { ...state.progress, requests: ctr.requests },
        report,
      } satisfies RunState);
      setJson(CKPT_KEY, null);
    } catch (e) {
      if (!mine()) return;
      save(true); // keep what we have so a retry resumes
      setJson(KEY, { ...state, status: "error", error: e instanceof Error ? e.message : String(e), report: prevReport });
    } finally {
      if (mine()) active = null;
    }
  })();
  return { ...state };
}
