"use client";

// The shared kanban/detail side panel: a wide panel that slides in over the current view (board,
// worklist, or table) with a dim backdrop, so there's full room to work without the columns shrinking.
// Click the backdrop or press Escape to close. This is the app-wide standard — every kanban opens its
// card detail through this overlay (Sales, Post-Event, and any future board), so they all match.

import { useEffect } from "react";

export function SidePanelOverlay({
  onClose,
  children,
  widthClass = "max-w-[42rem]",
}: {
  onClose: () => void;
  children: React.ReactNode;
  widthClass?: string;
}): React.JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} aria-hidden />
      <div className={`absolute inset-y-0 right-0 w-full ${widthClass} shadow-2xl`}>{children}</div>
    </div>
  );
}
