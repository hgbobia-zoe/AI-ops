"use client";

// "Push hours to Gusto" — ON-DEMAND, DRAFT-ONLY payroll-hours push. Owner/admin only (the whole /payroll
// blade is canManagePayroll-gated). It (1) asks the server to BUILD the payload (only MAPPED + NOT-BLOCKED
// workers with hours, with the OT split), (2) confirms with the human, then (3) hands the entries to the
// Auto-Pull extension via the same chrome.runtime idiom as SyncGustoButton ({type:"zoe-gusto-push"}). The
// extension opens ONE hidden Gusto tab, writes the hours into the CURRENT DRAFT run by replaying Gusto's
// AutoSaveWorkedHours mutation, POSTs the outcome to /api/payroll/gusto/push-result, and closes the tab.
//
// HARD SAFETY (surfaced to the user): this writes hours into the Gusto DRAFT only. It NEVER submits, runs,
// or approves payroll. HONEST: it never claims "pushed" — the real status comes from the push-result ledger
// (lastPush), passed from the server. If the extension isn't here, or the run isn't a DRAFT, the status
// simply won't advance.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Upload, Loader2 } from "lucide-react";
import { EXTENSION_ID } from "@/lib/extensionId";

const REFRESH_DELAY_MS = 12000; // the push loops a mutation per worker in a hidden tab; give it a moment

interface ChromeRuntimeLike {
  runtime?: {
    sendMessage?: (extensionId: string, message: unknown, callback?: (response: unknown) => void) => void;
    lastError?: { message?: string };
  };
}

interface PushPayload {
  entries: { gustoMemberId: string; name: string; regularHours: number; overtimeHours: number; doubleOvertimeHours: number }[];
  mappedCount: number;
  skipped: { name: string; reason: string }[];
  totals: { regular: number; overtime: number };
  period: { start: string; end: string; label: string };
  which: "current" | "previous";
}

function relTime(iso: string | null): string | null {
  if (!iso) return null;
  const d = Date.parse(iso);
  if (!Number.isFinite(d)) return null;
  const m = Math.round((Date.now() - d) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function PushGustoHoursButton({
  which,
  disabled = false,
  lastPush = null,
}: {
  which: "current" | "previous";
  disabled?: boolean;
  lastPush?: { at: string; ok: boolean; aborted: string | null; pushed: number; skipped: number; failed: number } | null;
}): React.JSX.Element {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function push(): Promise<void> {
    const chromeApi = (window as unknown as { chrome?: ChromeRuntimeLike }).chrome;
    const hasExtension = !!chromeApi?.runtime && typeof chromeApi.runtime.sendMessage === "function";
    if (!hasExtension) {
      toast.error("Auto-Pull extension not found in this browser", {
        description: "The Gusto push runs from the office machine that has the extension and a signed-in Gusto.",
      });
      return;
    }

    setBusy(true);
    try {
      // 1) Build the payload server-side (owner/admin gated; honors the GUSTO_PUSH_DISABLED kill switch).
      const res = await fetch("/api/payroll/gusto/push-payload", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ which }),
      });
      const data = (await res.json().catch(() => null)) as (PushPayload & { error?: string }) | null;
      if (!res.ok || !data) {
        toast.error(data?.error ?? "Couldn't build the push payload.");
        setBusy(false);
        return;
      }
      if (data.mappedCount === 0) {
        toast.error("No mapped, unblocked workers with hours to push.", {
          description: data.skipped.length ? `${data.skipped.length} worker(s) skipped (unmapped/blocked/no hours).` : undefined,
        });
        setBusy(false);
        return;
      }

      // 2) Confirm — be explicit that this is DRAFT-only and does NOT submit payroll.
      const ok = window.confirm(
        `Write hours into the Gusto DRAFT for ${data.mappedCount} mapped worker${data.mappedCount === 1 ? "" : "s"} ` +
          `(${data.totals.regular}h regular + ${data.totals.overtime}h overtime, period ${data.period.label}).\n\n` +
          `It does NOT submit, run, or approve payroll — it only fills the draft. ` +
          `${data.skipped.length ? `${data.skipped.length} worker(s) will be skipped (unmapped/blocked/no hours).` : ""}\n\nContinue?`,
      );
      if (!ok) {
        setBusy(false);
        return;
      }

      // 3) Hand the entries to the extension. It opens a hidden Gusto tab, writes the DRAFT, posts the result.
      toast.loading("Pushing hours into the Gusto draft…", { id: "push-gusto" });
      const payload = { which, period: data.period, entries: data.entries };
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        setBusy(false);
      };
      chromeApi!.runtime!.sendMessage!(EXTENSION_ID, { type: "zoe-gusto-push", payload }, (response) => {
        if (chromeApi!.runtime?.lastError) {
          toast.error("Couldn't reach the Auto-Pull extension", { id: "push-gusto", description: "Make sure it's installed and enabled (v1.15.0+)." });
          done();
          return;
        }
        void response;
        setTimeout(() => {
          router.refresh();
          toast.success("Push started — status updates when the extension reports back.", { id: "push-gusto" });
          done();
        }, REFRESH_DELAY_MS);
      });
      // Safety: never leave the button spinning if the extension never calls back.
      setTimeout(done, 25000);
    } catch {
      toast.error("Couldn't start the Gusto push.");
      setBusy(false);
    }
  }

  const last = relTime(lastPush?.at ?? null);
  return (
    <div className="flex flex-col items-end gap-1">
      <button
        onClick={push}
        disabled={busy || disabled}
        title="Write reconciled hours into the current Gusto DRAFT payroll run (never submits payroll)"
        className="inline-flex h-8 items-center justify-center gap-2 rounded-md border border-border px-3 text-[12.5px] font-medium text-secondary-text transition-colors hover:bg-[var(--row-hover)] hover:text-foreground disabled:opacity-60"
      >
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
        {busy ? "Pushing…" : "Push hours to Gusto"}
      </button>
      <span className="text-[11px] text-meta">
        {disabled ? (
          "Push disabled (GUSTO_PUSH_DISABLED)"
        ) : lastPush?.aborted === "not_logged_in" ? (
          <span className="text-amber-300">Sign in to Gusto (tab opened), then push again</span>
        ) : last ? (
          <>
            Last push {last}
            {lastPush?.aborted ? ` · aborted (${lastPush.aborted})` : lastPush?.ok ? ` · ${lastPush.pushed} pushed` : " · needs attention"}
          </>
        ) : (
          "Never pushed · DRAFT only"
        )}
      </span>
    </div>
  );
}
