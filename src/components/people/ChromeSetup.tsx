"use client";

// "Set up accounts in my Chrome": asks the server to approve the Chrome-run setup steps (Slack, Quo, work
// email, WeddingPro, Yelp) and hands the jobs to the Auto-Pull extension in THIS browser. The extension opens
// each site in a visible tab (sign in there if asked), stops for your OK on paid seats, and reports back.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { EXTENSION_ID } from "@/lib/extensionId";

interface ChromeRuntimeLike {
  runtime?: {
    sendMessage?: (id: string, msg: unknown, cb: (resp: unknown) => void) => void;
    lastError?: { message?: string };
  };
}

type Result = { ok: boolean; text: string };

/** Start the run and pass the jobs to the extension. Shared by the page button and the per-step button. */
export async function runInChrome(employeeId: string, taskIds?: string[]): Promise<Result> {
  const chromeApi = (window as unknown as { chrome?: ChromeRuntimeLike }).chrome;
  if (!chromeApi?.runtime?.sendMessage) {
    return { ok: false, text: "Auto-Pull isn't installed in this browser. Install it (Admin, Pull), then try again." };
  }
  const res = await fetch("/api/people/chrome-run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ employeeId, taskIds }),
  }).catch(() => null);
  const data = (await res?.json().catch(() => null)) as { jobs?: unknown[]; skipped?: { system: string; reason: string }[]; error?: string } | null;
  if (!res || !res.ok || !data) return { ok: false, text: data?.error ?? "Couldn't start the setup." };
  const jobs = data.jobs ?? [];
  const skippedText = (data.skipped ?? []).map((s) => `${s.system}: ${s.reason}`).join(" ");
  if (jobs.length === 0) return { ok: false, text: skippedText || "Nothing to run." };
  const sent = await new Promise<Result>((resolve) => {
    chromeApi.runtime!.sendMessage!(EXTENSION_ID, { type: "zoe-provision", jobs }, (resp) => {
      if (chromeApi.runtime?.lastError) {
        resolve({ ok: false, text: "Couldn't reach Auto-Pull. Update it to v1.21.0 or later." });
        return;
      }
      const r = resp as { ok?: boolean; already?: boolean } | undefined;
      if (r?.already) resolve({ ok: false, text: "A setup is already running in this Chrome. Let it finish first." });
      else resolve({ ok: true, text: `Opening ${jobs.length} site${jobs.length === 1 ? "" : "s"} in Chrome. Sign in if a site asks.` });
    });
  });
  return skippedText && sent.ok ? { ok: true, text: `${sent.text} Not run: ${skippedText}` } : sent;
}

/** Refresh the page every few seconds for a while, so outcomes show up as the extension reports them. */
export function useRefreshFor(): (ms: number) => void {
  const router = useRouter();
  return (ms: number) => {
    const until = Date.now() + ms;
    const tick = (): void => {
      router.refresh();
      if (Date.now() < until) setTimeout(tick, 5000);
    };
    setTimeout(tick, 4000);
  };
}

export function ChromeSetupButton({ employeeId, count }: { employeeId: string; count: number }): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Result | null>(null);
  const refreshFor = useRefreshFor();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setMsg(null);
          const r = await runInChrome(employeeId);
          setMsg(r);
          setBusy(false);
          if (r.ok) refreshFor(6 * 60_000);
        }}
      >
        {busy ? "Starting…" : `Set up ${count} account${count === 1 ? "" : "s"} in my Chrome`}
      </Button>
      {msg && <span className={`text-[11.5px] ${msg.ok ? "text-positive" : "text-critical"}`}>{msg.text}</span>}
    </div>
  );
}
