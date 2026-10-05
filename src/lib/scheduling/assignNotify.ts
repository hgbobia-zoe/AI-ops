// Assignment notifications — the DETERMINISTIC worker-facing text a dispatcher sends when a team member
// is put on, or taken off, a route. RULES CALCULATE, AI INTERPRETS: these are plain templates, never an
// LLM. House comms style (comms-no-dashes memory rule): no dashes, no emoji, short, natural. A field we
// don't actually know is OMITTED (never fabricated — no invented report time or location).
//
// This module is pure + client-safe (no server imports), so the confirm UI and the /notify endpoint share
// the same types + builder.

import type { ShiftRole } from "./types";

export type AssignNoticeKind = "assigned" | "removed";

/** The minimal reference the UI passes around: which worker, which shift, which direction. */
export interface NotifyNotice {
  shiftId: string;
  userId: number;
  kind: AssignNoticeKind;
}

/** A dry-run preview row the endpoint returns (recipient + drafted text + whether it can actually send). */
export interface NotifyDryRunRow {
  shiftId: string;
  userId: number;
  kind: AssignNoticeKind;
  name: string;
  phoneMasked: string;
  body: string;
  sendable: boolean;
  reason?: string;
}

/** The honest per-notice outcome after a real send. Never "sent" unless the provider returned ok. */
export interface NotifySendResult {
  shiftId: string;
  userId: number;
  kind: AssignNoticeKind;
  state: "sent" | "skipped" | "failed";
  reason?: string;
}

export interface AssignNoticeInput {
  kind: AssignNoticeKind;
  firstName: string;
  roleLabel: string; // worker-friendly role word: "driver" | "field crew" | "warehouse prep"
  dateHuman: string; // e.g. "Wed, Oct 8"
  routeLabel?: string | null; // truck / event label — omitted when unknown
  windowText?: string | null; // e.g. "7:00 AM to 3:00 PM" — omitted when the window is unknown
}

/** Worker-friendly role word for a message (distinct from the board's Driver/Field/Prep chips). */
export function roleLabelForWorker(role: ShiftRole): string {
  switch (role) {
    case "driver":
      return "driver";
    case "field":
      return "field crew";
    case "prep":
      return "warehouse prep";
    default:
      return "a shift";
  }
}

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * The deterministic notice text. Pure: same inputs, same string. Unknown optional fields are omitted
 * rather than guessed, so a worker never gets a fabricated route or time.
 */
export function buildAssignmentNotice(input: AssignNoticeInput): string {
  const first = (input.firstName || "").trim() || "there";
  const role = (input.roleLabel || "").trim() || "a shift";
  const date = (input.dateHuman || "").trim();
  const route = input.routeLabel && input.routeLabel.trim() ? input.routeLabel.trim() : null;
  const win = input.windowText && input.windowText.trim() ? input.windowText.trim() : null;

  if (input.kind === "assigned") {
    let s = `Hi ${first}, you're on the Zoe Events schedule for ${role}`;
    if (date) s += ` on ${date}`;
    if (route) s += `, ${route}`;
    if (win) s += ` ${win}`;
    s += ". Reply here with any questions.";
    return collapse(s);
  }

  let s = `Hi ${first}, update from Zoe Events: you're no longer scheduled for ${role}`;
  if (date) s += ` on ${date}`;
  if (route) s += ` (${route})`;
  s += ". Thanks.";
  return collapse(s);
}

/** Mask a phone for the confirm preview: keep the last 4 digits, hide the rest. Never shows a full number. */
export function maskPhone(raw: string | null | undefined): string {
  const digits = (raw || "").replace(/\D/g, "");
  if (digits.length < 4) return raw ? "on file" : "";
  return `••• ••• ${digits.slice(-4)}`;
}
