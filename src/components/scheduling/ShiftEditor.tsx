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
import { Loader2, Check, Trash2, X, Send } from "lucide-react";
import type { CrewMember } from "@/lib/connecteam";
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
  onClose,
}: {
  shift: StaffShift | null;
  date: string; // the day being edited (for a new shift)
  roster: CrewMember[];
  busyUserIds: number[];
  onClose: () => void;
}): React.JSX.Element {
  const router = useRouter();
  const isNew = shift == null;
  const [draft, setDraft] = useState<Draft>(() => toDraft(shift));
  const [instaTouched, setInstaTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useMemo(() => new Set(busyUserIds), [busyUserIds]);

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
          <div className="flex flex-col">
            <button type="button" disabled title="Wired next" className={BTN + " opacity-50"}>
              <Send className="size-3.5" /> Send to Connecteam + Instawork
            </button>
          </div>
          {!isNew && (
            <button onClick={remove} disabled={saving} className={BTN + " ml-auto text-critical hover:text-critical"}>
              <Trash2 className="size-3.5" /> Delete
            </button>
          )}
        </div>
        <p className="mt-1.5 text-[11px] text-meta">External push is wired next.</p>
      </div>
    </div>
  );
}
