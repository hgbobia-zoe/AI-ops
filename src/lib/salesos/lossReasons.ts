// The loss reason vocabulary and the deterministic classifier that maps a rep's free-text Goodshuffle note
// onto it. Kept apart from lostService so the tracker (lossReasonFlag.ts) can use it without a cycle.

/** The reason vocabulary the team tags a lost quote with (event-rental / DMV market realities). */
export const LOSS_REASONS: string[] = [
  "Price — too expensive",
  "Went with a competitor",
  "Availability — we couldn't fulfill",
  "Date/event changed or cancelled",
  "Budget cut",
  "No response — ghosted",
  "Not signed by the cutoff",
  "Out of service area",
  "Duplicate / test",
  "Other",
];

/** Set by Zoe when the Sales Bot itself marked the quote lost (unsigned close to the event). */
export const SALES_BOT_LOSS_REASON = "Not signed by the cutoff";

// Order matters: the first rule that matches wins ("went with a cheaper vendor" is a competitor loss,
// not a price loss; "budget" beats the generic price words).
const RULES: { reason: string; re: RegExp }[] = [
  { reason: "Duplicate / test", re: /\b(duplicate|dupe|test project|test quote|double entry)\b/ },
  { reason: "Went with a competitor", re: /\b(competitor|another (vendor|company|rental|place)|other (vendor|company)|went with|booked (with|elsewhere|someone)|chose (another|someone|a different)|different vendor|cheaper vendor)\b/ },
  { reason: "Availability — we couldn't fulfill", re: /\b(availability|unavailable|not available|sold out|booked up|out of stock|no inventory|couldn'?t (fulfill|supply|do)|could not (fulfill|supply))\b/ },
  { reason: "Out of service area", re: /\b(out of (our )?(service )?area|too far|outside (of )?(our )?(service )?area|out of range)\b/ },
  { reason: "Date/event changed or cancelled", re: /\b(cancel(l)?ed|cancel(l)?ing|postpon\w*|reschedul\w*|date chang\w*|changed (the )?date|called off|event (is )?off|no longer (having|need\w*)|moved (the )?(date|event))\b/ },
  { reason: "Budget cut", re: /\bbudget\b/ },
  { reason: "Price — too expensive", re: /\b(price|pricing|priced|expensive|cost(s|ly)?|too much|cheaper|too high|delivery fee)\b/ },
  { reason: "No response — ghosted", re: /\b(no response|ghost(ed)?|never (heard|responded|replied|got back)|unresponsive|no reply|didn'?t (respond|reply)|not responding|stopped responding|no answer)\b/ },
];

/** PURE: the vocabulary reason a note's text points at, or null when none of the rules match. */
export function classifyLossReason(text: string): string | null {
  const t = text.toLowerCase();
  for (const r of RULES) if (r.re.test(t)) return r.reason;
  return null;
}
