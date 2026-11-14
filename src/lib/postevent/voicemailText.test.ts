// Owner rule (2026-11-14): the review follow up is call, voicemail, then the text goes out RIGHT AWAY.
import { describe, it, expect } from "vitest";
import { deriveNextAction, isVoicemailAttempt, type LastAttempt } from "./engine";

const vm = (over: Partial<LastAttempt> = {}): LastAttempt => ({ channel: "voicemail", outcome: "left_voicemail", direction: "outbound", notes: null, occurredAt: "2026-11-14T15:00:00Z", ...over });

describe("text right after a voicemail", () => {
  it("a voicemail as the latest attempt makes the text the next step, not await response", () => {
    expect(deriveNextAction("follow_up_in_progress", null, 0, vm())).toBe("sms");
    expect(deriveNextAction("needs_follow_up", null, 0, vm())).toBe("sms");
    expect(deriveNextAction("follow_up_in_progress", null, 0, vm({ channel: "phone" }))).toBe("sms"); // logged as a call with outcome left voicemail
    expect(deriveNextAction("follow_up_in_progress", null, 0, vm({ channel: "phone", outcome: "other", notes: "Left voicemail" }))).toBe("sms"); // from the Quo call log
  });

  it("once the text is logged (or the customer answered) it goes back to waiting", () => {
    expect(deriveNextAction("follow_up_in_progress", null, 0, vm({ channel: "sms", outcome: "other", notes: "Hi, thanks again" }))).toBe("await_response");
    expect(deriveNextAction("follow_up_in_progress", null, 0, null)).toBe("await_response");
    expect(deriveNextAction("needs_follow_up", null, 0, null)).toBe("call");
    expect(isVoicemailAttempt(vm({ direction: "inbound" }))).toBe(false);
  });

  it("later states ignore the voicemail", () => {
    expect(deriveNextAction("customer_responded", null, 0, vm())).toBe("review_feedback");
    expect(deriveNextAction("experience_confirmed", "positive", 0, vm())).toBe("send_review_request");
  });
});

describe("on the board", () => {
  it("a logged voicemail shows the text as due today", async () => {
    const { getDb } = await import("../db/index");
    const { syncPostEvent, buildBoard } = await import("./engine");
    const { addContact, setState, getProject } = await import("./store");
    const db = getDb();
    const now = new Date();
    const ago = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString();
    db.prepare("INSERT INTO bookings (booking_id, event_name, event_date, status_label, client_name, venue, updated_at) VALUES (?,?,?,?,?,?,?)")
      .run("VM-1", "Voicemail Party", ago(3).slice(0, 10), "Signed", "Pat Doe", "Hall", ago(0));
    db.prepare("INSERT INTO event_outcomes (event_id, route_id, date, total_stops, completed_stops, all_completed, closed_at) VALUES (?,?,?,?,?,?,?)")
      .run("VM-1", "R-VM", ago(3).slice(0, 10), 1, 1, 1, ago(2));
    syncPostEvent();
    addContact("VM-1", { channel: "phone", outcome: "left_voicemail", direction: "outbound", occurredAt: ago(0) }, "Lisa");
    setState("VM-1", "follow_up_in_progress", "Lisa");
    syncPostEvent();
    expect(getProject("VM-1")!.nextAction).toBe("sms");
    const card = buildBoard().columns.follow_up_in_progress.find((c) => c.bookingId === "VM-1")!;
    expect(card.nextAction).toBe("sms");
    expect(card.dueAt).toBe(ago(0).slice(0, 10));
    expect(card.dueToday || card.overdue).toBe(true);
  });
});
