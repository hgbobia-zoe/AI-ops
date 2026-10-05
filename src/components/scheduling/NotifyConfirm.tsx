"use client";

// Human confirm gate for assignment texts. Given a list of {shiftId, userId, kind}, it dry-runs
// /api/scheduling/notify to preview each recipient + the drafted message, lets the dispatcher Send or Skip
// each row (default Send for a sendable row; disabled with the honest reason when a worker has no phone or
// the provider is off), then sends ONLY the chosen rows with confirm:true and shows the honest per-row
// result. Nothing sends until Send is tapped, and Skipping every row still leaves the assignment intact.
//
// Comms style: no dashes, no emoji in any worker-facing text (the drafted bodies come from the server's
// deterministic builder).

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, X, Check } from "lucide-react";
import type { NotifyNotice, NotifyDryRunRow, NotifySendResult } from "@/lib/scheduling/assignNotify";

function keyOf(n: { shiftId: string; userId: number; kind: string }): string {
  return `${n.shiftId}:${n.userId}:${n.kind}`;
}

type Phase = "loading" | "review" | "sending" | "done";

const STATE_TONE: Record<NotifySendResult["state"], string> = {
  sent: "text-positive",
  skipped: "text-meta",
  failed: "text-critical",
};

export function NotifyConfirm({
  notices,
  onClose,
  title = "Notify the team",
}: {
  notices: NotifyNotice[];
  onClose: () => void;
  title?: string;
}): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>("loading");
  const [rows, setRows] = useState<NotifyDryRunRow[]>([]);
  const [choice, setChoice] = useState<Record<string, boolean>>({});
  const [results, setResults] = useState<NotifySendResult[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Dry-run on open: preview every message without sending anything.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch("/api/scheduling/notify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ notices }),
        });
        const j = (await res.json().catch(() => null)) as { ok?: boolean; notices?: NotifyDryRunRow[] } | null;
        if (!alive) return;
        if (!res.ok || !j?.ok) {
          setError("Couldn't prepare the messages. Try again.");
          setPhase("review");
          return;
        }
        const rs = j.notices ?? [];
        setRows(rs);
        const init: Record<string, boolean> = {};
        for (const r of rs) init[keyOf(r)] = r.sendable; // default Send for sendable rows
        setChoice(init);
        setPhase("review");
      } catch {
        if (!alive) return;
        setError("Couldn't prepare the messages. Try again.");
        setPhase("review");
      }
    })();
    return () => {
      alive = false;
    };
  }, [notices]);

  const sendableRows = rows.filter((r) => r.sendable);
  const chosenRows = sendableRows.filter((r) => choice[keyOf(r)]);

  function setAll(on: boolean): void {
    setChoice((prev) => {
      const next = { ...prev };
      for (const r of sendableRows) next[keyOf(r)] = on;
      return next;
    });
  }

  async function send(): Promise<void> {
    if (chosenRows.length === 0) {
      onClose();
      return;
    }
    setPhase("sending");
    setError(null);
    try {
      const res = await fetch("/api/scheduling/notify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          confirm: true,
          notices: chosenRows.map((r) => ({ shiftId: r.shiftId, userId: r.userId, kind: r.kind })),
        }),
      });
      const j = (await res.json().catch(() => null)) as { ok?: boolean; results?: NotifySendResult[] } | null;
      if (!res.ok || !j?.ok) {
        setError("Send failed. Try again.");
        setPhase("review");
        return;
      }
      const rs = j.results ?? [];
      setResults(rs);
      setPhase("done");
      const sent = rs.filter((r) => r.state === "sent").length;
      const failed = rs.filter((r) => r.state === "failed").length;
      if (failed > 0) toast.message(`${sent} sent, ${failed} failed.`);
      else toast.success(sent === 1 ? "1 text sent." : `${sent} texts sent.`);
    } catch {
      setError("Send failed. Try again.");
      setPhase("review");
    }
  }

  const resultByKey = new Map(results.map((r) => [keyOf(r), r]));

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} aria-hidden />
      <div className="relative z-[61] flex max-h-[85vh] w-full max-w-lg flex-col rounded-lg border border-border bg-background shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
          <div className="min-w-0">
            <h2 className="truncate text-[15px] font-medium text-foreground">{title}</h2>
            <p className="truncate text-[12px] text-meta">
              {phase === "done" ? "Result" : "Review each message. Nothing sends until you tap Send."}
            </p>
          </div>
          <button onClick={onClose} aria-label="Close" className="flex size-8 items-center justify-center rounded border border-border text-tertiary-text transition-colors hover:bg-[var(--row-hover)] hover:text-foreground">
            <X className="size-4" />
          </button>
        </div>

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {phase === "loading" ? (
            <div className="flex items-center gap-2 py-6 text-[13px] text-meta">
              <Loader2 className="size-4 animate-spin" /> Preparing messages...
            </div>
          ) : rows.length === 0 ? (
            <p className="py-4 text-[13px] text-meta">No one to notify for this change.</p>
          ) : (
            <ul className="space-y-2.5">
              {rows.map((r) => {
                const k = keyOf(r);
                const result = resultByKey.get(k);
                const on = Boolean(choice[k]);
                return (
                  <li key={k} className="rounded border border-border p-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate text-[13px]">
                        <span className="font-medium text-foreground">{r.name}</span>
                        <span className="ml-1.5 text-[11px] uppercase tracking-[0.05em] text-meta">{r.kind}</span>
                        {r.phoneMasked && <span className="ml-1.5 text-[11px] text-meta">{r.phoneMasked}</span>}
                      </span>
                      {phase === "done" && result ? (
                        <span className={`shrink-0 text-[11.5px] font-medium uppercase tracking-[0.05em] ${STATE_TONE[result.state]}`}>
                          {result.state}
                        </span>
                      ) : r.sendable ? (
                        <button
                          type="button"
                          onClick={() => setChoice((p) => ({ ...p, [k]: !on }))}
                          disabled={phase === "sending"}
                          className={`shrink-0 rounded border px-2 py-0.5 text-[11.5px] transition-colors disabled:opacity-50 ${on ? "border-foreground bg-foreground/[0.08] text-foreground" : "border-border text-meta hover:bg-[var(--row-hover)]"}`}
                        >
                          {on ? "Send" : "Skip"}
                        </button>
                      ) : (
                        <span className="shrink-0 text-[11px] text-attention">not sent</span>
                      )}
                    </div>
                    {r.body ? (
                      <p className="mt-1.5 rounded bg-[var(--row-hover)]/40 px-2 py-1.5 text-[12px] leading-relaxed text-tertiary-text">{r.body}</p>
                    ) : null}
                    {!r.sendable && r.reason && <p className="mt-1 text-[11px] text-attention">{r.reason}</p>}
                    {phase === "done" && result?.reason && <p className="mt-1 text-[11px] text-meta">{result.reason}</p>}
                  </li>
                );
              })}
            </ul>
          )}
          {error && <p className="mt-3 text-[12.5px] text-critical">{error}</p>}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 border-t border-border px-5 py-3">
          {phase === "done" ? (
            <button onClick={onClose} className="inline-flex items-center gap-1.5 rounded border border-foreground px-3.5 py-1.5 text-[12.5px] font-medium text-foreground transition-colors hover:bg-foreground/[0.08]">
              <Check className="size-3.5" /> Done
            </button>
          ) : (
            <>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setAll(true)}
                  disabled={phase !== "review" || sendableRows.length === 0}
                  className="rounded border border-border px-2.5 py-1 text-[12px] text-tertiary-text transition-colors hover:bg-[var(--row-hover)] hover:text-foreground disabled:opacity-50"
                >
                  Send all
                </button>
                <button
                  type="button"
                  onClick={() => setAll(false)}
                  disabled={phase !== "review" || sendableRows.length === 0}
                  className="rounded border border-border px-2.5 py-1 text-[12px] text-tertiary-text transition-colors hover:bg-[var(--row-hover)] hover:text-foreground disabled:opacity-50"
                >
                  Skip all
                </button>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={onClose} className="rounded border border-border px-3 py-1.5 text-[12px] text-tertiary-text transition-colors hover:bg-[var(--row-hover)] hover:text-foreground">
                  Skip and close
                </button>
                <button
                  onClick={send}
                  disabled={phase === "loading" || phase === "sending"}
                  className="inline-flex items-center gap-1.5 rounded border border-foreground px-3.5 py-1.5 text-[12.5px] font-medium text-foreground transition-colors hover:bg-foreground/[0.08] disabled:opacity-50"
                >
                  {phase === "sending" ? <Loader2 className="size-3.5 animate-spin" /> : null}
                  {chosenRows.length > 0 ? `Send ${chosenRows.length} text${chosenRows.length === 1 ? "" : "s"}` : "Send"}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
