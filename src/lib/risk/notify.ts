// Event Risk Slack update: post only changes a person should act on, once, and readably.
//
// Why this exists: the scan used to post every Regressed/Resolved transition the moment it saw it. When two
// scans a few minutes apart read different data (e.g. a Connecteam read that failed), the same 20 items went
// "Regressed" then "Resolved" every hour, in walls of text. Three rules fix the noise:
//  1. SETTLE: a Regressed/Resolved change is held until a LATER scan confirms it. If it flips back first, the
//     pair cancels and nothing is posted. (New and escalated HIGH/CRITICAL risks still post right away.)
//  2. IMPORTANT ONLY: Regressed/Resolved post only for HIGH/CRITICAL risks, the same bar as new risks.
//     Everything else stays on /risk. "Couldn't be verified" items never post (they are data gaps, not risks).
//  3. READABLE: one line per item, grouped under its day, no repeated date, capped with a link to /risk.

import type { RiskChanges, StoredRisk } from "./store";
import { formatYmdLong } from "@/lib/dates";

export type PendingKind = "regressed" | "resolved";
export interface PendingTransition {
  kind: PendingKind;
  title: string;
  date?: string;
  severity: string;
  /** ISO time of the scan that first saw this transition. */
  firstAt: string;
}
export type PendingMap = Record<string, PendingTransition>;

const IMPORTANT = new Set(["HIGH", "CRITICAL"]);
const UNVERIFIED_TYPES = new Set(["staffing_unverified", "route_schedule_unverified"]);

/** A risk worth a Slack line at all (severity bar + never the "couldn't verify" data gaps). */
export function isAnnounceable(r: Pick<StoredRisk, "severity" | "riskType">): boolean {
  return IMPORTANT.has(r.severity) && !UNVERIFIED_TYPES.has(r.riskType);
}

/**
 * Fold this scan's Regressed/Resolved changes into the pending map and return the ones a previous scan
 * already saw that have now held (ready to post). Pure.
 *  - a change opposite to a pending one cancels it (it flipped back: net nothing happened)
 *  - a new change waits for the next scan
 *  - a pending one from an earlier scan that wasn't cancelled is ready
 *  - entries for days already past are dropped
 */
export function settleTransitions(
  pending: PendingMap,
  changes: Pick<RiskChanges, "regressed" | "resolved">,
  nowIso: string,
  today: string,
): { pending: PendingMap; ready: (PendingTransition & { signature: string })[] } {
  const next: PendingMap = {};
  for (const [sig, p] of Object.entries(pending)) if (!p.date || p.date >= today) next[sig] = p;

  const fold = (r: StoredRisk, kind: PendingKind) => {
    if (UNVERIFIED_TYPES.has(r.riskType)) return;
    const prev = next[r.signature];
    if (prev && prev.kind !== kind) {
      delete next[r.signature]; // flipped back before anyone was told: cancel both
      return;
    }
    if (prev) return; // same transition seen again; keep the original time
    // Severity bar: a regression needs its current severity to matter; a resolution is judged by the
    // severity it had while open (stored on the row).
    if (!IMPORTANT.has(r.severity)) return;
    next[r.signature] = { kind, title: r.title, date: r.date, severity: r.severity, firstAt: nowIso };
  };
  for (const r of changes.regressed) fold(r, "regressed");
  for (const r of changes.resolved) fold(r, "resolved");

  const ready: (PendingTransition & { signature: string })[] = [];
  for (const [sig, p] of Object.entries(next)) {
    if (p.firstAt >= nowIso) continue; // first seen this scan: wait for a later scan to confirm it
    ready.push({ signature: sig, ...p });
    delete next[sig];
  }
  return { pending: next, ready };
}

/** "Not enough drivers scheduled (2026-11-06)" -> "Not enough drivers scheduled";
 *  "Driver not scheduled — Joseph Hewitt" -> "Driver not scheduled: Joseph Hewitt". */
export function cleanTitle(title: string, date?: string): string {
  let t = title;
  if (date) t = t.replace(` (${date})`, "");
  return t.replace(/\s+[—–-]\s+/g, ": ").trim();
}

export interface UpdateLine {
  kind: "new" | "worse" | "back" | "fixed";
  title: string;
  date?: string;
  severity?: string;
  from?: string;
}

const KIND_ORDER: Record<UpdateLine["kind"], number> = { new: 0, worse: 1, back: 2, fixed: 3 };
const KIND_WORD: Record<UpdateLine["kind"], string> = { new: "New", worse: "Worse", back: "Back", fixed: "Fixed" };
const sevWord = (s?: string) => (s ? s.toLowerCase() : "");

/** Render the Slack text: grouped by day (soonest first), action items before fixes, capped. Null when empty. */
export function formatRiskUpdate(lines: UpdateLine[], cap = 12): string | null {
  if (lines.length === 0) return null;
  const sorted = [...lines].sort(
    (a, b) => (a.date ?? "9999").localeCompare(b.date ?? "9999") || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.title.localeCompare(b.title),
  );
  const shown = sorted.slice(0, cap);
  const out: string[] = ["🧭 *Event Risk update*"];
  let day: string | undefined | null = null;
  for (const l of shown) {
    if (l.date !== day) {
      day = l.date;
      out.push(`*${l.date ? formatYmdLong(l.date) : "No date"}*`);
    }
    const label = cleanTitle(l.title, l.date);
    const sev =
      l.kind === "worse" && l.from ? ` (${sevWord(l.from)} to ${sevWord(l.severity)})` : l.kind === "fixed" ? "" : l.severity ? ` (${sevWord(l.severity)})` : "";
    out.push(`• ${KIND_WORD[l.kind]}: ${label}${sev}`);
  }
  if (sorted.length > cap) out.push(`…and ${sorted.length - cap} more on /risk`);
  return out.join("\n");
}

/** Build the lines for one scan: new + escalated post now (important only); back/fixed only once settled. */
export function updateLines(c: RiskChanges, ready: (PendingTransition & { signature: string })[]): UpdateLine[] {
  const lines: UpdateLine[] = [];
  for (const r of c.created) if (isAnnounceable(r)) lines.push({ kind: "new", title: r.title, date: r.date, severity: r.severity });
  for (const e of c.escalated)
    if (isAnnounceable(e.risk)) lines.push({ kind: "worse", title: e.risk.title, date: e.risk.date, severity: e.to, from: e.from });
  for (const p of ready) lines.push({ kind: p.kind === "regressed" ? "back" : "fixed", title: p.title, date: p.date, severity: p.severity });
  return lines;
}
