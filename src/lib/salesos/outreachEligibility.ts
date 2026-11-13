// Hard gate for automated and bulk outreach. Owner call (2026-11-13), after the morning outreach texted
// archived 2023 quotes: never text or email a project that is archived, marked lost / cancelled / dead, has
// no event date, or whose event date has passed. No cadence, override or drafter result gets past this.
//
// Why it is needed: the open-quote list only kept old quotes out by their PAST event date. When a pull blanked
// event dates (Goodshuffle renamed its date fields, Nov 2026), archived 2023 quotes looked like open quotes
// with no date and went out on the no-date cadence. Archived is now checked directly, and a missing date
// holds instead of sending.

export type OutreachBlockKind = "archived" | "closed" | "no_date" | "past_event";

export interface OutreachBlock {
  kind: OutreachBlockKind;
  reason: string;
}

export interface OutreachProject {
  archived?: boolean | number | null;
  statusLabel?: string | null;
  eventDate?: string | null; // YYYY-MM-DD
}

const CLOSED_RE = /lost|cancel|dead/i;

/** Why this project must not get automated or bulk outreach, or null when it may. `todayYmd` is Eastern. */
export function outreachBlock(p: OutreachProject, todayYmd: string): OutreachBlock | null {
  if (p.archived === true || p.archived === 1) return { kind: "archived", reason: "The project is archived in Goodshuffle." };
  const label = (p.statusLabel ?? "").trim();
  if (CLOSED_RE.test(label)) return { kind: "closed", reason: `The project is marked ${label} in Goodshuffle.` };
  const date = (p.eventDate ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { kind: "no_date", reason: "No event date on the project, a person should check it." };
  if (date < todayYmd) return { kind: "past_event", reason: `The event date (${date}) has passed.` };
  return null;
}
