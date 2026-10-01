// Integration-health card for the Ubersuggest MCP boundary. Driven ENTIRELY by the boundary's reported
// status — it never fabricates a "connected" state. A missing credential renders an honest
// "Not configured" card. Server component (pure render of SeoHealth).

import Link from "next/link";
import { Search } from "lucide-react";
import { StatusMark } from "@/components/console-primitives";
import type { SeoHealth, SeoHealthStatus } from "@/lib/seo/types";

const TONE: Record<SeoHealthStatus, "positive" | "attention" | "critical" | "idle"> = {
  ok: "positive",
  stale: "attention",
  error: "critical",
  not_configured: "idle",
  never: "idle",
};

function ago(iso: string | null): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "unknown";
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

export function SeoHealthCard({ health }: { health: SeoHealth }): React.JSX.Element {
  return (
    <div className="rounded border border-border p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <Search className="size-4 text-meta" />
          <div>
            <div className="text-[13px] font-medium text-foreground">Ubersuggest MCP</div>
            <div className="text-[11px] uppercase tracking-[0.08em] text-meta">Keyword research</div>
          </div>
        </div>
        <StatusMark tone={TONE[health.status]} label={health.headline} />
      </div>

      <p className="mt-3 text-[12.5px] leading-relaxed text-tertiary-text">{health.detail}</p>

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 border-t border-[var(--row-rule)] pt-3 text-[12px]">
        <dt className="text-meta">Credential</dt>
        <dd className="text-right text-foreground">{health.configured ? "Set" : "Not set"}</dd>
        <dt className="text-meta">Last successful retrieval</dt>
        <dd className={`text-right tabular-nums ${health.lastSuccessAt ? "text-foreground" : "text-meta"}`}>{ago(health.lastSuccessAt)}</dd>
        <dt className="text-meta">Last attempt</dt>
        <dd className={`text-right tabular-nums ${health.lastAttemptAt ? "text-foreground" : "text-meta"}`}>{ago(health.lastAttemptAt)}</dd>
        {health.lastError && (
          <>
            <dt className="text-meta">Last error</dt>
            <dd className="truncate text-right text-critical" title={health.lastError}>{health.lastError}</dd>
          </>
        )}
      </dl>

      {!health.configured && (
        <Link href="/admin" className="mt-3 inline-block text-[12px] text-meta transition-colors hover:text-foreground">
          Open settings to connect →
        </Link>
      )}
    </div>
  );
}
