// Historical call import. Quo's /v1/calls needs a phoneNumberId AND one participant, so we can't
// list "all" calls — we crawl (each of our Quo numbers × each known lead/contact), page by page,
// inserting past calls + their transcripts/summaries into call_events so they show in Coaching.
// Batched with a durable cursor (KV) so it resumes across runs and never runs all at once.

import { insertCallEventIfNew, updateCallContent, listBookingPhones } from "@/lib/db/repo";
import { getOpenphonePhoneNumbers, listOpenphoneCalls, getOpenphoneContactMap, getCallTranscript, getCallSummary, type QuoCall } from "@/lib/comms/openphone";
import { getJson, setJson } from "@/lib/kv";

const KEY = "coaching.callImport";
const MAX_PAIRS_PER_RUN = 8; // (number × lead) pairs per request — kept low to respect Quo's rate limit
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ImportState {
  initialized: boolean;
  quoIds: string[];
  quoNumbers: string[];
  participants: string[]; // E.164
  pIdx: number; // participant index
  nIdx: number; // our-number index
  pageToken: string | null;
  done: boolean;
  imported: number;
  checked: number;
}

const EMPTY: ImportState = { initialized: false, quoIds: [], quoNumbers: [], participants: [], pIdx: 0, nIdx: 0, pageToken: null, done: false, imported: 0, checked: 0 };

function e164(p: string): string | null {
  const d = p.replace(/\D/g, "");
  if (d.length === 10) return "+1" + d;
  if (d.length === 11 && d.startsWith("1")) return "+" + d;
  if (p.trim().startsWith("+") && d.length >= 8) return "+" + d;
  return null;
}

async function insertHistoricalCall(call: QuoCall, ourNumber: string): Promise<boolean> {
  const customer = call.participants[0];
  if (!customer) return false;
  const fromPhone = call.direction === "outgoing" ? ourNumber : customer;
  const toPhone = call.direction === "outgoing" ? customer : ourNumber;
  const id = insertCallEventIfNew({
    providerId: call.id,
    eventType: "call.completed",
    direction: call.direction ?? undefined,
    fromPhone,
    toPhone,
    durationSec: call.durationSec,
    occurredAt: call.occurredAt,
  });
  if (!id) return false; // already have it (webhook or a prior run)
  const transcript = await getCallTranscript(call.id);
  const summary = await getCallSummary(call.id);
  updateCallContent(id, { transcript, summary, durationSec: call.durationSec, eventType: "call.completed" });
  return true;
}

export interface ImportStep {
  done: boolean;
  imported: number;
  checked: number;
  total: number;
  phase: "init" | "crawl" | "done" | "unconfigured";
}

/** Advance the crawl by one bounded batch. The client loops this until `done`. */
export async function importHistoryStep(): Promise<ImportStep> {
  let s = getJson<ImportState>(KEY, EMPTY);

  if (!s.initialized) {
    const quo = await getOpenphonePhoneNumbers();
    // Leads to crawl: our booking phones + everyone in the Quo address book, de-duped by digits.
    const byDigits = new Map<string, string>();
    for (const p of listBookingPhones()) {
      const e = e164(p);
      if (e) byDigits.set(e.replace(/\D/g, "").slice(-10), e);
    }
    for (const d of (await getOpenphoneContactMap()).keys()) {
      if (!byDigits.has(d)) byDigits.set(d, "+1" + d);
    }
    const participants = [...byDigits.values()];
    s = { ...EMPTY, initialized: true, quoIds: quo.map((q) => q.id), quoNumbers: quo.map((q) => q.number), participants, done: quo.length === 0 || participants.length === 0 };
    setJson(KEY, s);
    return { done: s.done, imported: 0, checked: 0, total: participants.length, phase: s.done ? "unconfigured" : "init" };
  }

  if (s.done) return { done: true, imported: 0, checked: s.checked, total: s.participants.length, phase: "done" };

  let importedThisRun = 0;
  for (let i = 0; i < MAX_PAIRS_PER_RUN && !s.done; i++) {
    if (i > 0) await sleep(120); // stay comfortably under the API rate limit
    const participant = s.participants[s.pIdx];
    const quoId = s.quoIds[s.nIdx];
    const ourNumber = s.quoNumbers[s.nIdx];
    const { calls, nextPageToken } = await listOpenphoneCalls(quoId, participant, s.pageToken);
    s.checked++;
    for (const call of calls) {
      if (await insertHistoricalCall(call, ourNumber)) importedThisRun++;
    }
    // Advance: next page of this pair, else next (number × lead) pair, else done.
    if (nextPageToken) {
      s.pageToken = nextPageToken;
    } else {
      s.pageToken = null;
      s.nIdx++;
      if (s.nIdx >= s.quoIds.length) {
        s.nIdx = 0;
        s.pIdx++;
        if (s.pIdx >= s.participants.length) s.done = true;
      }
    }
    if (calls.length > 0) break; // did real work (transcript fetches) — yield to keep the run short
  }

  s.imported += importedThisRun;
  setJson(KEY, s);
  return { done: s.done, imported: importedThisRun, checked: s.checked, total: s.participants.length, phase: s.done ? "done" : "crawl" };
}
