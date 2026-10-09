// Touchpoint → Goodshuffle note sync. Every customer touchpoint the app knows about — a call (Quo/
// OpenPhone), an outbound text, an outbound email — gets an honest, factual one-line entry appended to
// the matching project's INTERNAL notes in Goodshuffle, so the sales team never has to hand-log "I
// reached out." The motivating case: a rep made a call but forgot to log that she reached out.
//
// How the write actually happens: the server can't call Goodshuffle directly (Cloudflare blocks
// datacenter IPs), so this QUEUES a `note_append` gs_outbox op. The office Auto-Pull session (a logged-in
// pro.goodshuffle.com tab — src/lib/gsPull.ts / extension/pull-injected.js) drains it: it reads the
// project's current notes via initContractView, APPENDS our line to `internalNotes` (leaving
// `clientVisibleNotes` — the client-facing field — untouched), and saves via saveEventNotes. So these
// entries are staff-only and never visible to the client.
//
// HONEST BY DESIGN:
//   • Gated by GS_NOTE_SYNC_ENABLED (default OFF / unset) — dormant until the owner turns it on after
//     validating on the TEST 1/2/3 sandbox projects. When off, nothing is enqueued. No surprise writes.
//   • Only writes when we matched the touchpoint to a project (transactionId). No match → no note (the
//     caller records the skip honestly); we NEVER attach a note to the wrong project.
//   • Idempotent: one note per touchpoint, keyed on the call id / message id / a per-email key, so a
//     retried send or a repeated webhook event never double-logs.
//   • Names the rep by their real initials; when we genuinely don't know who, it says "Zoe team" rather
//     than fabricating a person.

import { createHash } from "node:crypto";
import { enqueueGsOp, gsNoteOpExists } from "@/lib/db/repo";
import { shortDate } from "@/lib/salesos/noteFormat";

/** Master switch. Unset/anything-but-"true" ⇒ the whole feature is dormant (same convention as
 *  SMS_SEND_ENABLED / EMAIL_SEND_ENABLED). */
export function noteSyncEnabled(): boolean {
  return process.env.GS_NOTE_SYNC_ENABLED === "true";
}

export type CallOutcome = "conversation" | "voicemail_left" | "voicemail_received";

export interface CallTouchpoint {
  kind: "call";
  callId: string; // Quo/OpenPhone call id — the idempotency key
  transactionId: string; // matched Goodshuffle project id
  repInitials: string | null; // who handled the call (null ⇒ "Zoe team")
  clientName?: string | null;
  direction: "incoming" | "outgoing" | null;
  outcome: CallOutcome;
  summary?: string | null; // OpenPhone AI summary, when it was a real conversation
  dateYmd: string; // YYYY-MM-DD in the operating timezone
}

export interface TextTouchpoint {
  kind: "text";
  messageId: string; // provider message id (or a deterministic fallback) — the idempotency key
  transactionId: string;
  repInitials: string | null;
  clientName?: string | null;
  snippet: string; // the outbound text body (clamped in the note)
  dateYmd: string;
}

export interface EmailTouchpoint {
  kind: "email";
  emailKey: string; // stable per-send key (lead id + subject/content hash) — the idempotency key
  transactionId: string;
  repInitials: string | null;
  clientName?: string | null;
  subject?: string | null;
  dateYmd: string;
}

export type Touchpoint = CallTouchpoint | TextTouchpoint | EmailTouchpoint;

/** A short stable hash — used to build a per-send idempotency key when there's no provider id yet. */
export function shortHash(s: string): string {
  return createHash("sha1").update(s).digest("hex").slice(0, 16);
}

/** Collapse whitespace to a single line and cap length (…-truncated) so a note stays one clean line. */
function clamp(s: string, max: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
}

/** The rep token for the note: real initials, or an honest "Zoe team" when we don't know who. */
function actorToken(repInitials: string | null): string {
  return (repInitials ?? "").trim() || "Zoe team";
}

function clientToken(clientName?: string | null): string {
  return (clientName ?? "").trim() || "the client";
}

/** The factual "what happened" clause for each touchpoint type. */
function touchpointBody(t: Touchpoint): string {
  const who = clientToken(t.clientName);
  if (t.kind === "call") {
    if (t.outcome === "voicemail_left") return `called ${who}, left voicemail`;
    if (t.outcome === "voicemail_received") return `voicemail from ${who}`;
    // conversation
    const verb = t.direction === "incoming" ? "spoke with" : "called";
    const sum = (t.summary ?? "").trim();
    return sum ? `${verb} ${who} — ${clamp(sum, 180)}` : `${verb} ${who}`;
  }
  if (t.kind === "text") {
    const snip = (t.snippet ?? "").trim();
    return snip ? `texted ${who}: "${clamp(snip, 80)}"` : `texted ${who}`;
  }
  // email
  const subj = (t.subject ?? "").trim();
  return subj ? `emailed ${who} (subject: ${clamp(subj, 80)})` : `emailed ${who}`;
}

/** Build the internal-note line in the team's house style: `M/D - <initials> <what happened>`.
 *  e.g. `10/9 - JM called the client, left voicemail` / `10/9 - Zoe team texted the client: "…"`. Pure. */
export function composeTouchpointNote(t: Touchpoint): string {
  return `${shortDate(t.dateYmd)} - ${actorToken(t.repInitials)} ${touchpointBody(t)}`;
}

/** The idempotency key for a touchpoint — one note per real call/text/email, ever. Pure. */
export function touchpointDedupeKey(t: Touchpoint): string {
  switch (t.kind) {
    case "call":
      return `call:${t.callId}`;
    case "text":
      return `sms:${t.messageId}`;
    case "email":
      return `email:${t.emailKey}`;
  }
}

export interface NoteSyncResult {
  enqueued: boolean;
  /** Why we did NOT enqueue (honest audit): "disabled" | "no project match" | "duplicate". */
  skipped?: string;
}

/** Queue a touchpoint note for the office pull to write into the project's internal notes — gated,
 *  matched, idempotent. Reuses the existing `note_append` gs_outbox op + drainer (no new GS plumbing).
 *  Returns what it did so the caller can record the outcome honestly. Never throws on logic paths. */
export function syncTouchpointNote(t: Touchpoint): NoteSyncResult {
  if (!noteSyncEnabled()) return { enqueued: false, skipped: "disabled" };
  if (!t.transactionId) return { enqueued: false, skipped: "no project match" };

  const dedupeKey = touchpointDedupeKey(t);
  if (gsNoteOpExists(dedupeKey)) return { enqueued: false, skipped: "duplicate" };

  const line = composeTouchpointNote(t);
  enqueueGsOp({
    op: "note_append",
    transactionId: t.transactionId,
    label: `${t.kind} logged`,
    payload: { line, dedupeKey },
  });
  return { enqueued: true };
}
