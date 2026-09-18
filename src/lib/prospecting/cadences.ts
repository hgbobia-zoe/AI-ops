// Prospecting — cadence templates (the SDR/BDR playbook). Deterministic multi-touch sequences per tier,
// mirroring how top sales orgs run outreach: multi-channel (call + email + LinkedIn), spaced over ~2
// weeks, ending in a "breakup". Tier A is call-first and high-touch; Tier B is email-led volume. Steps
// are materialized into dated tasks at enrollment. Copy for each email is drafted separately.

import type { Cadence, Tier } from "./types";

// Tier A — call-first, high-touch. For big-ticket / awarded / warm opportunities where a human beats a
// blast. ~6 touches over 14 days, multi-threaded.
export const CADENCE_A: Cadence = {
  key: "tierA-call-first-v1",
  tier: "A",
  name: "Call-first (high-value)",
  description: "Phone-led, multi-channel, 14 days. Best for high-value, awarded, or existing-relationship opportunities.",
  steps: [
    { day: 0, channel: "call", label: "Call + voicemail", note: "Reference the specific event/solicitation. If no answer, leave a 20-second voicemail." },
    { day: 0, channel: "email", label: "1:1 intro email", note: "Personalized, references the same event. Not a template blast." },
    { day: 2, channel: "call", label: "Second call", note: "Different time of day." },
    { day: 4, channel: "email", label: "Value email", note: "Short, one relevant proof point (a similar DMV event)." },
    { day: 7, channel: "linkedin", label: "LinkedIn connect + note", note: "Connect with the target; reference the event." },
    { day: 10, channel: "call", label: "Third call", note: "Ask directly who handles rentals for this." },
    { day: 14, channel: "email", label: "Breakup email", note: "Polite close-the-loop; leaves the door open." },
  ],
};

// Tier B — email-led sequence, one call. ~4 emails + 1 call over 12 days, for qualified but not
// call-worthy volume. Runs from a separate warmed domain via the sequencer.
export const CADENCE_B: Cadence = {
  key: "tierB-email-sequence-v1",
  tier: "B",
  name: "Email sequence",
  description: "Email-led, one call, 12 days. Best for qualified volume; run from a warmed cold-email domain.",
  steps: [
    { day: 0, channel: "email", label: "Intro email", note: "Concise, references the event; clear CTA." },
    { day: 3, channel: "email", label: "Follow-up email", note: "Bump with a one-line value add." },
    { day: 6, channel: "call", label: "Call attempt", note: "One human touch mid-sequence." },
    { day: 9, channel: "email", label: "Case-study email", note: "Relevant proof point." },
    { day: 12, channel: "email", label: "Breakup email", note: "Close the loop." },
  ],
};

export const CADENCES: Cadence[] = [CADENCE_A, CADENCE_B];

export function defaultCadenceForTier(tier: Tier): Cadence | null {
  if (tier === "A") return CADENCE_A;
  if (tier === "B") return CADENCE_B;
  return null; // Tier C is monitor-only — no cadence
}

export function getCadence(key: string): Cadence | null {
  return CADENCES.find((c) => c.key === key) ?? null;
}
