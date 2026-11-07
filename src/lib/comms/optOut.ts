// One definition of a texted opt out, shared by morning outreach and inbound SMS handling.
// A bare "STOP" reply, or an explicit opt out phrase ("stop by Friday" is not an opt out).
export const STOP_RE = /^\s*(stop|unsubscribe|end|quit)\W*$|\b(unsubscribe|stop texting|do not (text|contact) (me|us)|don'?t (text|contact) (me|us)|remove me)\b/i;

export function isOptOut(text: string | null | undefined): boolean {
  return STOP_RE.test(text ?? "");
}
