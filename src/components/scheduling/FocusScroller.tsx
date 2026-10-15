"use client";

// Cross-blade deep-link helper. When Dispatch links in with ?focus=<routeId> ("Find staffing" / "Plan in
// Scheduling"), bring the staffing board into view and briefly flash it, so the user lands on the day's
// staffing workspace instead of having to re-search. The smallest reliable enhancement over the existing
// #staffing-board anchor (no change to the board's own logic).

import { useEffect } from "react";

export function FocusScroller({ focus }: { focus: string | null }): null {
  useEffect(() => {
    if (!focus) return;
    const el = document.getElementById("staffing-board");
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    el.classList.add("ring-2", "ring-ring", "ring-offset-0");
    const t = setTimeout(() => el.classList.remove("ring-2", "ring-ring", "ring-offset-0"), 2200);
    return () => clearTimeout(t);
  }, [focus]);
  return null;
}
