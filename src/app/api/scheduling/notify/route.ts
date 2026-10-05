// Assignment notifications — the HUMAN-CONFIRMED text a dispatcher sends when a worker is put on, or taken
// off, a route. Two phases over one endpoint:
//   • confirm !== true  → DRY RUN: resolve each worker + shift, build the deterministic message, and return
//       a preview row per notice with `sendable` + a human `reason` when it can't send. SENDS NOTHING.
//   • confirm === true  → for each SENDABLE notice, sendSms() for real, logShiftEvent the send, and return
//       an honest per-notice state ("sent" only when the provider returned ok; else "skipped"/"failed").
//
// The per-confirm tap IS the gate the user asked for — this is NEVER called from the assign PATCH. Real-send
// gating mirrors the customer SMS in api/action: there is no separate master switch, sending happens when
// the active SMS provider is configured (smsConfigured) and the worker has a phone; otherwise it is honestly
// reported as not sendable. NOT gated behind SHIFT_COMMS_ENABLED (that governs the separate 3-touch packet).
//
// Staff/session-gated by the proxy: /api/scheduling is neither public nor guest-allowed, so a valid staff
// session is required and no proxy change is needed.

import { NextResponse } from "next/server";
import { getShiftById } from "@/lib/scheduling/store";
import { getAssignmentsForShift, logShiftEvent } from "@/lib/scheduling/assignments";
import { getUsers, type CrewMember } from "@/lib/connecteam";
import { sendSms, smsConfigured, toE164 } from "@/lib/notify/sms";
import { currentActor } from "@/lib/auth/getSession";
import { formatClockTime, formatYmdLong } from "@/lib/dates";
import {
  buildAssignmentNotice,
  roleLabelForWorker,
  maskPhone,
  type AssignNoticeKind,
  type NotifyNotice,
  type NotifyDryRunRow,
  type NotifySendResult,
} from "@/lib/scheduling/assignNotify";
import type { StaffShift } from "@/lib/scheduling/types";

export const dynamic = "force-dynamic";

interface Body {
  notices?: Array<{ shiftId?: unknown; userId?: unknown; kind?: unknown }>;
  confirm?: boolean;
}

function isKind(v: unknown): v is AssignNoticeKind {
  return v === "assigned" || v === "removed";
}

/** The window phrase for a shift ("7:00 AM to 3:00 PM"), or null when the window isn't known. No dashes. */
function windowText(shift: StaffShift): string | null {
  if (!shift.windowKnown || !shift.startTime) return null;
  const start = formatClockTime(shift.startTime);
  const end = shift.endTime ? formatClockTime(shift.endTime) : "";
  if (!start) return null;
  return end ? `${start} to ${end}` : start;
}

/** Resolve everything a notice needs into a draft row (shared by dry-run and the real send). */
function resolveRow(
  n: NotifyNotice,
  users: Map<number, CrewMember>,
  usersOk: boolean,
  providerOn: boolean,
): { row: NotifyDryRunRow; phone: string | null } {
  const shift = getShiftById(n.shiftId);
  const member = users.get(n.userId);
  const name = member?.name ?? `#${n.userId}`;
  const firstName = member?.firstName || name.split(/\s+/)[0] || "";
  const phone = member?.phone ?? null;
  const e164 = phone ? toE164(phone) : "";

  const base = { shiftId: n.shiftId, userId: n.userId, kind: n.kind, name, phoneMasked: maskPhone(phone) };

  if (!shift) {
    return { row: { ...base, body: "", sendable: false, reason: "shift not found" }, phone: null };
  }

  const body = buildAssignmentNotice({
    kind: n.kind,
    firstName,
    roleLabel: roleLabelForWorker(shift.role),
    dateHuman: formatYmdLong(shift.date),
    routeLabel: shift.eventLabel ?? null,
    windowText: windowText(shift),
  });

  let sendable = true;
  let reason: string | undefined;
  if (!e164) {
    sendable = false;
    reason = !usersOk ? "Connecteam unreachable, no phone on file" : "no phone on file";
  } else if (!providerOn) {
    sendable = false;
    reason = "texting provider not configured";
  }

  return { row: { ...base, body, sendable, reason }, phone: e164 || null };
}

export async function POST(req: Request): Promise<NextResponse> {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const notices: NotifyNotice[] = (body.notices ?? [])
    .filter((n) => typeof n?.shiftId === "string" && Number.isFinite(Number(n?.userId)) && isKind(n?.kind))
    .map((n) => ({ shiftId: String(n.shiftId), userId: Number(n.userId), kind: n.kind as AssignNoticeKind }));

  if (notices.length === 0) return NextResponse.json({ error: "no_notices" }, { status: 400 });

  // Resolve worker identities once (names + phones). An outage leaves usersOk false, which surfaces as an
  // honest "no phone on file" reason rather than a fabricated send.
  let users = new Map<number, CrewMember>();
  let usersOk = false;
  try {
    users = await getUsers();
    usersOk = users.size > 0;
  } catch {
    usersOk = false;
  }
  const providerOn = smsConfigured();

  // ── DRY RUN ──────────────────────────────────────────────────────────────────────────────────────
  if (body.confirm !== true) {
    const rows = notices.map((n) => resolveRow(n, users, usersOk, providerOn).row);
    return NextResponse.json({ ok: true, dryRun: true, notices: rows });
  }

  // ── REAL SEND ────────────────────────────────────────────────────────────────────────────────────
  const actor = (await currentActor()).label;
  const results: NotifySendResult[] = [];
  for (const n of notices) {
    const { row, phone } = resolveRow(n, users, usersOk, providerOn);
    if (!row.sendable || !phone) {
      results.push({ shiftId: n.shiftId, userId: n.userId, kind: n.kind, state: "skipped", reason: row.reason ?? "not sendable" });
      continue;
    }
    const r = await sendSms(phone, row.body);
    if (r.ok) {
      // Record the send on the worker's live assignment (removed workers still have a row, now terminal).
      const assignment = getAssignmentsForShift(n.shiftId).find(
        (a) => a.workerKind === "internal" && a.connecteamUserId === n.userId,
      );
      logShiftEvent({
        shiftId: n.shiftId,
        assignmentId: assignment?.id ?? null,
        actor,
        kind: "notify",
        field: n.kind === "assigned" ? "notify_assigned" : "notify_removed",
        toValue: `${n.kind} text sent to ${row.name}`,
        // Timestamped change key so a deliberate re-send is allowed AND still audited (never deduped away).
        changeKey: `${n.shiftId}:notify_${n.kind}:${n.userId}:${Date.now()}`,
      });
      results.push({ shiftId: n.shiftId, userId: n.userId, kind: n.kind, state: "sent" });
    } else if (r.skipped) {
      results.push({ shiftId: n.shiftId, userId: n.userId, kind: n.kind, state: "skipped", reason: r.error ?? "provider not configured" });
    } else {
      results.push({ shiftId: n.shiftId, userId: n.userId, kind: n.kind, state: "failed", reason: r.error ?? "send failed" });
    }
  }

  return NextResponse.json({ ok: true, results });
}
