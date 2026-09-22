"use client";

// Post-Event board card detail as an OVERLAY drawer — the same shared side panel the Sales board uses,
// so both kanbans behave and look identical. Opens over the board (columns stay put), closes on backdrop
// / Escape / ✕. onChanged lets the board re-sync after a state change made inside the panel.

import { SidePanelOverlay } from "@/components/SidePanelOverlay";
import { PostEventDetail } from "@/components/postevent/PostEventDetail";

export function PostEventSidePanel({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged?: () => void }): React.JSX.Element {
  return (
    <SidePanelOverlay onClose={onClose}>
      <PostEventDetail id={id} variant="panel" onClose={onClose} onChanged={onChanged} />
    </SidePanelOverlay>
  );
}
