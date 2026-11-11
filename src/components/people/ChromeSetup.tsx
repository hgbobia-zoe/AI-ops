"use client";

// "Set up accounts in my Chrome": the server approves the Chrome-run setup steps (work email, Slack, Quo,
// Goodshuffle, WeddingPro, Yelp) and hands the jobs to the Auto-Pull extension in THIS browser. For a hire
// who has not started yet, the extension holds them and runs them on day one, 10 minutes after the start
// time, so the Google login lands that morning. Paid seats are confirmed here first.

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

/** What a step costs or grants, shown before it is approved. */
const COST_NOTE: Record<string, string> = {
  squarespace_email: "Work email: $8.40 a month (plus a prorated charge that day)",
  quo: "Quo: $33 a month",
  goodshuffle: "Goodshuffle: $59 a month (Full seat, billed monthly)",
  yelp: "Yelp: full owner access, including buying ads",
};

function when(ms: number): string {
  return new Date(ms).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** Start the run (or schedule it for day one) and pass the jobs to the extension. */
export async function runInChrome(employeeId: string, opts: { taskIds?: string[]; systems: string[]; now?: boolean }): Promise<Result> {
  const chromeApi = (window as unknown as { chrome?: ChromeRuntimeLike }).chrome;
  if (!chromeApi?.runtime?.sendMessage) {
    return { ok: false, text: "Auto-Pull isn't installed in this browser. Install it (Admin, Pull), then try again." };
  }
  const costs = opts.systems.map((s) => COST_NOTE[s]).filter(Boolean);
  if (costs.length && !window.confirm(`Approve these for this hire?\n\n${costs.join("\n")}\n\nThey run in this Chrome: on day one 10 minutes after the start time, or now if the hire has started.`)) {
    return { ok: false, text: "Not approved. Nothing was run." };
  }
  const res = await fetch("/api/people/chrome-run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ employeeId, taskIds: opts.taskIds, now: opts.now === true }),
  }).catch(() => null);
  const data = (await res?.json().catch(() => null)) as { jobs?: { runAt: number | null }[]; skipped?: { system: string; reason: string }[]; runAt?: number | null; error?: string } | null;
  if (!res || !res.ok || !data) return { ok: false, text: data?.error ?? "Couldn't start the setup." };
  // Approved here, so a held job runs unattended on day one without asking again.
  const jobs = (data.jobs ?? []).map((j) => ({ ...j, preApproved: j.runAt != null }));
  const skippedText = (data.skipped ?? []).map((s) => `${s.system}: ${s.reason}`).join(" ");
  if (jobs.length === 0) return { ok: false, text: skippedText || "Nothing to run." };
  const sent = await new Promise<Result>((resolve) => {
    chromeApi.runtime!.sendMessage!(EXTENSION_ID, { type: "zoe-provision", jobs }, (resp) => {
      const r = resp as { ok?: boolean; already?: boolean; started?: number; scheduled?: number; error?: string } | undefined;
      if (chromeApi.runtime?.lastError || !r || r.error === "unknown_message") {
        resolve({ ok: false, text: "This Auto-Pull is too old to set up accounts. Update it to v1.22.0 or later, then press Run again." });
        return;
      }
      if (r.already) return resolve({ ok: false, text: "A setup is already running in this Chrome. Let it finish first." });
      if (!r.ok) return resolve({ ok: false, text: "Auto-Pull could not start the setup." });
      if (r.scheduled && data.runAt) {
        return resolve({ ok: true, text: `Scheduled for ${when(data.runAt)} in this Chrome. Leave Chrome running and signed in to the sites.` });
      }
      resolve({ ok: true, text: `Opening ${jobs.length} site${jobs.length === 1 ? "" : "s"} in Chrome. Sign in if a site asks.` });
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

export function ChromeSetupButton({ employeeId, systems, dayOne }: { employeeId: string; systems: string[]; dayOne: string | null }): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Result | null>(null);
  const refreshFor = useRefreshFor();
  const n = systems.length;
  const go = async (now: boolean): Promise<void> => {
    setBusy(true);
    setMsg(null);
    const r = await runInChrome(employeeId, { systems, now });
    setMsg(r);
    setBusy(false);
    if (r.ok) refreshFor(6 * 60_000);
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" disabled={busy} onClick={() => void go(false)}>
        {busy ? "Starting…" : dayOne ? `Schedule ${n} account${n === 1 ? "" : "s"} for day one` : `Set up ${n} account${n === 1 ? "" : "s"} in my Chrome`}
      </Button>
      {dayOne && (
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void go(true)}>
          Run now instead
        </Button>
      )}
      {msg && <span className={`text-[11.5px] ${msg.ok ? "text-positive" : "text-critical"}`}>{msg.text}</span>}
    </div>
  );
}
