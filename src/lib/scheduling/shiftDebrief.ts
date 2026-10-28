// Shift debrief → Connecteam shift note (pure). Renders the operational debrief for a route shift from the
// SAME structured facts the shift packet uses (route stops, equipment, crew, premium/readiness callouts) —
// NO LLM, no new fact source (rules calculate). The text is written INTO the Connecteam shift's note field
// so the crew sees it in the Connecteam app, alongside the existing SMS debrief (which is unchanged).
//
// MANAGED BLOCK: the generated text is wrapped in markers so a later update can replace ONLY our block and
// leave any manually-typed Connecteam note intact. mergeManagedNote is the safe-merge primitive.
//
// House style (comms-no-dashes): no em-dashes, no emoji, short and natural. Stops are numbered, labels use
// colons, nothing uses a leading dash.

import { formatYmdLong, formatClockTime } from "@/lib/dates";

/** Markers that fence the app-generated block inside a (possibly hand-edited) Connecteam note. */
export const DEBRIEF_MARK_BEGIN = "[Zoe Dispatch route brief - auto]";
export const DEBRIEF_MARK_END = "[end Zoe Dispatch brief]";

export interface ShiftDebriefStop {
  kind: "delivery" | "pickup" | "stop";
  customer: string;
  address?: string | null;
  window?: string | null; // ISO or free text; rendered to ET clock when ISO
  items?: string[]; // equipment / line-item names that matter for load + setup
}

/** Everything the note needs, assembled by the caller from the route + shift (structured, no guesses). */
export interface ShiftDebriefContext {
  roleLabel: string;
  date: string; // YYYY-MM-DD
  startTime: string | null;
  endTime: string | null;
  truck: string | null;
  crew: string[]; // coworker display labels ("Name (role)")
  stops: ShiftDebriefStop[];
  equipment: string[];
  /** Customers on the route who bought a premium / exact-time arrival window. */
  premiumCustomers: string[];
  /** Customers on the route with Event Readiness Service (plan setup time). */
  eventReadinessCustomers: string[];
  /** Free-text operational instructions already on the shift, if any. */
  instructions?: string | null;
  /** Access restrictions / site notes (gate codes, loading-dock hours, COI, etc.) when known. */
  accessNotes?: string[];
}

function clock(v: string | null | undefined): string {
  if (!v || !v.trim()) return "TBD";
  const f = formatClockTime(v);
  return f && f !== v.trim() ? `${f} ET` : f;
}

function listOr(names: string[], joiner = ", "): string {
  return names.length ? names.join(joiner) : "";
}

/** Render the debrief BODY (no markers). Deterministic; only includes a section when it has content. */
export function buildShiftDebriefBody(ctx: ShiftDebriefContext): string {
  const lines: string[] = [];
  lines.push(`Role: ${ctx.roleLabel}`);
  lines.push(`Date: ${formatYmdLong(ctx.date)}`);
  const window = ctx.startTime || ctx.endTime ? `${clock(ctx.startTime)} to ${clock(ctx.endTime)}` : "TBD";
  lines.push(`Window: ${window}`);
  if (ctx.truck) lines.push(`Truck: ${ctx.truck}`);
  if (ctx.crew.length) lines.push(`Crew: ${listOr(ctx.crew)}`);

  if (ctx.stops.length) {
    lines.push("");
    lines.push(`Stops (${ctx.stops.length}):`);
    ctx.stops.forEach((s, i) => {
      const kind = s.kind === "delivery" ? "Delivery" : s.kind === "pickup" ? "Pickup" : "Stop";
      const when = s.window ? ` at ${clock(s.window)}` : "";
      const where = s.address ? `, ${s.address}` : "";
      lines.push(`${i + 1}. ${kind}: ${s.customer}${where}${when}`);
      if (s.items && s.items.length) lines.push(`   Items: ${s.items.join(", ")}`);
    });
  }

  if (ctx.equipment.length) {
    lines.push("");
    lines.push(`Equipment and install: ${listOr(ctx.equipment)}`);
  }
  if (ctx.premiumCustomers.length) {
    lines.push("");
    lines.push(
      `Time sensitive stops with a guaranteed arrival window the customer paid for: ${listOr(ctx.premiumCustomers)}. Mind arrival and departure times.`,
    );
  }
  if (ctx.eventReadinessCustomers.length) {
    lines.push("");
    lines.push(`Event Readiness Service booked for: ${listOr(ctx.eventReadinessCustomers)}. Build in setup time.`);
  }
  if (ctx.accessNotes && ctx.accessNotes.length) {
    lines.push("");
    lines.push("Access and site notes:");
    ctx.accessNotes.forEach((n) => lines.push(`   ${n}`));
  }
  if (ctx.instructions && ctx.instructions.trim()) {
    lines.push("");
    lines.push(`Notes: ${ctx.instructions.trim()}`);
  }
  return lines.join("\n");
}

/** Fence a body in the managed markers. */
export function wrapManaged(body: string): string {
  return `${DEBRIEF_MARK_BEGIN}\n${body}\n${DEBRIEF_MARK_END}`;
}

/** The full managed note block for a context (markers + body). */
export function buildShiftDebriefNote(ctx: ShiftDebriefContext): string {
  return wrapManaged(buildShiftDebriefBody(ctx));
}

/** A stable content hash of a note body, for idempotent "only update on a material change" dedupe. */
export function debriefHash(body: string): string {
  let h = 0;
  for (let i = 0; i < body.length; i++) {
    h = (Math.imul(31, h) + body.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

/**
 * Merge a freshly-generated managed block into an existing Connecteam note, PRESERVING any text the user
 * typed outside our markers. If the existing note has our block, replace just that block in place; otherwise
 * append the block after the manual text. An empty/absent existing note yields the block alone. This is the
 * primitive that keeps us from clobbering manual notes — it is only SAFE to use when we can actually READ
 * the current note back from Connecteam (see shiftDebriefSync for why updates are gated).
 */
export function mergeManagedNote(existing: string | null | undefined, managedBlock: string): string {
  const current = (existing ?? "").replace(/\r\n/g, "\n");
  if (!current.trim()) return managedBlock;
  const begin = current.indexOf(DEBRIEF_MARK_BEGIN);
  const end = current.indexOf(DEBRIEF_MARK_END);
  if (begin !== -1 && end !== -1 && end > begin) {
    const before = current.slice(0, begin).replace(/\s+$/, "");
    const after = current.slice(end + DEBRIEF_MARK_END.length).replace(/^\s+/, "");
    return [before, managedBlock, after].filter((p) => p.length > 0).join("\n\n");
  }
  // No managed block yet: keep the manual note, append ours below it.
  return `${current.replace(/\s+$/, "")}\n\n${managedBlock}`;
}

/** The manual (non-managed) portion of an existing note, for tests / inspection. */
export function manualPortion(existing: string | null | undefined): string {
  const current = (existing ?? "").replace(/\r\n/g, "\n");
  const begin = current.indexOf(DEBRIEF_MARK_BEGIN);
  const end = current.indexOf(DEBRIEF_MARK_END);
  if (begin !== -1 && end !== -1 && end > begin) {
    const before = current.slice(0, begin).replace(/\s+$/, "");
    const after = current.slice(end + DEBRIEF_MARK_END.length).replace(/^\s+/, "");
    return [before, after].filter((p) => p.length > 0).join("\n\n");
  }
  return current.trim();
}
