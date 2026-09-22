"use client";

// The lead side panel — the Sales board's card detail as an OVERLAY drawer (via the shared
// SidePanelOverlay, the app-wide kanban standard). Wraps the full-lead panel.

import { SidePanelOverlay } from "@/components/SidePanelOverlay";
import { LeadFullPanel } from "@/components/LeadFullPanel";

export function LeadSidePanel({ id, viewer, onClose }: { id: string; viewer: { name: string; quoUserId: string | null; initials: string }; onClose: () => void }): React.JSX.Element {
  return (
    <SidePanelOverlay onClose={onClose}>
      <LeadFullPanel id={id} viewer={viewer} onClose={onClose} />
    </SidePanelOverlay>
  );
}
