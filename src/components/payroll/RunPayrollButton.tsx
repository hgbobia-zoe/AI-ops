"use client";

// "Run payroll" — the IRREVERSIBLE submit trigger on /payroll (Review tab), next to Approve + Push hours.
// Admin-only (the whole blade is canManagePayroll-gated AND this trigger is canRunPayroll-gated server-side).
// Flow, mirroring PushGustoHoursButton but for a REAL run: (1) ask the server to build the confirm CONTEXT
// (period, grand total, headcount, target check-date) via /submit-payload — which also re-checks the Admin
// gate, the GUSTO_SUBMIT_DISABLED kill switch, and the ledger (never a second submit); (2) show a HARD
// confirm stating the real numbers + the wire-only warning; (3) hand it to the Auto-Pull extension
// ({type:"zoe-gusto-submit"}), which submits via SubmitDraftPayroll (WIRE ONLY) in the logged-in Gusto tab.
//
// ╔══════════════════════════════════════════════════════════════════════════════════════════════════════╗
// ║ HIGH STAKES. SubmitDraftPayroll RUNS REAL PAYROLL and creates a wire obligation. It is IRREVERSIBLE.   ║
// ║ The hard confirm (with the real period + total + headcount) is MANDATORY — a wrong-week submit         ║
// ║ actually happened in testing. Nothing here auto-submits: the Admin clicks, reads the numbers, confirms.║
// ╚══════════════════════════════════════════════════════════════════════════════════════════════════════╝

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { PlayCircle, Loader2 } from "lucide-react";
import { EXTENSION_ID } from "@/lib/extensionId";

const REFRESH_DELAY_MS = 14000; // the submit drives a hidden tab (optional safe-expedite step → submit); give it a moment

interface ChromeRuntimeLike {
  runtime?: {
    sendMessage?: (extensionId: string, message: unknown, callback?: (response: unknown) => void) => void;
    lastError?: { message?: string };
  };
}

interface SubmitContextResponse {
  which: "current" | "previous";
  period: { start: string; end: string; label: string };
  checkDate: string;
  expectedTotal: number | null;
  headcount: number;
  approved: boolean;
  alreadySubmitted: boolean;
  canRun: boolean;
  reason: string;
  initiatedBy: string | null;
  error?: string;
}

function usd(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "an estimate shown in Gusto";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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

export function RunPayrollButton({
  which,
  disabled = false,
  lastSubmit = null,
}: {
  which: "current" | "previous";
  disabled?: boolean; // GUSTO_SUBMIT_DISABLED
  lastSubmit?: { at: string; ok: boolean; submitted: boolean; aborted: string | null } | null;
}): React.JSX.Element {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function run(): Promise<void> {
    const chromeApi = (window as unknown as { chrome?: ChromeRuntimeLike }).chrome;
    const hasExtension = !!chromeApi?.runtime && typeof chromeApi.runtime.sendMessage === "function";
    if (!hasExtension) {
      toast.error("Auto-Pull extension not found in this browser", {
        description: "Run payroll from the Chrome that has the extension and a signed-in Gusto.",
      });
      return;
    }

    setBusy(true);
    try {
      // 1) Build the confirm context server-side (Admin-gated; kill switch + ledger re-checked there).
      const res = await fetch("/api/payroll/gusto/submit-payload", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ which }),
      });
      const data = (await res.json().catch(() => null)) as SubmitContextResponse | null;
      if (!res.ok || !data) {
        toast.error(data?.error ?? "Couldn't build the payroll submit context.");
        setBusy(false);
        return;
      }
      if (!data.canRun) {
        toast.error(data.reason || "Payroll can't be run for this period yet.");
        setBusy(false);
        return;
      }

      // 2) HARD confirm — the real numbers + the wire-only warning. MANDATORY.
      const ok = window.confirm(
        `RUN PAYROLL for ${data.period.label}?\n\n` +
          `Pay period: ${data.period.start} to ${data.period.end}\n` +
          `Check date: ${data.checkDate}\n` +
          `Grand total: ${usd(data.expectedTotal)} (estimate)\n` +
          `Workers: ${data.headcount}\n\n` +
          `This submits payroll in Gusto and commits a wire obligation. It does not move money. ` +
          `Wire by wire transfer only.\n\nThis cannot be undone. Continue?`,
      );
      if (!ok) {
        setBusy(false);
        return;
      }

      // 3) Hand it to the extension. It submits via SubmitDraftPayroll (WIRE ONLY) + posts the result back.
      toast.loading("Submitting payroll in Gusto…", { id: "run-payroll" });
      const payload = {
        which,
        period: data.period,
        checkDate: data.checkDate,
        expectedTotal: data.expectedTotal,
        headcount: data.headcount,
        initiatedBy: data.initiatedBy,
      };
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        setBusy(false);
      };
      chromeApi!.runtime!.sendMessage!(EXTENSION_ID, { type: "zoe-gusto-submit", payload }, () => {
        if (chromeApi!.runtime?.lastError) {
          toast.error("Couldn't reach the Auto-Pull extension", { id: "run-payroll", description: "Make sure it's installed and enabled (v1.16.0+)." });
          done();
          return;
        }
        setTimeout(() => {
          router.refresh();
          toast.success("Submit started — status updates when the extension reports back.", { id: "run-payroll" });
          done();
        }, REFRESH_DELAY_MS);
      });
      setTimeout(done, 30000); // never leave the button spinning if the extension never calls back
    } catch {
      toast.error("Couldn't start the payroll submit.");
      setBusy(false);
    }
  }

  const last = relTime(lastSubmit?.at ?? null);
  return (
    <div className="flex flex-col items-end gap-1">
      <button
        onClick={run}
        disabled={busy || disabled}
        title="Submit payroll in Gusto (wire only). This runs real payroll and is irreversible."
        className="inline-flex h-8 items-center justify-center gap-2 rounded-md border border-critical/50 bg-critical/10 px-3 text-[12.5px] font-medium text-critical transition-colors hover:bg-critical/15 disabled:opacity-60"
      >
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : <PlayCircle className="size-3.5" />}
        {busy ? "Submitting…" : "Run payroll"}
      </button>
      <span className="text-[11px] text-meta">
        {disabled ? (
          "Submit disabled (GUSTO_SUBMIT_DISABLED)"
        ) : lastSubmit?.aborted === "not_logged_in" ? (
          <span className="text-amber-300">Sign in to Gusto (tab opened), then run again</span>
        ) : lastSubmit && last ? (
          <>
            Last submit {last}
            {lastSubmit.aborted ? ` · aborted (${lastSubmit.aborted})` : lastSubmit.submitted ? " · submitted" : " · needs attention"}
          </>
        ) : (
          "Runs real payroll · wire only · irreversible"
        )}
      </span>
    </div>
  );
}
