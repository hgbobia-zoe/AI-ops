// Reads a number's recent texts and calls for the thank-you line rule (smsSignoff.ts, which stays pure).
// 36 hours back covers "today" in the operating timezone plus the quiet window, whatever the server clock.

import { textTouchesForPhone } from "@/lib/db/repo";
import type { TextTouch } from "./smsSignoff";

const LOOKBACK_MS = 36 * 3_600_000;

export function signoffHistoryFor(phone: string | null | undefined, now: Date = new Date()): TextTouch[] {
  if (!(phone ?? "").trim()) return [];
  try {
    return textTouchesForPhone(phone as string, new Date(now.getTime() - LOOKBACK_MS).toISOString());
  } catch {
    return []; // a history read never blocks a text; with no history the rule treats it as a fresh thread
  }
}
