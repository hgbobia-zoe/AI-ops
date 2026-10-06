// Shared display vocabulary for AI session status — plain data (NO "use client"), so both server
// components (the workspace page) and client components (the console) can import it. Keeps the status
// dot / label / tone identical everywhere. Nocturne tokens only.

import type { SessionStatus } from "@/lib/ai/sessions";

export const STATUS_META: Record<SessionStatus, { label: string; dot: string; text: string }> = {
  running: { label: "Working", dot: "bg-positive", text: "text-positive" },
  awaiting_approval: { label: "Needs approval", dot: "bg-attention", text: "text-attention" },
  paused: { label: "Paused", dot: "bg-[var(--bar-2)]", text: "text-tertiary-text" },
  done: { label: "Completed", dot: "bg-[var(--bar)]", text: "text-meta" },
  failed: { label: "Error", dot: "bg-critical", text: "text-critical" },
  cancelled: { label: "Cancelled", dot: "bg-[var(--bar)]", text: "text-meta" },
};
