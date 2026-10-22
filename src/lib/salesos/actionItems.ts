// Customer ACTION-ITEM detection — catches the asks a customer raised that still need a human/Zoe
// response, so they aren't dropped while the AI sends context-poor follow-ups. Root cause it fixes:
// conversations (e.g. Holly Chang, a Paul lead) where the customer asked something concrete — "strike
// paragraph 24 of the T&C", "what's the difference between a 500 vs 300 lb block?" — and it went
// unanswered because nothing surfaced it.
//
// GOVERNING LAW:
//   • RULES CALCULATE, AI INTERPRETS. The gathering, the dedupe, the resolution signal, and the gate are
//     all DETERMINISTIC; only the extraction (which asks are open) is the LLM's judgement.
//   • HONEST / FACTS ONLY. Every surfaced item must quote the customer's OWN words — a verbatim quote the
//     extractor returns is DROPPED unless it actually appears in the customer's inbound text. We never
//     invent an ask.
//   • DETECT + SURFACE ONLY. This NEVER drafts or sends a reply. Any response stays on the existing
//     human/approval path. There is no auto-reply here by construction.
//   • Key/LLM-gated, bounded, self-throttled, outage-safe: a missing key, an unreachable LLM, or a single
//     lead failing never throws into the tick and never fabricates.

import { chat, llmConfigured } from "@/lib/llm";
import { openphoneApiKey } from "@/lib/comms/openphone";
import { ensureLeadThreadSynced } from "@/lib/comms/openphoneSync";
import { notify } from "@/lib/notify/channels";
import { buildActionItemCard } from "@/lib/notify/cards";
import { slackBotConfigured, slackConfigured } from "@/lib/notify/slack";
import { getJson, setJson } from "@/lib/kv";
import { todayInOpsTz } from "@/lib/dates";
import { businessHoursGate } from "@/lib/settings";
import {
  getBookingById,
  getOpenLeads,
  getCommsForLead,
  getCallEventsByPhoneDigits,
  getEmailEventsForLead,
  getLatestOutboundForLead,
  getLastCommsAt,
  type BookingView,
} from "@/lib/db/repo";

// ── Types ────────────────────────────────────────────────────────────────────────

export type ActionItemKind =
  | "contract_change" // "strike paragraph 24 of the T&C"
  | "pricing_question" // "what does the delivery add up to?"
  | "product_question" // "difference between a 500 vs 300 lb block?"
  | "scheduling" // move the date / time / delivery window
  | "decision" // "ready to lock it in", "let's go with option B"
  | "objection" // a concern / pushback that needs addressing
  | "other";

const KINDS: ReadonlySet<string> = new Set<ActionItemKind>([
  "contract_change",
  "pricing_question",
  "product_question",
  "scheduling",
  "decision",
  "objection",
  "other",
]);

/** An open ask the customer raised, as the extractor returns it (before persistence). */
export interface ActionItem {
  summary: string; // a short neutral description of the ask (our words)
  kind: ActionItemKind;
  verbatimQuote: string; // the customer's OWN words (must appear in their inbound text)
}

/** A persisted action item on a lead, with its lifecycle. */
export interface StoredActionItem extends ActionItem {
  id: string; // stable hash of kind + normalized quote (dedupe key)
  openedAt: string; // first detected
  raisedAt: string | null; // timestamp of the customer inbound that raised it (for the resolution signal)
  resolvedAt: string | null; // set ONLY by a real signal (a later outbound); null = still open
}

interface AlertMemo {
  sig?: string;
  lastAlertedAt?: string;
}

interface LeadActionItemsState {
  items: StoredActionItem[];
  lastInboundAt?: string | null; // the newest customer inbound we extracted against (skip re-LLM if unchanged)
  alert?: AlertMemo;
}

// ── Config (env, safe defaults — tunable without a redeploy) ───────────────────────

function numEnv(name: string, def: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : def;
}

export const ACTION_ITEM_BOUNDS = {
  /** Max leads scanned per job run (LLM only fires on leads with a fresh inbound ask). */
  topN: () => numEnv("ACTION_ITEMS_TOP_N", 15),
  /** Self-throttle: the job's LLM pass runs at most once per this many minutes, even on a 15-min tick. */
  minIntervalMin: () => numEnv("ACTION_ITEMS_MIN_INTERVAL_MIN", 60),
  /** Max context entries handed to the LLM (newest-weighted). */
  contextEntries: () => numEnv("ACTION_ITEMS_CONTEXT_ENTRIES", 40),
  /** Max items the extractor may return for one lead (defensive cap). */
  maxItemsPerLead: () => numEnv("ACTION_ITEMS_MAX_PER_LEAD", 6),
};

/** Slack dedupe window — matches the repo's other alert producers' 2h cool-off. */
export const ACTION_ITEM_ALERT_COOLOFF_MS = 2 * 60 * 60 * 1000;

const STATE_PREFIX = "actionItems.lead.";
const JOB_STATE_KEY = "actionItems.job";

// ── Pure helpers (unit-tested; no DB / no clock) ──────────────────────────────────

const last10 = (p: string | null | undefined): string | null => {
  const d = (p ?? "").replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : null;
};

/** Normalize a string for the anti-fabrication substring check: lowercase, strip surrounding quotes,
 *  collapse all whitespace. Keeps the comparison robust to quote glyphs / spacing without being lax. */
export function normalizeForMatch(s: string): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/[‘’“”"'`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Stable dedupe id for an item: kind + the normalized quote. Same ask → same id across scans. */
export function itemId(kind: string, verbatimQuote: string): string {
  const basis = `${kind}::${normalizeForMatch(verbatimQuote)}`;
  let h = 0;
  for (let i = 0; i < basis.length; i++) h = (Math.imul(31, h) + basis.charCodeAt(i)) | 0;
  return `AI-${(h >>> 0).toString(36)}`;
}

/** PURE anti-fabrication guard: keep only items whose verbatim quote actually appears in the customer's
 *  inbound text (normalized substring), with a non-empty summary and a known kind. Short fragments (< 3
 *  chars) are rejected so a trivial match ("ok") can't smuggle a fabricated ask through. */
export function keepGroundedItems(items: ActionItem[], customerInboundText: string): ActionItem[] {
  const hay = normalizeForMatch(customerInboundText);
  const out: ActionItem[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    const quote = (it?.verbatimQuote ?? "").trim();
    const summary = (it?.summary ?? "").trim();
    const kind = (KINDS.has(it?.kind) ? it.kind : "other") as ActionItemKind;
    const nq = normalizeForMatch(quote);
    if (!summary || nq.length < 3) continue; // facts only: no summary or no real quote ⇒ drop
    if (!hay.includes(nq)) continue; // the customer never said this ⇒ drop (never invent an ask)
    const id = itemId(kind, quote);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ summary, kind, verbatimQuote: quote });
  }
  return out;
}

/** PURE. Merge freshly-extracted items into the stored set, preserving each existing item's openedAt +
 *  resolvedAt, and adding new ones as OPEN. Stored items missing from this extraction are LEFT as-is
 *  (an LLM dropping an item is not a hard signal — honest: never auto-clear without a real signal). */
export function mergeItems(
  stored: StoredActionItem[],
  extracted: ActionItem[],
  raisedAt: string | null,
  nowISO: string,
): StoredActionItem[] {
  const byId = new Map(stored.map((s) => [s.id, s]));
  for (const it of extracted) {
    const id = itemId(it.kind, it.verbatimQuote);
    const existing = byId.get(id);
    if (existing) {
      // Keep lifecycle; refresh the human-readable summary in case the model phrased it better.
      byId.set(id, { ...existing, summary: it.summary, verbatimQuote: it.verbatimQuote, kind: it.kind });
    } else {
      byId.set(id, { ...it, id, openedAt: nowISO, raisedAt, resolvedAt: null });
    }
  }
  return [...byId.values()];
}

/** PURE. Deterministic resolution: an OPEN item clears only when there is a real signal that a human
 *  engaged after the ask — here, an OUTBOUND message sent strictly after the item was raised. Items with
 *  no known raisedAt (we can't prove the ordering) are LEFT open. Returns the updated set + how many cleared. */
export function applyResolution(
  items: StoredActionItem[],
  latestOutboundAt: string | null,
  nowISO: string,
): { items: StoredActionItem[]; resolved: number } {
  const outMs = latestOutboundAt ? Date.parse(latestOutboundAt) : NaN;
  let resolved = 0;
  const next = items.map((it) => {
    if (it.resolvedAt) return it;
    const raised = it.raisedAt ? Date.parse(it.raisedAt) : NaN;
    if (Number.isFinite(outMs) && Number.isFinite(raised) && outMs > raised) {
      resolved++;
      return { ...it, resolvedAt: nowISO };
    }
    return it;
  });
  return { items: next, resolved };
}

/** PURE. Post iff there are open items AND (the open-set signature changed OR the cool-off elapsed). So an
 *  unchanged set stays quiet for 2h, but a newly-raised ask pages right away. Dedupe is per lead + item set. */
export function decideAlert(
  prev: AlertMemo | undefined,
  openItemIds: string[],
  now: number,
  cooloffMs: number = ACTION_ITEM_ALERT_COOLOFF_MS,
): { alert: boolean; next: AlertMemo } {
  if (openItemIds.length === 0) return { alert: false, next: prev ?? {} };
  const sig = [...openItemIds].sort().join(",");
  const sameSig = prev?.sig === sig;
  const agoMs = prev?.lastAlertedAt ? now - Date.parse(prev.lastAlertedAt) : Infinity;
  if (sameSig && agoMs <= cooloffMs) return { alert: false, next: prev ?? {} };
  return { alert: true, next: { sig, lastAlertedAt: new Date(now).toISOString() } };
}

/** PURE. Should the job's LLM pass run now, given the last run time + the minimum interval? */
export function decideThrottle(lastRunAt: string | undefined, now: number, minIntervalMs: number): boolean {
  if (!lastRunAt) return true;
  const parsed = Date.parse(lastRunAt);
  if (!Number.isFinite(parsed)) return true;
  return now - parsed >= minIntervalMs;
}

// ── Context gathering (DB reads; two-way so the model can tell an answered ask from an open one) ──

export interface CustomerContext {
  transcript: string; // chronological "Customer:/Zoe:" lines for the LLM
  customerInboundText: string; // every customer inbound body concatenated — the anti-fabrication haystack
  inboundCount: number; // number of customer inbound touches (0 ⇒ nothing to extract)
  latestInboundAt: string | null; // newest customer inbound timestamp (resolution + change detection)
}

interface Entry {
  at: string | null;
  who: "Customer" | "Zoe";
  text: string;
}

const clip = (s: string | null | undefined, n = 400): string => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/** Gather a lead's recent two-way conversation from every stored source: SMS + call summaries
 *  (comms_events), full call detail (call_events, matched by phone), and captured client emails
 *  (email_events). Customer = inbound; Zoe = outbound. Best-effort: a source read failing degrades that
 *  source, never the gather. */
export function gatherCustomerContext(bookingId: string, lead?: BookingView | null): CustomerContext {
  const b = lead ?? getBookingById(bookingId);
  const empty: CustomerContext = { transcript: "", customerInboundText: "", inboundCount: 0, latestInboundAt: null };
  if (!b) return empty;

  const entries: Entry[] = [];
  const inboundBodies: string[] = [];
  const inboundTimes: number[] = [];

  const pushInbound = (at: string | null, text: string) => {
    inboundBodies.push(text);
    const t = at ? Date.parse(at) : NaN;
    if (Number.isFinite(t)) inboundTimes.push(t);
  };

  try {
    for (const c of getCommsForLead(bookingId, 80)) {
      const text = clip(c.body);
      if (!text) continue;
      const at = c.occurredAt ?? c.ts;
      if (c.direction === "inbound") {
        entries.push({ at, who: "Customer", text });
        pushInbound(at, text);
      } else {
        entries.push({ at, who: "Zoe", text });
      }
    }
  } catch {
    /* source degraded; keep going */
  }

  try {
    const digits = last10(b.clientPhone);
    if (digits) {
      for (const ce of getCallEventsByPhoneDigits(digits, 60)) {
        const text = clip(ce.summary);
        if (!text) continue;
        const at = ce.occurredAt ?? ce.ts;
        // A call summary describes the whole call; an incoming call is the customer reaching us, so its
        // content is customer context for extraction. Outgoing = Zoe.
        if (ce.direction === "incoming") {
          entries.push({ at, who: "Customer", text: `(call) ${text}` });
          pushInbound(at, text);
        } else {
          entries.push({ at, who: "Zoe", text: `(call) ${text}` });
        }
      }
    }
  } catch {
    /* source degraded */
  }

  try {
    for (const em of getEmailEventsForLead(bookingId, 60)) {
      const text = clip([em.subject, em.snippet].filter(Boolean).join(" — "));
      if (!text) continue;
      const at = em.occurredAt ?? em.ts;
      if (em.direction === "inbound") {
        entries.push({ at, who: "Customer", text: `(email) ${text}` });
        pushInbound(at, text);
      } else if (em.direction === "outbound") {
        entries.push({ at, who: "Zoe", text: `(email) ${text}` });
      }
    }
  } catch {
    /* source degraded */
  }

  // Oldest → newest so the model reads the flow; cap to the newest N entries by char budget.
  const ms = (x: string | null) => (x ? Date.parse(x) : NaN);
  entries.sort((a, z) => {
    const ta = ms(a.at);
    const tz = ms(z.at);
    if (Number.isFinite(ta) && Number.isFinite(tz)) return ta - tz;
    if (Number.isFinite(ta)) return 1; // undated first (older)
    if (Number.isFinite(tz)) return -1;
    return 0;
  });
  const limited = entries.slice(-ACTION_ITEM_BOUNDS.contextEntries());
  const transcript = limited.map((e) => `${e.who}: ${e.text}`).join("\n");
  const latestInboundAt = inboundTimes.length ? new Date(Math.max(...inboundTimes)).toISOString() : null;

  return {
    transcript,
    customerInboundText: inboundBodies.join("\n"),
    inboundCount: inboundBodies.length,
    latestInboundAt,
  };
}

// ── Extraction (the ONE LLM interpretation step) ───────────────────────────────────

const SYSTEM_PROMPT =
  "You are a sales ops assistant for an event rentals company (Zoe). You read a two-way conversation " +
  "between a CUSTOMER and Zoe and extract the OPEN ACTION ITEMS the CUSTOMER raised that still need a " +
  "human response from Zoe. Count ONLY asks that a later Zoe message has NOT already clearly answered. " +
  "Kinds: contract_change (a request to change contract or terms, e.g. strike a paragraph), " +
  "pricing_question, product_question, scheduling (change a date/time/window), decision (the customer is " +
  "ready to commit or chose an option), objection (a concern that needs addressing), or other. " +
  "Rules: quote the customer's OWN words exactly in verbatimQuote (copy the text, do not paraphrase it); " +
  "never invent an ask; if there are no open customer asks, return an empty list. " +
  'Reply with STRICT JSON only: {"items":[{"summary":"...","kind":"...","verbatimQuote":"..."}]}.';

interface ExtractParsed {
  items?: { summary?: unknown; kind?: unknown; verbatimQuote?: unknown }[];
}

/** Run the LLM extraction over a gathered context and return GROUNDED items (anti-fabrication applied).
 *  Bounded (cheap model, small token budget), never throws: an unconfigured/unreachable LLM, an empty
 *  context, or an unparseable reply all yield []. */
export async function extractActionItems(ctx: CustomerContext): Promise<ActionItem[]> {
  if (!llmConfigured()) return [];
  if (ctx.inboundCount === 0 || !ctx.transcript.trim()) return [];
  try {
    const res = await chat(
      [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `Conversation (oldest first):\n${ctx.transcript}\n\nReturn the open customer action items as JSON.` },
      ],
      { json: true, temperature: 0, maxTokens: 700, timeoutMs: 30000 },
    );
    if (!res.ok || !res.text) return [];
    let parsed: ExtractParsed;
    try {
      parsed = JSON.parse(res.text) as ExtractParsed;
    } catch {
      // Some models wrap JSON in prose/fences — salvage the first {...} block.
      const m = res.text.match(/\{[\s\S]*\}/);
      if (!m) return [];
      parsed = JSON.parse(m[0]) as ExtractParsed;
    }
    const raw = Array.isArray(parsed.items) ? parsed.items : [];
    const shaped: ActionItem[] = raw.map((r) => ({
      summary: typeof r?.summary === "string" ? r.summary : "",
      kind: (typeof r?.kind === "string" && KINDS.has(r.kind) ? r.kind : "other") as ActionItemKind,
      verbatimQuote: typeof r?.verbatimQuote === "string" ? r.verbatimQuote : "",
    }));
    const grounded = keepGroundedItems(shaped, ctx.customerInboundText);
    return grounded.slice(0, ACTION_ITEM_BOUNDS.maxItemsPerLead());
  } catch {
    return [];
  }
}

// ── Persistence (kv — one small record per lead) ───────────────────────────────────

function leadStateKey(bookingId: string): string {
  return `${STATE_PREFIX}${bookingId}`;
}

/** The stored action items for a lead (open + resolved), newest-open first. Read-only; safe for the
 *  outreach context / UI to consult. Never throws. */
export function getLeadActionItems(bookingId: string): StoredActionItem[] {
  try {
    return getJson<LeadActionItemsState>(leadStateKey(bookingId), { items: [] }).items ?? [];
  } catch {
    return [];
  }
}

/** The OPEN (unresolved) action items for a lead. */
export function getOpenActionItems(bookingId: string): StoredActionItem[] {
  return getLeadActionItems(bookingId).filter((i) => !i.resolvedAt);
}

// ── Per-lead scan (sync → gather → extract → merge → resolve → surface) ─────────────

export interface ScanResult {
  ok: boolean;
  bookingId: string;
  open: number;
  added: number;
  resolved: number;
  alerted: boolean;
  skipped?: string;
}

const projectUrl = (id: string) => `https://pro.goodshuffle.com/app/project/detail?id=${id}`;

function slackConfiguredForSales(): boolean {
  // Sales transport = the Sales bot into sales-ai, with an ops-webhook fallback (notify("sales")). It can
  // deliver when EITHER the bot token or the ops webhook is set; with neither it degrades to a clean skip.
  return slackBotConfigured() || slackConfigured();
}

/** Scan ONE lead for open customer action items and surface them. Steps:
 *  1) ensureLeadThreadSynced — so detection runs on the CURRENT thread even if the periodic sync lags.
 *  2) gather the two-way context; 3) extract (LLM) unless the inbound hasn't changed since the last scan;
 *  4) merge into the stored set; 5) resolve any open item a later outbound answered; 6) Slack a deduped
 *  alert to the sales channel for the open set. DETECT + SURFACE ONLY — never replies. Never throws. */
export async function scanLeadActionItems(
  bookingId: string,
  opts: { now?: number; lead?: BookingView | null } = {},
): Promise<ScanResult> {
  const now = opts.now ?? Date.now();
  const nowISO = new Date(now).toISOString();
  const base: ScanResult = { ok: true, bookingId, open: 0, added: 0, resolved: 0, alerted: false };
  try {
    const lead = opts.lead ?? getBookingById(bookingId);
    if (!lead) return { ...base, ok: false, skipped: "unknown lead" };

    // 1) On-demand sync so we read the freshest two-way thread (Part 1 wrapper; key-gated, never throws).
    await ensureLeadThreadSynced(bookingId, lead.clientPhone);

    // 2) Gather.
    const ctx = gatherCustomerContext(bookingId, lead);

    const key = leadStateKey(bookingId);
    const state = getJson<LeadActionItemsState>(key, { items: [] });
    const before = state.items.filter((i) => !i.resolvedAt).length;

    // 3) Extract — skip the LLM when there's nothing new to read: no customer inbound at all, or the newest
    //    inbound is unchanged since our last extraction (saves tokens; resolution still runs below).
    const inboundUnchanged = state.lastInboundAt !== undefined && state.lastInboundAt === ctx.latestInboundAt;
    let extracted: ActionItem[] = [];
    if (ctx.inboundCount > 0 && !inboundUnchanged) {
      extracted = await extractActionItems(ctx);
    }

    // 4) Merge (preserves lifecycle; new asks open).
    let items = mergeItems(state.items, extracted, ctx.latestInboundAt, nowISO);

    // 5) Resolve — only on a real signal (a later outbound after the ask).
    const latestOutbound = getLatestOutboundForLead(bookingId);
    const { items: resolvedItems, resolved } = applyResolution(items, latestOutbound?.occurredAt ?? latestOutbound?.ts ?? null, nowISO);
    items = resolvedItems;

    const openItems = items.filter((i) => !i.resolvedAt);

    // 6) Surface — deduped Slack to the sales channel for the open set, as a Viktor-style Block Kit card
    //    (one section per open ask, the customer's verbatim words as a blockquote). Presentation only; the
    //    facts come straight from the open items (no content added), and no reply is ever sent here.
    const { alert, next } = decideAlert(state.alert, openItems.map((i) => i.id), now);
    let alerted = false;
    if (alert && openItems.length > 0 && slackConfiguredForSales()) {
      const card = buildActionItemCard({
        customer: lead.clientName?.trim() || "a customer",
        project: lead.eventName?.trim() || bookingId,
        projectUrl: projectUrl(bookingId),
        items: openItems,
        latestInboundAt: ctx.latestInboundAt,
        now,
      });
      const res = await notify("sales", card);
      alerted = res.ok;
    }

    // Persist (claim lastInboundAt so an unchanged thread won't re-pay the LLM next scan).
    setJson(key, { items, lastInboundAt: ctx.latestInboundAt, alert: alert ? next : state.alert });

    const added = Math.max(0, openItems.length - before + resolved);
    return { ...base, open: openItems.length, added, resolved, alerted };
  } catch {
    return { ...base, ok: false, skipped: "error" };
  }
}

// ── Runtime job (gated, bounded, self-throttled, outage-safe) ───────────────────────

/** The job gate: needs both the LLM (to interpret) and the OpenPhone key (the primary customer channel,
 *  and what feeds the on-demand sync). Mirrors the runtime-job `configured` contract. */
export function actionItemsConfigured(): boolean {
  return llmConfigured() && !!openphoneApiKey();
}

export interface ActionItemsJobResult {
  ok: boolean;
  detail: string;
}

/** Run the action-item scan across the active/open pipeline once. Bounded to the leads with the most
 *  recent customer contact (the LLM only fires where a customer actually said something), self-throttled
 *  so it runs at most once per the min interval even on a 15-min tick, and outage-safe (one lead failing
 *  never aborts the run; nothing ever throws into the tick). Returns a short detail for the import ledger. */
export async function runActionItemsJob(now: number = Date.now()): Promise<ActionItemsJobResult> {
  if (!actionItemsConfigured()) return { ok: true, detail: "not configured (LLM + OpenPhone key required)" };

  // Business-hours gate: surfacing a customer's open ask is a recommendation to a human to respond, so the
  // owner's rule holds it (and its Slack surface) outside business hours. Held BEFORE the throttle slot is
  // claimed, so nothing is dropped — the next in-hours tick re-scans and surfaces any still-open asks.
  const gate = businessHoursGate(new Date(now));
  if (!gate.open) return { ok: true, detail: gate.heldDetail };

  const job = getJson<{ lastRunAt?: string }>(JOB_STATE_KEY, {});
  if (!decideThrottle(job.lastRunAt, now, ACTION_ITEM_BOUNDS.minIntervalMin() * 60_000)) {
    return { ok: true, detail: `throttled (min interval ${ACTION_ITEM_BOUNDS.minIntervalMin()}m)` };
  }
  // Claim the slot immediately so an overlapping tick can't double-run the LLM work.
  setJson(JOB_STATE_KEY, { lastRunAt: new Date(now).toISOString() });

  let candidates: BookingView[];
  try {
    candidates = getOpenLeads(todayInOpsTz());
  } catch {
    return { ok: true, detail: "no open leads (read failed)" };
  }

  // Prioritize leads with the most recent customer contact; a lead with no inbound short-circuits before
  // the LLM inside scanLeadActionItems, so the cap is really "LLM budget for the busiest conversations".
  const ranked = candidates
    .map((b) => ({ b, lastComms: getLastCommsAt(b.bookingId) }))
    .sort((a, z) => (Date.parse(z.lastComms ?? "") || 0) - (Date.parse(a.lastComms ?? "") || 0))
    .slice(0, ACTION_ITEM_BOUNDS.topN());

  let scanned = 0;
  let open = 0;
  let added = 0;
  let resolved = 0;
  let alerted = 0;
  for (const { b } of ranked) {
    try {
      const r = await scanLeadActionItems(b.bookingId, { now, lead: b });
      scanned++;
      open += r.open;
      added += r.added;
      resolved += r.resolved;
      if (r.alerted) alerted++;
    } catch {
      // Best-effort: a single lead failing must never abort the rest of the run.
    }
  }

  return {
    ok: true,
    detail: `${scanned} lead${scanned === 1 ? "" : "s"} scanned, ${open} open item${open === 1 ? "" : "s"}, ${added} new, ${resolved} resolved, ${alerted} alerted`,
  };
}
