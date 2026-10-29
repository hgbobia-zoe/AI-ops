// needs_review conflict panel — the on-screen surface for two-way-sync conflicts. For each shift flagged
// staff_shifts.sync_status = 'needs_review', it shows the APP version vs the CONNECTEAM version side by side
// (assignees, window, role/title) with each side's edit time, plus the sync_note (why it was flagged), and a
// per-shift resolve control to pick the winner. Honest: when Connecteam is unreachable it shows the stored
// snapshot and the "keep Connecteam" apply is disabled (see ResolveSyncButtons).
//
// Server component (consistent with ConnecteamScheduleMirror / ScheduledToRoutePrompt). Comms style: no
// em-dashes as punctuation, no emoji.

import { AlertTriangle } from "lucide-react";
import { formatClockTime } from "@/lib/dates";
import { ResolveSyncButtons } from "@/components/scheduling/ResolveSyncButtons";
import type { ConflictSide, SyncConflictView } from "@/lib/scheduling/needsReview";

function windowLabel(side: ConflictSide): string {
  if (!side.windowKnown || !side.startTime) return "time not set";
  const s = formatClockTime(side.startTime);
  const e = side.endTime ? formatClockTime(side.endTime) : "";
  return e ? `${s} - ${e}` : s;
}

function editedLabel(iso: string | null): string {
  if (!iso) return "edit time unknown";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "edit time unknown";
  return `edited ${d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`;
}

function SideColumn({ side, label, newer }: { side: ConflictSide; label: string; newer: boolean }): React.JSX.Element {
  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-tertiary-text">{label}</span>
        {newer && <span className="rounded bg-foreground/[0.08] px-1.5 py-0.5 text-[10px] uppercase tracking-[0.05em] text-foreground">newer</span>}
      </div>
      <p className="mt-1 text-[13px] font-medium text-foreground">
        {side.roleLabel ?? "?"}
        {side.title ? <span className="font-normal text-meta"> · {side.title}</span> : null}
      </p>
      <p className="text-[12px] text-meta tabular-nums">{windowLabel(side)}</p>
      <p className="mt-0.5 text-[12.5px]">
        {side.assignees.length === 0 ? <span className="text-meta">no one assigned</span> : side.assignees.map((a) => a.name).join(", ")}
      </p>
      <p className="mt-0.5 text-[11px] text-meta">{editedLabel(side.updatedAt)}</p>
    </div>
  );
}

function StoredSnapshot({ view }: { view: SyncConflictView }): React.JSX.Element {
  return (
    <div className="min-w-0 flex-1">
      <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-tertiary-text">Connecteam</span>
      <p className="mt-1 text-[12.5px] text-meta">
        {view.connecteamReachable
          ? "No matching Connecteam shift (the copy was deleted, unpublished, or moved)."
          : "Connecteam is unreachable right now, so its live version isn't shown."}
      </p>
      <p className="mt-0.5 text-[11px] text-meta">{editedLabel(view.storedLastModified)} (last synced snapshot)</p>
    </div>
  );
}

export function NeedsReviewPanel({ views }: { views: SyncConflictView[] }): React.JSX.Element | null {
  if (views.length === 0) return null;

  return (
    <section className="surface mb-6 border border-border border-l-2 border-l-status-blocked">
      <header className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <AlertTriangle className="size-4 shrink-0 text-status-blocked" aria-hidden />
        <h2 className="text-[13px] font-medium text-foreground">Sync conflicts to review</h2>
        <span className="text-[12px] text-meta">
          {views.length} shift{views.length === 1 ? "" : "s"} changed in both Dispatch and Connecteam and couldn{"’"}t be auto-resolved
        </span>
      </header>
      <p className="px-4 pt-2.5 text-[12px] text-meta">
        Pick which version to keep. Keeping Connecteam applies its version to Dispatch; keeping the app pushes
        the Dispatch version into Connecteam silently (no crew notified). Resolving clears the conflict.
      </p>
      <ul className="divide-y divide-[var(--row-rule)]">
        {views.map((v) => (
          <li key={v.shiftId} className="px-4 py-3">
            {v.syncNote && <p className="mb-2 text-[12px] text-tertiary-text">{v.syncNote}</p>}
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="flex min-w-0 flex-1 flex-wrap gap-x-8 gap-y-2">
                <SideColumn side={v.app} label="Dispatch (app)" newer={v.newerSide === "app"} />
                {v.connecteam ? (
                  <SideColumn side={v.connecteam} label="Connecteam" newer={v.newerSide === "connecteam"} />
                ) : (
                  <StoredSnapshot view={v} />
                )}
              </div>
              <ResolveSyncButtons shiftId={v.shiftId} canKeepApp={v.canKeepApp} canKeepConnecteam={v.canKeepConnecteam} />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
