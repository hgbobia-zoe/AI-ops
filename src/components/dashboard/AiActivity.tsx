"use client";

// AI activity — a COMPACT, honest summary of the AI workforce with an expandable feed. It replaces the
// old right-rail list that trusted the raw status column: a session stuck in `running` for 14 days was
// counted as "live". Here "active" means a trustworthy current heartbeat (classifyAiActivity), and a
// working-status session with no recent activity is shown honestly as "Idle" with its real last-activity
// age — never silently marked completed, never inflated into the live count.
//
// Freshness is computed from a single server-supplied `nowMs`, so SSR and hydration agree (no mismatch);
// the parent page auto-refreshes, which re-reads the clock.

import { useState } from "react";
import Link from "next/link";
import { Bot, ArrowRight, ChevronDown } from "lucide-react";
import { StatusBadge } from "@/components/ui/status";
import { StaleBadge } from "@/components/ui/states";
import type { SessionStatus } from "@/lib/ai/sessions";
import { classifyAiActivity, summarizeAiActivity, type AiActivityState } from "@/lib/command/aiActivity";

export interface AiActivityItem {
  id: string;
  title: string;
  blade: string | null;
  status: SessionStatus;
  updatedAt: string | null;
}

const RANK: Record<AiActivityState, number> = { active: 0, waiting: 1, idle: 2, paused: 3, error: 4, completed: 5, cancelled: 6 };

function ago(iso: string | null, nowMs: number): string {
  if (!iso) return "—";
  const m = Math.round((nowMs - Date.parse(iso)) / 60000);
  if (!Number.isFinite(m)) return "—";
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function AiActivity({
  items,
  nowMs,
  pendingApprovals,
  href = "/ai-command",
}: {
  items: AiActivityItem[];
  nowMs: number;
  pendingApprovals: number;
  href?: string;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);

  const counts = summarizeAiActivity(items, nowMs);
  const sorted = [...items]
    .map((it) => ({ it, c: classifyAiActivity(it.status, it.updatedAt, nowMs) }))
    .sort((a, b) => RANK[a.c.state] - RANK[b.c.state] || Date.parse(b.it.updatedAt ?? "") - Date.parse(a.it.updatedAt ?? ""));

  const COLLAPSED = 5;
  const visible = expanded ? sorted : sorted.slice(0, COLLAPSED);

  // Honest summary chips — "active" is the trustworthy heartbeat count; idle is called out, never hidden.
  // Static dot classes (no dynamic class names, so Tailwind keeps them).
  const summaryBits: { label: string; dot: string }[] = [];
  if (counts.active > 0) summaryBits.push({ label: `${counts.active} active`, dot: "bg-status-syncing" });
  if (counts.waiting > 0) summaryBits.push({ label: `${counts.waiting} awaiting approval`, dot: "bg-status-warning" });
  if (counts.idle > 0) summaryBits.push({ label: `${counts.idle} idle`, dot: "bg-status-neutral" });

  return (
    <section className="surface flex flex-col border p-3">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="flex min-w-0 items-center gap-1.5 text-[11.5px] font-semibold uppercase tracking-[0.06em] text-tertiary-text">
          <Bot className="size-4 shrink-0 text-meta" /> AI activity
        </h2>
        {counts.active > 0 ? (
          <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-status-syncing">
            <span className="size-1.5 rounded-full bg-status-syncing" aria-hidden /> {counts.active} active
          </span>
        ) : (
          <span className="text-[10px] uppercase tracking-wide text-meta">idle</span>
        )}
        <Link href={href} className="ml-auto inline-flex items-center gap-0.5 text-[11px] text-meta transition-colors hover:text-foreground">
          View all <ArrowRight className="size-3" />
        </Link>
      </div>

      {/* Honest one-line rollup. Never "N live" — active/waiting/idle are distinct and real. */}
      <p className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-secondary-text">
        {summaryBits.length === 0 ? (
          <span className="text-meta">No active AI sessions.</span>
        ) : (
          summaryBits.map((b, i) => (
            <span key={b.label} className="inline-flex items-center gap-1.5">
              {i > 0 && <span className="text-meta" aria-hidden>·</span>}
              <span className={`size-1.5 rounded-full ${b.dot}`} aria-hidden />
              {b.label}
            </span>
          ))
        )}
        {pendingApprovals > 0 && (
          <Link href="/ai-command" className="inline-flex items-center gap-1.5 text-attention hover:underline">
            <span className="text-meta" aria-hidden>·</span>
            {pendingApprovals} pending approval{pendingApprovals === 1 ? "" : "s"}
          </Link>
        )}
      </p>

      {sorted.length === 0 ? (
        <p className="py-4 text-[12px] text-meta">
          No AI sessions yet. <Link href={href} className="text-tertiary-text hover:text-foreground">Open the AI Command Center →</Link>
        </p>
      ) : (
        <>
          <ul className="space-y-0.5" role="list">
            {visible.map(({ it, c }) => (
              <li key={it.id}>
                <Link href={`${href}/${it.id}`} className="flex items-center gap-2 rounded px-1.5 py-1.5 transition-colors hover:bg-[var(--row-hover)]">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12px] font-medium text-foreground">{it.title}</span>
                    <span className="block truncate text-[10.5px] text-meta">{it.blade ?? "cross-blade"}</span>
                  </span>
                  <span className="flex shrink-0 flex-col items-end gap-0.5">
                    <StatusBadge tone={c.tone} size="sm" animated={c.state === "active"}>{c.label}</StatusBadge>
                    {c.stale ? (
                      <StaleBadge>last activity {ago(it.updatedAt, nowMs)}</StaleBadge>
                    ) : (
                      <span className="text-[10px] text-meta">{ago(it.updatedAt, nowMs)}</span>
                    )}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          {sorted.length > COLLAPSED && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
              className="mt-1.5 inline-flex items-center gap-1 self-start rounded px-1.5 py-1 text-[11px] text-tertiary-text transition-colors hover:text-foreground"
            >
              <ChevronDown className={`size-3.5 transition-transform ${expanded ? "rotate-180" : ""}`} aria-hidden />
              {expanded ? "Show fewer" : `Show all ${sorted.length}`}
            </button>
          )}
        </>
      )}
    </section>
  );
}
