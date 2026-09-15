"use client";

// The lead side panel as an OVERLAY drawer — a wide panel that slides over the current view (board,
// worklist, or table) with a dim backdrop, so there's full room to work without the columns or table
// shrinking. Click the backdrop or press Escape to close. Wraps the shared full-lead panel.

import { LeadFullPanel } from "@/components/LeadFullPanel";

export function LeadSidePanel({ id, viewer, onClose }: { id: string; viewer: { name: string; quoUserId: string | null; initials: string }; onClose: () => void }): React.JSX.Element {
  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} aria-hidden />
      <div className="absolute inset-y-0 right-0 w-full max-w-[42rem] shadow-2xl">
        <LeadFullPanel id={id} viewer={viewer} onClose={onClose} />
      </div>
    </div>
  );
}
