// Gusto remote-browser push — INTERACTIVE SIGN-IN input (Phase 2). When the office runner's Gusto session has
// lapsed, the pane streams the live login screen and the payroll person signs in FROM THE APP. This route takes
// their clicks/keystrokes and queues them for the runner to replay into the real Gusto login page.
//
// HARD SCOPE (two independent gates, mirrored on the runner side):
//   • owner/admin only (the proxy also gates /api/payroll) — a Member can never drive the office browser; and
//   • input is accepted ONLY while the job is `signin_required` — never during the automated DRAFT write, so
//     this can only ever help a human sign in, never touch the hours replay.
// Every event is validated + clamped here: coords bounded, typed text length-capped, keys from an allowlist.

import { NextResponse } from "next/server";
import { viewerRole } from "@/lib/auth/getSession";
import { canManagePayroll } from "@/lib/auth/roles";
import { getJob, enqueueInput, type GustoPushInputEvent } from "@/lib/payroll/gustoRunnerJobs";

export const dynamic = "force-dynamic";

// Special keys the login flow needs — never arbitrary chords or shortcuts.
const ALLOWED_KEYS = new Set([
  "Enter", "Tab", "Backspace", "Delete", "Escape",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End",
]);

const MAX_EVENTS = 50;
const MAX_TEXT = 500;

function coord(v: unknown): number | null {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(5000, n)); // clamp to a sane viewport range
}

function sanitize(raw: unknown): GustoPushInputEvent[] {
  if (!Array.isArray(raw)) return [];
  const out: GustoPushInputEvent[] = [];
  for (const e of raw.slice(0, MAX_EVENTS)) {
    if (!e || typeof e !== "object") continue;
    const ev = e as Record<string, unknown>;
    if (ev.kind === "click") {
      const x = coord(ev.x), y = coord(ev.y);
      if (x !== null && y !== null) out.push({ kind: "click", x, y });
    } else if (ev.kind === "scroll") {
      const x = coord(ev.x), y = coord(ev.y);
      const d = Number(ev.deltaY);
      if (x !== null && y !== null) out.push({ kind: "scroll", x, y, deltaY: Number.isFinite(d) ? Math.max(-4000, Math.min(4000, d)) : 0 });
    } else if (ev.kind === "type") {
      const text = typeof ev.text === "string" ? ev.text.slice(0, MAX_TEXT) : "";
      if (text) out.push({ kind: "type", text });
    } else if (ev.kind === "key") {
      if (typeof ev.key === "string" && ALLOWED_KEYS.has(ev.key)) out.push({ kind: "key", key: ev.key });
    }
  }
  return out;
}

export async function POST(req: Request): Promise<Response> {
  if (!canManagePayroll(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as { id?: string; events?: unknown };
  const id = (body.id ?? "").trim();
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const job = getJob(id);
  if (!job) return NextResponse.json({ error: "no such job" }, { status: 404 });
  // The ONLY state in which forwarded input is honored — never during the hours write.
  if (job.status !== "signin_required") {
    return NextResponse.json({ error: "not_accepting_input", status: job.status }, { status: 409 });
  }

  const events = sanitize(body.events);
  if (!events.length) return NextResponse.json({ ok: true, queued: 0 });
  const queued = enqueueInput(id, events);
  return NextResponse.json({ ok: true, queued });
}
