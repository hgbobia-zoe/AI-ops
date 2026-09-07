// Decide what (if anything) to log to Goodshuffle for a call event. The rule the owner asked for:
//   • a real CONVERSATION → log the summary  (OpenPhone only summarizes actual conversations)
//   • a VOICEMAIL / no-answer → just note that, no summary
//   • an answered call with no summary yet → nothing (wait for the summary event)

export interface CallNoteInput {
  eventType: string; // OpenPhone webhook type
  direction: string | null; // "incoming" | "outgoing"
  durationSec: number | null;
  summary: string | null; // present only for real conversations
}

/** Returns the note comment to append, or null to log nothing for this event. */
export function decideCallNote(c: CallNoteInput): string | null {
  const summary = (c.summary ?? "").trim();
  if (summary) return `Call: ${summary}`; // a real conversation → summarize it

  // No summary → only voicemails/no-answers get a (brief) note, and only on the completed event.
  if (c.eventType === "call.completed") {
    const answered = typeof c.durationSec === "number" && c.durationSec > 0;
    if (answered) return null; // answered but no summary yet — wait for call.summary.completed
    return c.direction === "outgoing" ? "Left voicemail" : "Got voicemail";
  }
  return null;
}
