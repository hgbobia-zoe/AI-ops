// Sales-hours analysis over Quo (OpenPhone) history: when do customers actually call and text, how many
// calls go unanswered, and how fast we reply, by weekday x hour (Eastern). Runs server-side with the stored
// Quo key and returns ONLY aggregates (no phone numbers, names or message text leave the server).
//
// Quo's API lists calls/messages per (our number x one participant), so the runner first lists
// conversations to learn the participants, then pages each one. Slow (thousands of requests), so it runs in
// the background and stores progress + the result in KV; the route polls it.

import { openphoneApiKey } from "@/lib/comms/openphone";
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

interface Cell {
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

/** Pure aggregation. Reply time = inbound text or missed call -> our next outbound call/text to the same
 *  person within 48h (longer gaps are a new conversation, not a reply). */
export function aggregate(events: QuoEvent[], from: string, to: string, conversations = 0): HoursReport {
  const seasons = ["all", "peak", "off"] as const;
  const cells: Record<(typeof seasons)[number], Cell[][]> = {
    all: DOW.map(() => Array.from({ length: 24 }, emptyCell)),
    peak: DOW.map(() => Array.from({ length: 24 }, emptyCell)),
    off: DOW.map(() => Array.from({ length: 24 }, emptyCell)),
  };
  const totals = { callsIn: 0, callsMissed: 0, callsOut: 0, textsIn: 0, textsOut: 0, conversations };
  const months = new Map<string, { callsIn: number; textsIn: number; callsMissed: number }>();
  let afterIn = 0;
  let afterMissed = 0;

  const byWho = new Map<string, QuoEvent[]>();
  for (const e of events) {
    if (e.at < from || e.at > to) continue;
    (byWho.get(e.who) ?? byWho.set(e.who, []).get(e.who)!).push(e);
  }

  for (const list of byWho.values()) {
    list.sort((a, b) => a.at.localeCompare(b.at));
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      const lp = localParts(e.at);
      const targets = [cells.all[lp.dow][lp.hour], cells[isPeak(lp.month) ? "peak" : "off"][lp.dow][lp.hour]];
      const mk = lp.ymd.slice(0, 7);
      const mo = months.get(mk) ?? { callsIn: 0, textsIn: 0, callsMissed: 0 };
      months.set(mk, mo);
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
        afterIn++;
        if (e.kind === "call" && e.missed) afterMissed++;
      }
      // Reply time: only for things that need a reply (inbound text, missed call), and only for the first
      // of a burst (skip if the previous event was also an unanswered inbound from them).
      const needsReply = (e.kind === "text" && inbound) || (e.kind === "call" && inbound && e.missed);
      const prev = list[i - 1];
      const prevUnanswered = prev && prev.dir === "in" && (prev.kind === "text" || prev.missed);
      if (needsReply && !prevUnanswered) {
        const next = list.slice(i + 1).find((x) => x.dir === "out");
        if (next) {
          const mins = (Date.parse(next.at) - Date.parse(e.at)) / 60000;
          if (mins >= 0 && mins <= 48 * 60) targets.forEach((c) => c.replyMins.push(mins));
        }
      }
    }
  }

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
    byMonth: [...months.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, v]) => ({ month, ...v })),
    daysPerDow,
  };
}

// ── Runner (I/O) ─────────────────────────────────────────────────────────────────────────────────────

const KEY = "analytics.quoHours";
export interface RunState {
  status: "idle" | "running" | "done" | "error";
  startedAt?: string;
  finishedAt?: string;
  progress?: { conversations: number; done: number; requests: number };
  error?: string;
  report?: HoursReport;
}
export function getRunState(): RunState {
  return getJson<RunState>(KEY, { status: "idle" });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let requests = 0;
async function qGet(path: string, apiKey: string): Promise<Record<string, unknown> | null> {
  for (let attempt = 0; attempt < 4; attempt++) {
    await sleep(120); // stay under Quo's ~10 req/s
    requests++;
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

async function pages(path: string, apiKey: string, max = 200): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  let token: string | null = null;
  for (let i = 0; i < max; i++) {
    const sep = path.includes("?") ? "&" : "?";
    const j = await qGet(`${path}${sep}maxResults=100${token ? `&pageToken=${encodeURIComponent(token)}` : ""}`, apiKey);
    if (!j) break;
    out.push(...(((j.data as Record<string, unknown>[]) ?? [])));
    token = (j.nextPageToken as string) || null;
    if (!token) break;
  }
  return out;
}

let running = false;
/** Start a background run over the last `days` days. No-op if one is already running. */
export function startRun(days = 365): RunState {
  if (running) return getRunState();
  const apiKey = openphoneApiKey();
  if (!apiKey) {
    const s: RunState = { status: "error", error: "Quo is not configured" };
    setJson(KEY, s);
    return s;
  }
  running = true;
  requests = 0;
  const to = new Date().toISOString();
  const from = new Date(Date.now() - days * 86400000).toISOString();
  const state: RunState = { status: "running", startedAt: to, progress: { conversations: 0, done: 0, requests: 0 } };
  setJson(KEY, { ...getRunState(), ...state });
  void (async () => {
    try {
      const numbers = ((await qGet("/phone-numbers", apiKey))?.data as { id?: string }[] | undefined)?.filter((n) => n.id) ?? [];
      const pairs: { num: string; who: string }[] = [];
      for (const n of numbers) {
        const convs = await pages(`/conversations?phoneNumbers[]=${encodeURIComponent(String(n.id))}&updatedAfter=${encodeURIComponent(from)}`, apiKey, 100);
        for (const c of convs) {
          const parts = Array.isArray(c.participants) ? (c.participants as unknown[]).map(String) : [];
          for (const p of parts) pairs.push({ num: String(n.id), who: p });
        }
      }
      state.progress = { conversations: pairs.length, done: 0, requests };
      setJson(KEY, { ...getRunState(), ...state });
      const events: QuoEvent[] = [];
      for (const { num, who } of pairs) {
        const q = `phoneNumberId=${encodeURIComponent(num)}&participants=${encodeURIComponent(who)}&createdAfter=${encodeURIComponent(from)}`;
        const whoKey = `${num}|${who}`;
        for (const c of await pages(`/calls?${q}`, apiKey, 20)) {
          const at = (c.createdAt as string) || (c.completedAt as string);
          if (!at) continue;
          const dir = c.direction === "outgoing" ? "out" : "in";
          const status = String(c.status ?? "");
          // Prefer answeredAt (null = nobody picked up); fall back to the status word if the field is absent.
          const missed = dir === "in" && ("answeredAt" in c ? !c.answeredAt : /missed|no-answer|voicemail|abandoned/i.test(status));
          events.push({ kind: "call", dir, at, missed, who: whoKey });
        }
        for (const m of await pages(`/messages?${q}`, apiKey, 20)) {
          const at = m.createdAt as string;
          if (!at) continue;
          events.push({ kind: "text", dir: m.direction === "outgoing" || m.direction === "outbound" ? "out" : "in", at, who: whoKey });
        }
        state.progress.done++;
        state.progress.requests = requests;
        if (state.progress.done % 25 === 0) setJson(KEY, { ...getRunState(), ...state });
      }
      const report = aggregate(events, from, to, pairs.length);
      setJson(KEY, { status: "done", startedAt: state.startedAt, finishedAt: new Date().toISOString(), progress: state.progress, report });
    } catch (e) {
      setJson(KEY, { ...state, status: "error", error: e instanceof Error ? e.message : String(e) });
    } finally {
      running = false;
    }
  })();
  return state;
}
