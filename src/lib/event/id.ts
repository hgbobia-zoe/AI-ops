// Canonical Event id — the single normalizer for the Goodshuffle project/transaction id.
//
// Governing law: RULES CALCULATE. This module fabricates nothing. There is ONE canonical Event id and
// it IS the Goodshuffle project/transaction id — the same integer that appears under three column
// aliases for the SAME thing across the codebase:
//   • bookings.booking_id   (GS project id — the commercial record)
//   • stops.tx_id           (GS transactionID — the dispatch/logistics record)
//   • event_id              (in event_readiness / event_financials / event_outcomes / event_snapshots /
//                            cost_entries.event_id — every derived per-event table)
// We do NOT mint a new id space. This file only NORMALIZES whichever alias a caller hands us (a number
// or a string) into one comparable key, so a booking and its routed stops resolve to the same Event.
//
// Pure: no DB, no net, no AI.

/** A normalized Goodshuffle project/transaction id. Branded so a raw string can't be passed where a
 *  canonicalized id is required without going through `canonicalEventId`. */
export type EventId = string & { readonly __eventId: unique symbol };

/**
 * Normalize a booking_id / tx_id / event_id into the canonical `EventId`, or `null` when the input
 * cannot be resolved to an id (null/undefined/empty — never fabricated).
 *
 * Rule:
 *  - `number`: must be a finite, non-negative integer (GS ids are integers); otherwise `null`. A
 *    fractional or non-finite number is NOT a valid id and is rejected rather than coerced.
 *  - `string`: trimmed. An empty string is `null`. A bare non-negative integer (optionally a single
 *    leading `+`, with any leading zeros) is canonicalized via BigInt so `"0042"`, `"42"`, `"+42"`
 *    and the number `42` all collapse to `"42"` (BigInt avoids precision loss on very large ids).
 *    A string that is not a bare integer is kept as its trimmed self so an unusual id still matches
 *    itself exactly — we never invent or reshape an id we don't recognize.
 */
export function canonicalEventId(input: number | string | null | undefined): EventId | null {
  if (input === null || input === undefined) return null;

  if (typeof input === "number") {
    if (!Number.isFinite(input) || !Number.isInteger(input) || input < 0) return null;
    return String(input) as EventId;
  }

  const trimmed = input.trim();
  if (trimmed === "") return null;

  const bareInteger = /^\+?(\d+)$/.exec(trimmed);
  if (bareInteger) {
    try {
      return BigInt(bareInteger[1]).toString() as EventId;
    } catch {
      return null;
    }
  }

  // Not a recognized GS integer id — keep the trimmed original (matches itself, never fabricated).
  return trimmed as EventId;
}

/** True when both inputs resolve to the same canonical id. Two inputs that BOTH fail to resolve are
 *  NOT considered equal (we can't assert identity on what we couldn't normalize). */
export function eventIdEquals(
  a: number | string | null | undefined,
  b: number | string | null | undefined,
): boolean {
  const ca = canonicalEventId(a);
  if (ca === null) return false;
  return ca === canonicalEventId(b);
}

/** Narrowing guard: whether a value is already a canonical `EventId` (i.e. normalizes to itself). */
export function isEventId(value: unknown): value is EventId {
  return typeof value === "string" && canonicalEventId(value) === value;
}
