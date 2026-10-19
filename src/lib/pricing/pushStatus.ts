// Pure display logic for the Delivery Pricing "Push delivery fee to Goodshuffle" button. The push queues a
// gs_outbox op that the LOGGED-IN OFFICE BROWSER (Auto-Pull extension) actually applies — the server can't
// call Goodshuffle. So the UI can't claim "done" until the op's real status says so. This maps the observable
// facts (the polled op status, how long we've waited, whether the extension in THIS browser acked the nudge)
// to an HONEST, resolving label — never a flat "queued" that never updates, never a fake "done".
//
// Kept as a framework-free function so it's unit-tested directly (the component just renders the result).

/** Real status of the queued op, from GET /api/pricing/push?opId=… (or "unknown" before the first poll). */
export type PushOpStatus = "pending" | "done" | "failed" | "unknown";

export interface PushDisplayInput {
  /** The op's current status from the server poll. */
  status: PushOpStatus;
  /** Seconds elapsed since the push was queued. */
  waitedSec: number;
  /** Did the extension in THIS browser ack the drain nudge? true = office machine, false = absent/not Chrome,
   *  null = not yet attempted/known. */
  extReachable: boolean | null;
  /** Error text from a failed op, if any. */
  error?: string;
}

export type PushDisplayTone = "info" | "ok" | "error" | "attention";

export interface PushDisplay {
  kind: "pushing" | "done" | "failed" | "queued";
  text: string;
  tone: PushDisplayTone;
  /** Whether to offer a "Push now" re-nudge button (only while it hasn't landed). */
  showPushNow: boolean;
}

// After this long with no result we stop saying "Pushing…" and show the honest queued state + a re-nudge.
export const PUSH_SLOW_AFTER_SEC = 20;

export function deliveryPushDisplay(input: PushDisplayInput): PushDisplay {
  const { status, waitedSec, extReachable, error } = input;

  if (status === "done") {
    return { kind: "done", text: "Pushed to Goodshuffle.", tone: "ok", showPushNow: false };
  }
  if (status === "failed") {
    return {
      kind: "failed",
      text: error ? `Goodshuffle didn't accept it: ${error}` : "Goodshuffle didn't accept the change.",
      tone: "error",
      showPushNow: true,
    };
  }

  // Still pending / unknown. If the extension isn't in THIS browser, be honest immediately — it will apply
  // on the next Auto-Pull, or when this is opened on the office machine.
  if (extReachable === false) {
    return {
      kind: "queued",
      text: "Queued. The office Auto-Pull browser isn't in this tab, so it applies on the next Auto-Pull (or open this on the office machine to apply it now).",
      tone: "attention",
      showPushNow: true,
    };
  }

  // Office machine (or not yet known): show the fast-path spinner briefly, then an honest waiting state.
  if (waitedSec < PUSH_SLOW_AFTER_SEC) {
    return { kind: "pushing", text: "Pushing to Goodshuffle…", tone: "info", showPushNow: false };
  }
  return {
    kind: "queued",
    text: "Queued — waiting for the office browser. This updates the moment it lands.",
    tone: "attention",
    showPushNow: true,
  };
}
