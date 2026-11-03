import { describe, it, expect } from "vitest";
import { getDb } from "@/lib/db";
import { logChange } from "./store";
import {
  classifyChange,
  describeWriteBack,
  describeApproval,
  describeAudit,
  mergePage,
  cursorFor,
  historyFeed,
  eventWriteBacks,
  byLabel,
  type FeedItem,
} from "./feed";

const item = (id: string, ts: string): FeedItem => ({ id, ts, area: null, tone: "neutral", title: id, subject: null, detail: null, eventId: null, by: { who: "platform", name: null } });

describe("who did it", () => {
  it("names the person behind a risk decision and marks scan changes as the platform", () => {
    expect(classifyChange({ kind: "risk_status_changed", toValue: "dismissed (by Lisa)" })).toEqual({ who: "person", name: "Lisa", where: "Event Risk" });
    expect(classifyChange({ kind: "driver_assigned", toValue: "Marco" })).toEqual({ who: "person", name: null, where: "Dispatch" });
    expect(classifyChange({ kind: "risk_detected", toValue: "HIGH" })).toEqual({ who: "platform", name: null });
    expect(byLabel({ who: "person", name: null, where: "Dispatch" })).toBe("by someone on Dispatch");
    expect(byLabel({ who: "platform", name: null })).toBe("by the platform");
  });

  it("credits a write-back to the person who approved it, else the platform", () => {
    const row = { id: "o1", op: "email_send", label: "Smith follow up", transaction_id: "9001", status: "done", last_error: null, updated_at: "2026-11-03T12:00:00Z", decided_by: null };
    expect(describeWriteBack(row, true).by).toEqual({ who: "platform", name: null });
    expect(describeWriteBack({ ...row, decided_by: "Jessie" }, true).by).toEqual({ who: "person", name: "Jessie" });
    const failed = describeWriteBack({ ...row, status: "dead", last_error: "401" }, true);
    expect(failed).toMatchObject({ tone: "critical", title: "Goodshuffle write-back failed, needs a person: send an email to the client", detail: "401", eventId: "9001" });
  });

  it("hides money from viewers who can't see it", () => {
    const fee = { id: "o2", op: "set_delivery_fee", label: "$85 fee", transaction_id: null, status: "done", last_error: null, updated_at: "2026-11-03T12:00:00Z", decided_by: null };
    expect(describeWriteBack(fee, false).subject).toBeNull();
    expect(describeWriteBack(fee, true).subject).toBe("$85 fee");
    const ap = { id: "a1", title: "Win back $4,000 quote", status: "approved", decided_by: "Hermann", decided_at: "2026-11-03T12:00:00Z", financial: 1, decision_note: null };
    expect(describeApproval(ap, false).subject).toBe("a draft with dollar amounts");
    expect(describeApproval(ap, true)).toMatchObject({ subject: "Win back $4,000 quote", title: "Approved an AI draft", by: { who: "person", name: "Hermann" } });
  });

  it("reads only allowlisted audit actions", () => {
    expect(describeAudit({ audit_id: "x", ts: "t", actor: "Lisa", action: "payroll.approve", entity_id: "p", after: null })).toBeNull();
    expect(describeAudit({ audit_id: "x", ts: "t", actor: "Lisa", action: "LEAD_VIEWED", entity_id: "p", after: null })).toBeNull();
    const pub = describeAudit({ audit_id: "x", ts: "t", actor: "Lisa", action: "SHIFT_PUBLISH_SENT", entity_id: "s1", after: JSON.stringify({ notified: 3 }) });
    expect(pub).toMatchObject({ title: "Shift published to Connecteam", detail: "3 crew notified", by: { who: "person", name: "Lisa" } });
    // A driver closeout records the driver's id, not a name, so it doesn't print the id.
    const close = describeAudit({ audit_id: "y", ts: "t", actor: "drv-17", action: "ROUTE_CLOSEOUT", entity_id: "R-1", after: "{bad json" });
    expect(close).toMatchObject({ title: "Driver closed out the route", by: { who: "person", name: null, where: "the driver app" } });
  });
});

describe("paging", () => {
  it("translates the cursor per source", () => {
    expect(cursorFor("OB:", "2026-11-03T12:00:00Z|OB:abc")).toEqual({ ts: "2026-11-03T12:00:00Z", id: "abc" });
    // At the same ts, an OB: row sorts after (comes later than) an AU: cursor, so none of OB's rows qualify...
    expect(cursorFor("OB:", "T|AU:x")).toEqual({ ts: "T", id: "" });
    // ...while every AP: row comes after an OB: cursor.
    expect(cursorFor("AP:", "T|OB:x")).toEqual({ ts: "T", id: "￿" });
  });

  it("merges sources newest first and pages with a stable cursor", () => {
    const p1 = mergePage([[item("CH-b", "2"), item("CH-a", "1")], [item("OB:z", "2"), item("OB:y", "0")]], 2);
    expect(p1.items.map((x) => x.id)).toEqual(["OB:z", "CH-b"]);
    const p2 = mergePage([[item("CH-a", "1")], [item("OB:y", "0")]], 2, p1.nextBefore);
    expect(p2.items.map((x) => x.id)).toEqual(["CH-a", "OB:y"]);
    expect(p2.nextBefore).toBeNull();
  });

  it("walks every source end to end without skipping same-millisecond rows", () => {
    const db = getDb();
    const ts = "2026-10-15T15:00:00.000Z";
    for (let i = 0; i < 3; i++) logChange({ source: "risk", entity: "risk", entityId: `fd-${i}`, kind: "risk_detected", field: `FD Feed ${i}`, changeKey: `fd|${i}` }, new Date(ts));
    const ob = db.prepare("INSERT INTO gs_outbox (id, op, label, transaction_id, status, attempts, created_at, updated_at) VALUES (?,?,?,?,?,0,?,?)");
    ob.run("fd-o1", "create_project", "FD Feed lead", "FD-TX", "done", ts, ts);
    ob.run("fd-o2", "photo_upload", "FD Feed photo", "FD-TX", "done", ts, ts);
    ob.run("fd-o3", "note_append", "FD Feed note", "FD-TX", "done", ts, ts); // skipped: notes would bury the feed
    db.prepare("INSERT INTO ai_approvals (id, agent_id, title, action_type, status, created_at, decided_by, decided_at, outbox_op_id) VALUES (?,?,?,?,?,?,?,?,?)").run(
      "fd-a1", "outreach", "FD Feed follow up", "send_email", "executed", ts, "Jessie", ts, "fd-o1",
    );
    db.prepare("INSERT INTO audit_logs (audit_id, actor, action, entity, entity_id, after, ts) VALUES (?,?,?,?,?,?,?)").run(
      "fd-u1", "Lisa", "SHIFT_PUBLISH_SENT", "staff_shift", "FD Feed shift", JSON.stringify({ notified: 2 }), ts,
    );

    const seen: string[] = [];
    let before: string | null = null;
    for (let guard = 0; guard < 20; guard++) {
      const page = historyFeed({ q: "FD Feed", before, limit: 2, showMoney: true });
      seen.push(...page.items.map((x) => x.id));
      if (!page.nextBefore) break;
      before = page.nextBefore;
    }
    expect([...seen].sort()).toEqual(["AP:fd-a1", "AU:fd-u1", "OB:fd-o1", "OB:fd-o2", ...seen.filter((s) => s.startsWith("CH-"))].sort());
    expect(seen.filter((s) => s.startsWith("CH-"))).toHaveLength(3);
    expect(new Set(seen).size).toBe(seen.length);

    // Who filter: the approved write-back counts as a person; the photo upload as the platform.
    const people = historyFeed({ q: "FD Feed", who: "person", showMoney: true }).items.map((x) => x.id);
    expect(people).toEqual(expect.arrayContaining(["OB:fd-o1", "AP:fd-a1", "AU:fd-u1"]));
    expect(people).not.toContain("OB:fd-o2");
    const platform = historyFeed({ q: "FD Feed", who: "platform", showMoney: true }).items.map((x) => x.id);
    expect(platform).toContain("OB:fd-o2");
    expect(platform).not.toContain("AP:fd-a1");

    // Area filter + per-event write-backs.
    expect(historyFeed({ q: "FD Feed", area: "goodshuffle", showMoney: true }).items.map((x) => x.id).sort()).toEqual(["OB:fd-o1", "OB:fd-o2"]);
    expect(eventWriteBacks("FD-TX", true).map((x) => x.id).sort()).toEqual(["OB:fd-o1", "OB:fd-o2"]);
  });
});
