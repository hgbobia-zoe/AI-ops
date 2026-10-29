// Sales OS lead-status → shared Nocturne status vocabulary. Client-safe (no DB/server imports), so the
// Board, Table and Worklist all render a lead's board status through the ONE shared StatusBadge the rest
// of the console uses (coloured indicator + crisp label; colour on the icon, never the label/number).
//
// The TONE is the lead's meaning, not a new colour: a lead that needs action is critical, one waiting on
// the customer is info/neutral, a win is positive. Icons are the lead-pipeline shapes (a quote going out,
// a follow-up clock, a signed check) layered over the shared StatusBadge — meaning survives greyscale.

import { Sparkles, Send, Clock, AlertTriangle, CheckCircle2, Archive, type LucideIcon } from "lucide-react";
import type { Tone } from "@/lib/tone";
import type { LeadStatus } from "./boardTypes";

/** Tone per board status — drives the StatusBadge indicator colour. */
export const SALES_STATUS_TONE: Record<LeadStatus, Tone> = {
  new: "info", // in the funnel, needs a first touch
  quote_sent: "info", // sent, waiting on the customer
  follow_up: "attention", // gone quiet past the follow-up window
  action_needed: "critical", // the customer is waiting on us / time-critical
  signed: "positive", // won
  archived: "neutral", // off the board (lost / cancelled)
};

/** Pipeline-shaped icon per status (overrides StatusBadge's generic tone icon). */
export const SALES_STATUS_ICON: Record<LeadStatus, LucideIcon> = {
  new: Sparkles,
  quote_sent: Send,
  follow_up: Clock,
  action_needed: AlertTriangle,
  signed: CheckCircle2,
  archived: Archive,
};
