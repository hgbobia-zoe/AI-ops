"use client";

// Bring a Scheduling section into view even when it lives in the other view tab or a closed <details>:
// switch the tab (SchedulingViews listens for VIEW_EVENT), open every enclosing <details>, then scroll.

export const VIEW_EVENT = "scheduling:view";

export function revealTarget(id: string): void {
  const el = document.getElementById(id);
  if (!el) return;
  const panel = el.closest<HTMLElement>("[data-view-panel]");
  if (panel?.hidden) window.dispatchEvent(new CustomEvent(VIEW_EVENT, { detail: panel.dataset.viewPanel }));
  let d: HTMLDetailsElement | null = el.closest("details");
  while (d) {
    d.open = true;
    d = d.parentElement?.closest("details") ?? null;
  }
  setTimeout(() => el.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
}
