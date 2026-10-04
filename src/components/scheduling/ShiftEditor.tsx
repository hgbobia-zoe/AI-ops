"use client";

// Shift editor — the detail form rendered inside the scheduling side panel. Edits one shift's role,
// headcount, time window (blank = windowKnown false, never a fabricated time), location, event label,
// notes, internal assignees (Connecteam crew, with a "busy" mark for anyone already scheduled that day),
// the Instawork gap-fill headcount, pay rate and status. Confirm sets status=confirmed. The external
// push button is present but DISABLED ("Wired next") — the pushes are the next increment.
//
// Saves via POST (new) / PATCH (existing); deletes via DELETE. Closes + refreshes the board on success.

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, Check, Trash2, X, Send, FileText } from "lucide-react";
import type { CrewMember } from "@/lib/connecteam";
import type { CrewRecommendation } from "@/lib/scheduling/availability";
import { shiftGap, type ShiftRole, type ShiftStatus, type StaffShift } from "@/lib/scheduling/types";

const INPUT = "w-full rounded border border-border bg-background px-2.5 py-1.5 text-[13px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
const BTN = "inline-flex items-center gap-1.5 rounded border border-border px-3 py-1.5 text-[12.5px] text-tertiary-text transition-colors hover:bg-[var(--row-hover)] hover:text-foreground disabled:opacity-50 disabled:pointer-events-none";
const LABEL = "text-[11px] uppercase tracking-[0.08em] text-meta";

const ROLES: { value: ShiftRole; label: string }[] = [
  { value: "driver", label: "Driver" },
  { value: "field", label: "Field" },
  { value: "prep", label: "Prep" },
];
const STATUSES: { value: ShiftStatus; label: string }[] = [
  { value: "draft", label: "Draft" },
  { value: "confirmed", label: "Confirmed" },
  { value: "sent", label: "Sent" },
  { value: "cancelled", label: "Cancelled" },
];

// ISO instant → the value a <input type="datetime-local"> wants (local wall-clock, no tz suffix).
function isoToLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
// datetime-local value (local wall-clock) → ISO instant, or null when blank.
function localInputToIso(v: string): string | null {
  if (!v.trim()) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

interface Draft {
  role: ShiftRole;
  headcount: number;
  start: string; // datetime-local
  end: string;
  location: string;
  eventLabel: string;
  notes: string;
  assignees: number[];
  instaworkHeadcount: number;
  payRate: string; // free text → parsed on save
  status: ShiftStatus;
}

function toDraft(shift: StaffShift | null): Draft {
  if (!shift) {
    return { role: "field", headcount: 1, start: "", end: "", location: "", eventLabel: "", notes: "", assignees: [], instaworkHeadcount: 0, payRate: "", status: "draft" };
  }
  const gap = shiftGap(shift);
  return {
    role: shift.role,
    headcount: shift.headcount,
    start: isoToLocalInput(shift.startTime),
    end: isoToLocalInput(shift.endTime),
    location: shift.location ?? "",
    eventLabel: shift.eventLabel ?? "",
    notes: shift.notes ?? "",
    assignees: [...shift.assignees],
    instaworkHeadcount: shift.instaworkHeadcount > 0 ? shift.instaworkHeadcount : gap,
    payRate: shift.payRate == null ? "" : String(shift.payRate),
    status: shift.status,
  };
}

export function ShiftEditor({
  shift,
  date,
  roster,
  busyUserIds,
  recommendations,
  onClose,
}: {
  shift: StaffShift | null;
  date: string; // the day being edited (for a new shift)
  roster: CrewMember[];
  busyUserIds: number[];
  recommendations: CrewRecommendation[];
  onClose: () => void;
}): React.JSX.Element {
  const router = useRouter();
  const isNew = shift == null;
  const [draft, setDraft] = useState<Draft>(() => toDraft(shift));
  const [instaTouched, setInstaTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useMemo(() => new Set(busyUserIds), [busyUserIds]);

  // Packet preview (read-only, send-gated). Previews what each assigned worker would receive; when
  // SHIFT_COMMS_ENABLED is off the server records the packet only and sends nothing.
  interface PacketAssignment { assignmentId: string; displayName: string; workerKind: string; version: string; touches: { on_assign: string }; dispatch: { state: string; gated: boolean; reason?: string } }
  const [packet, setPacket] = useState<{ gated: boolean; assignments: PacketAssignment[] } | null>(null);
  const [packetLoading, setPacketLoading] = useState(false);

  async function previewPacket(): Promise<void> {
    if (isNew || !shift) return;
    setPacketLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/scheduling/shift/${shift.id}/packet`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ touch: "on_assign" }),
      });
      const j = (await res.json().catch(() => null)) as { ok?: boolean; gated?: boolean; assignments?: PacketAssignment[]; error?: string } | null;
      if (!res.ok || !j?.ok) {
        setError(j?.error === "forbidden" ? "Only an owner or admin can preview packets." : "Couldn't build the packet.");
        return;
      }
      setPacket({ gated: Boolean(j.gated), assignments: j.assignments ?? [] });
    } catch {
      setError("Couldn't build the packet.");
    } finally {
      setPacketLoading(false);
    }
  }

  const set = <K extends keyof Draft>(k: K, v: Draft[K]): void => setDraft((d) => ({ ...d, [k]: v }));

  // Live gap = headcount − internal assignees (never below 0). Drives the default Instawork top-up.
  const liveGap = Math.max(0, draft.headcount - draft.assignees.length);
  const effectiveInsta = instaTouched ? draft.instaworkHeadcount : liveGap;

  function toggleAssignee(userId: number): void {
    setDraft((d) => ({
      ...d,
      assignees: d.assignees.includes(userId) ? d.assignees.filter((x) => x !== userId) : [...d.assignees, userId],
    }));
  }

  async function save(nextStatus?: ShiftStatus): Promise<void> {
    setSaving(true);
    setError(null);
    const startIso = localInputToIso(draft.start);
    const endIso = localInputToIso(draft.end);
    const windowKnown = startIso != null; // a time we don't have stays unknown — never fabricated
    const payRate = draft.payRate.trim() === "" ? null : Number(draft.payRate);
    const status = nextStatus ?? draft.status;
    const insta = effectiveInsta;
    try {
      let res: Response;
      if (isNew) {
        res = await fetch("/api/scheduling/shift", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            date,
            role: draft.role,
            headcount: draft.headcount,
            startTime: startIso,
            endTime: endIso,
            windowKnown,
            location: draft.location.trim() || null,
            eventLabel: draft.eventLabel.trim() || null,
            notes: draft.notes.trim() || null,
            assignees: draft.assignees,
            instaworkHeadcount: insta,
            payRate,
            source: "manual",
          }),
        });
      } else {
        res = await fetch(`/api/scheduling/shift/${shift!.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            role: draft.role,
            headcount: draft.headcount,
            startTime: startIso,
            endTime: endIso,
            windowKnown,
            location: draft.location.trim() || null,
            eventLabel: draft.eventLabel.trim() || null,
            notes: draft.notes.trim() || null,
            assignees: draft.assignees,
            instaworkHeadcount: insta,
            payRate,
            status,
          }),
        });
      }
      if (!res.ok) {
        setError("Couldn't save — try again.");
        return;
      }
      onClose();
      router.refresh();
    } catch {
      setError("Couldn't save — try again.");
    } finally {
      setSaving(false);
    }
  }

  const alreadyPublished = !isNew && Boolean(shift?.connecteamShiftId);
  const canPublish = !isNew && !saving && Boolean(draft.start) && draft.assignees.length > 0;
  const publishHint = isNew
    ? "Save the shift first"
    : !draft.start
      ? "Set a start time first"
      : draft.assignees.length === 0
        ? "Assign internal crew first"
        : alreadyPublished
          ? `Re-notifies ${draft.assignees.length} crew with the changes`
          : `Notifies ${draft.assignees.length} crew`;

  // Publish/update the internal half to Connecteam (notifies the assigned crew). Saves the current draft
  // as CONFIRMED first so what's sent matches what's on screen, then calls the publish endpoint (which
  // creates on first publish, or updates the existing Connecteam shift in place when it was already sent).
  async function publish(): Promise<void> {
    if (!canPublish || !shift) return;
    const n = draft.assignees.length;
    const prompt = alreadyPublished
      ? `Update the Connecteam shift and re-notify ${n} crew member${n === 1 ? "" : "s"}?`
      : `Publish this shift to Connecteam and notify ${n} crew member${n === 1 ? "" : "s"}?`;
    if (!window.confirm(prompt)) return;
    setSaving(true);
    setError(null);
    try {
      const startIso = localInputToIso(draft.start);
      const endIso = localInputToIso(draft.end);
      const payRate = draft.payRate.trim() === "" ? null : Number(draft.payRate);
      const saveRes = await fetch(`/api/scheduling/shift/${shift.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          role: draft.role,
          headcount: draft.headcount,
          startTime: startIso,
          endTime: endIso,
          windowKnown: startIso != null,
          location: draft.location.trim() || null,
          eventLabel: draft.eventLabel.trim() || null,
          notes: draft.notes.trim() || null,
          assignees: draft.assignees,
          instaworkHeadcount: effectiveInsta,
          payRate,
          status: "confirmed",
        }),
      });
      if (!saveRes.ok) {
        setError("Couldn't save the shift before publishing.");
        return;
      }
      const res = await fetch(`/api/scheduling/shift/${shift.id}/publish`, { method: "POST" });
      const j = (await res.json().catch(() => null)) as { message?: string; notified?: number; updated?: boolean } | null;
      if (!res.ok) {
        setError(j?.message || "Connecteam publish failed. Try again.");
        return;
      }
      const notified = j?.notified ?? draft.assignees.length;
      toast.success(j?.updated ? `Updated on Connecteam — re-notified ${notified} crew` : `Published to Connecteam — notified ${notified} crew`);
      onClose();
      router.refresh();
    } catch {
      setError("Connecteam publish failed. Try again.");
    } finally {
      setSaving(false);
    }
  }

  async function remove(): Promise<void> {
    if (isNew || !window.confirm("Delete this shift?")) return;
    setSaving(true);
    try {
      await fetch(`/api/scheduling/shift/${shift!.id}`, { method: "DELETE" });
      onClose();
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
        <div>
          <h2 className="text-[15px] font-medium text-foreground">{isNew ? "Add shift" : "Edit shift"}</h2>
          <p className="text-[12px] text-meta">{shift?.source === "derived" ? "Inferred from routes · rules" : "Manual"}</p>
        </div>
        <button onClick={onClose} aria-label="Close" className="flex size-8 items-center justify-center rounded border border-border text-tertiary-text transition-colors hover:bg-[var(--row-hover)] hover:text-foreground">
          <X className="size-4" />
        </button>
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <div className="grid gap-3.5 sm:grid-cols-2">
          <label className="space-y-1">
            <span className={LABEL}>Role</span>
            <select className={INPUT} value={draft.role} onChange={(e) => set("role", e.target.value as ShiftRole)}>
              {ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </label>
          <label className="space-y-1">
            <span className={LABEL}>Headcount</span>
            <input className={INPUT} type="number" min={1} value={draft.headcount} onChange={(e) => set("headcount", Math.max(1, Number(e.target.value) || 1))} />
          </label>
          <label className="space-y-1">
            <span className={LABEL}>Start</span>
            <input className={INPUT} type="datetime-local" value={draft.start} onChange={(e) => set("start", e.target.value)} />
          </label>
          <label className="space-y-1">
            <span className={LABEL}>End</span>
            <input className={INPUT} type="datetime-local" value={draft.end} onChange={(e) => set("end", e.target.value)} />
          </label>
        </div>
        {!draft.start && <p className="mt-1.5 text-[11.5px] text-attention">No start time set — this shift shows &ldquo;Set time&rdquo; until you enter one.</p>}

        <div className="mt-3.5 grid gap-3.5 sm:grid-cols-2">
          <label className="space-y-1">
            <span className={LABEL}>Location</span>
            <input className={INPUT} value={draft.location} onChange={(e) => set("location", e.target.value)} placeholder="Warehouse / venue address" />
          </label>
          <label className="space-y-1">
            <span className={LABEL}>Event / route</span>
            <input className={INPUT} value={draft.eventLabel} onChange={(e) => set("eventLabel", e.target.value)} placeholder="Event label" />
          </label>
        </div>

        <label className="mt-3.5 block space-y-1">
          <span className={LABEL}>Notes</span>
          <textarea className={INPUT} rows={2} value={draft.notes} onChange={(e) => set("notes", e.target.value)} />
        </label>

        {/* Internal assignees */}
        <div className="mt-4">
          <div className="mb-1.5 flex items-baseline justify-between">
            <span className={LABEL}>Internal crew · {draft.assignees.length}/{draft.headcount}</span>
            {liveGap > 0 && <span className="text-[11.5px] text-attention">{liveGap} to fill</span>}
          </div>

          {/* Recommendations: who's actually FREE for this window + role (excludes office/admin). Pick one. */}
          {recommendations.length > 0 ? (
            <div className="mb-2 rounded border border-positive/30 bg-positive/[0.06] p-2">
              <div className="mb-1 text-[11px] font-medium uppercase tracking-[0.06em] text-positive">Recommended · free this window</div>
              <div className="space-y-0.5">
                {recommendations.map((r) => {
                  const on = draft.assignees.includes(r.userId);
                  return (
                    <button
                      key={r.userId}
                      type="button"
                      onClick={() => toggleAssignee(r.userId)}
                      className="flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left text-[12.5px] transition-colors hover:bg-[var(--row-hover)]"
                    >
                      <span className="min-w-0 truncate">
                        <span className="font-medium text-foreground">{r.name}</span>
                        <span className="ml-1.5 text-[11px] text-meta">{r.reason}</span>
                      </span>
                      <span className={`shrink-0 text-[11px] ${on ? "text-positive" : "text-tertiary-text"}`}>{on ? "Added ✓" : "+ Add"}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            !isNew && (
              <p className="mb-2 text-[11.5px] text-meta">
                {draft.role === "field"
                  ? "No internal crew free for this window — post General Labor on Instawork for the gap."
                  : "No one free for this window — pick from the roster below or post to Instawork."}
              </p>
            )
          )}

          {roster.length === 0 ? (
            <p className="text-[12.5px] text-meta">No Connecteam roster available.</p>
          ) : (
            <div className="max-h-52 space-y-1 overflow-y-auto rounded border border-border p-1.5">
              {roster.map((m) => {
                const on = draft.assignees.includes(m.userId);
                const isBusy = busy.has(m.userId);
                return (
                  <button
                    key={m.userId}
                    type="button"
                    onClick={() => toggleAssignee(m.userId)}
                    className={`flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-[13px] transition-colors ${on ? "bg-foreground/[0.08] text-foreground" : "text-tertiary-text hover:bg-[var(--row-hover)]"}`}
                  >
                    <span className="flex items-center gap-2">
                      <span className={`flex size-4 shrink-0 items-center justify-center rounded-sm border ${on ? "border-foreground bg-foreground text-background" : "border-border"}`}>{on && <Check className="size-3" />}</span>
                      {m.name}
                    </span>
                    <span className="flex items-center gap-2 text-[10.5px] uppercase tracking-[0.06em] text-meta">
                      {m.role}
                      {isBusy && <span className="rounded border border-attention/40 px-1 py-px text-attention">busy</span>}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Instawork + pay */}
        <div className="mt-4 grid gap-3.5 sm:grid-cols-2">
          <label className="space-y-1">
            <span className={LABEL}>Instawork headcount</span>
            <input
              className={INPUT}
              type="number"
              min={0}
              value={effectiveInsta}
              onChange={(e) => { setInstaTouched(true); set("instaworkHeadcount", Math.max(0, Number(e.target.value) || 0)); }}
            />
            {!instaTouched && <span className="text-[11px] text-meta">Defaults to the gap ({liveGap}).</span>}
          </label>
          <label className="space-y-1">
            <span className={LABEL}>Pay rate ($/hr)</span>
            <input className={INPUT} inputMode="decimal" value={draft.payRate} onChange={(e) => set("payRate", e.target.value)} placeholder="e.g. 22" />
          </label>
        </div>

        <label className="mt-3.5 block space-y-1 sm:w-1/2">
          <span className={LABEL}>Status</span>
          <select className={INPUT} value={draft.status} onChange={(e) => set("status", e.target.value as ShiftStatus)}>
            {STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </label>

        {/* Packet preview (read-only, send-gated) */}
        {packet && (
          <div className="mt-4 rounded border border-border bg-[var(--row-hover)]/40 p-3">
            <div className="mb-1.5 flex items-center justify-between">
              <span className={LABEL}>Shift packet preview</span>
              <span className={`text-[11px] ${packet.gated ? "text-attention" : "text-positive"}`}>
                {packet.gated ? "Preview only (sending is off)" : "Sending is on"}
              </span>
            </div>
            {packet.assignments.length === 0 ? (
              <p className="text-[12px] text-meta">No assigned workers yet. Assign crew, then preview.</p>
            ) : (
              <div className="space-y-2.5">
                {packet.assignments.map((pa) => (
                  <div key={pa.assignmentId} className="rounded border border-[var(--row-rule)] p-2">
                    <div className="mb-1 flex items-center justify-between text-[11.5px]">
                      <span className="font-medium text-foreground">{pa.displayName}</span>
                      <span className="text-meta">
                        {pa.workerKind} · {pa.dispatch.state}
                        {pa.dispatch.reason ? ` (${pa.dispatch.reason})` : ""}
                      </span>
                    </div>
                    <pre className="whitespace-pre-wrap break-words text-[11.5px] text-tertiary-text">{pa.touches.on_assign}</pre>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {error && <p className="mt-3 text-[12.5px] text-critical">{error}</p>}
      </div>

      {/* Footer actions */}
      <div className="border-t border-border px-5 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={() => save()} disabled={saving} className={BTN + " border-foreground text-foreground"}>
            {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />} Save
          </button>
          <button onClick={() => save("confirmed")} disabled={saving} className={BTN}>
            <Check className="size-3.5" /> Confirm
          </button>
          <button onClick={publish} disabled={!canPublish} title={publishHint} className={BTN + (alreadyPublished ? " border-positive/40 text-positive" : " border-foreground text-foreground")}>
            {saving ? <Loader2 className="size-3.5 animate-spin" /> : alreadyPublished ? <Check className="size-3.5" /> : <Send className="size-3.5" />}
            {alreadyPublished ? "Update on Connecteam" : "Publish to Connecteam"}
          </button>
          {!isNew && (
            <button onClick={previewPacket} disabled={packetLoading} title="Preview the shift packet each worker would receive (sending is off by default)." className={BTN}>
              {packetLoading ? <Loader2 className="size-3.5 animate-spin" /> : <FileText className="size-3.5" />} Preview packet
            </button>
          )}
          {!isNew && (
            <button onClick={remove} disabled={saving} className={BTN + " ml-auto text-critical hover:text-critical"}>
              <Trash2 className="size-3.5" /> Delete
            </button>
          )}
        </div>
        <p className="mt-1.5 text-[11px] text-meta">
          {alreadyPublished
            ? "On Connecteam — editing and re-publishing updates the crew's shift and re-notifies them."
            : `Publishing notifies the assigned crew in Connecteam. ${publishHint}. The Instawork gap-fill is a separate step (coming next).`}
        </p>
      </div>
    </div>
  );
}
