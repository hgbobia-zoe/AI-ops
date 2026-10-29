"use client";

// "Confirm wire in Gusto" — the step AFTER "Run payroll", used once the human has wired the funds from
// Mercury (the Mercury "wire sent" Slack alert is the cue). Admin-only. It appears only after an
// authoritative submit for the period and before any confirm (never double-confirm). Flow: a hard confirm
// with the amount + date, then hand it to the Auto-Pull extension ({type:"zoe-gusto-confirm-wire"}), which
// runs WireInInstructions (to get the real wireId + amount) then ConfirmWireIn in the logged-in Gusto tab.
//
// The amount + wireDate are prepared server-side (from the Mercury wire event matched to this period, else
// the submit estimate) and passed as props. The extension still reads the AUTHORITATIVE wireId + amount from
// Gusto and refuses to confirm if the app amount disagrees with Gusto's — a hard financial safety.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { BadgeCheck, Loader2 } from "lucide-react";
import { EXTENSION_ID } from "@/lib/extensionId";

const REFRESH_DELAY_MS = 12000;

interface ChromeRuntimeLike {
  runtime?: {
    sendMessage?: (extensionId: string, message: unknown, callback?: (response: unknown) => void) => void;
    lastError?: { message?: string };
  };
}

function usd(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "the amount shown in Gusto";
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

export function ConfirmWireButton({
  period,
  checkDate,
  amount,
  wireDate,
  initiatedBy = null,
  lastConfirm = null,
}: {
  period: { start: string; end: string; label: string };
  checkDate: string;
  amount: number | null; // the wire $ (from the Mercury event matched to this period, else the submit estimate)
  wireDate: string; // YYYY-MM-DD the wire was sent (defaults to the wire event date / today, prepared server-side)
  initiatedBy?: string | null;
  lastConfirm?: { at: string; ok: boolean; confirmed: boolean; aborted: string | null } | null;
}): React.JSX.Element {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function confirm(): Promise<void> {
    const chromeApi = (window as unknown as { chrome?: ChromeRuntimeLike }).chrome;
    const hasExtension = !!chromeApi?.runtime && typeof chromeApi.runtime.sendMessage === "function";
    if (!hasExtension) {
      toast.error("Auto-Pull extension not found in this browser", {
        description: "Confirm the wire from the Chrome that has the extension and a signed-in Gusto.",
      });
      return;
    }

    const ok = window.confirm(
      `Confirm the Gusto wire for ${period.label}?\n\n` +
        `Pay period: ${period.start} to ${period.end}\n` +
        `Amount: ${usd(amount)}\n` +
        `Wire date: ${wireDate}\n\n` +
        `Only do this after you have actually wired the funds to Gusto from Mercury. ` +
        `Gusto's own wire amount is verified before confirming. Continue?`,
    );
    if (!ok) return;

    setBusy(true);
    try {
      toast.loading("Confirming the wire in Gusto…", { id: "confirm-wire" });
      const payload = { period, checkDate, amount, wireDate, initiatedBy };
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        setBusy(false);
      };
      chromeApi!.runtime!.sendMessage!(EXTENSION_ID, { type: "zoe-gusto-confirm-wire", payload }, () => {
        if (chromeApi!.runtime?.lastError) {
          toast.error("Couldn't reach the Auto-Pull extension", { id: "confirm-wire", description: "Make sure it's installed and enabled (v1.16.0+)." });
          done();
          return;
        }
        setTimeout(() => {
          router.refresh();
          toast.success("Confirm started — status updates when the extension reports back.", { id: "confirm-wire" });
          done();
        }, REFRESH_DELAY_MS);
      });
      setTimeout(done, 25000);
    } catch {
      toast.error("Couldn't start the wire confirm.");
      setBusy(false);
    }
  }

  const last = relTime(lastConfirm?.at ?? null);
  return (
    <div className="flex flex-col items-end gap-1">
      <button
        onClick={confirm}
        disabled={busy}
        title="Confirm the Gusto wire-in (after you have wired the funds from Mercury)"
        className="inline-flex h-8 items-center justify-center gap-2 rounded-md border border-border px-3 text-[12.5px] font-medium text-secondary-text transition-colors hover:bg-[var(--row-hover)] hover:text-foreground disabled:opacity-60"
      >
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : <BadgeCheck className="size-3.5" />}
        {busy ? "Confirming…" : "Confirm wire in Gusto"}
      </button>
      <span className="text-[11px] text-meta">
        {lastConfirm?.aborted === "not_logged_in" ? (
          <span className="text-amber-300">Sign in to Gusto (tab opened), then confirm again</span>
        ) : lastConfirm && last ? (
          <>
            Last confirm {last}
            {lastConfirm.aborted ? ` · aborted (${lastConfirm.aborted})` : lastConfirm.confirmed ? " · confirmed" : " · needs attention"}
          </>
        ) : (
          `Confirm after wiring ${usd(amount)} from Mercury`
        )}
      </span>
    </div>
  );
}
