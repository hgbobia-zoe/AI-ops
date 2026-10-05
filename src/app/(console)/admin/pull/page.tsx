// Office pull setup — the tablet-independent way to refresh Goodshuffle data. Install the
// bookmarklet once, then click it from any logged-in (full-access) Goodshuffle tab to pull
// today's routes — with revenue + customer identity the driver/tablet account can't see.

import { headers } from "next/headers";
import { Download, CircleCheck, AlertTriangle, Puzzle } from "lucide-react";
import { PullBookmarklet } from "@/components/PullBookmarklet";
import { PullExtensionInstall } from "@/components/PullExtensionInstall";
import { buildOfficePullScript } from "@/lib/gsPull";
import { getPullState } from "@/lib/pull/state";
import { getRoutesDebug } from "@/lib/db/repo";
import { DISPLAY_TZ, todayInOpsTz } from "@/lib/dates";

export const dynamic = "force-dynamic";

function fmt(iso?: string): string {
  if (!iso) return "never";
  try {
    return new Date(iso).toLocaleString("en-US", { timeZone: DISPLAY_TZ, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  } catch {
    return iso;
  }
}

// Clock math lives outside render (the react-hooks/purity rule forbids Date.now() in a component body).
function hoursAgo(iso?: string): number | null {
  if (!iso) return null;
  return Math.round((Date.now() - Date.parse(iso)) / 3_600_000);
}
function minutesAgo(iso?: string): number | null {
  if (!iso) return null;
  return Math.round((Date.now() - Date.parse(iso)) / 60_000);
}

export default async function PullSetupPage(): Promise<React.JSX.Element> {
  const h = await headers();
  const host = h.get("host") ?? "zoe-dispatch.fly.dev";
  const proto = h.get("x-forwarded-proto") ?? "https";
  const base = `${proto}://${host}`;
  const script = buildOfficePullScript(base, process.env.GS_INGEST_TOKEN);
  const AUTO_MIN = 10;
  const autoScript = buildOfficePullScript(base, process.env.GS_INGEST_TOKEN, AUTO_MIN * 60 * 1000);

  const state = getPullState();
  const ageH = hoursAgo(state.lastPullAt);
  const stale = ageH == null || ageH >= 26;

  // What the pull actually wrote: every route row from today onward. Lets an operator confirm a new
  // Goodshuffle route arrived (and under which id/status) instead of guessing.
  const dbRoutes = getRoutesDebug(todayInOpsTz());

  const agent = state.agent;
  const agentAgeMin = minutesAgo(agent?.at);
  const agentLive = agentAgeMin != null && agentAgeMin <= 30;
  const AGENT_STATUS_LABEL: Record<string, string> = {
    ok: "Pulling on schedule",
    no_tab: "No Goodshuffle tab open on this machine",
    not_logged_in: "Goodshuffle is signed out — sign in to resume",
    error: "Last pull hit a problem",
  };

  return (
    <main className="mx-auto max-w-3xl p-5 pb-16 md:p-8">
      <header className="mb-5">
        <h1 className="flex items-center gap-2 text-3xl font-bold tracking-tight">
          <Download className="size-7" /> Pull Goodshuffle Routes
        </h1>
        <p className="text-sm text-muted-foreground">Refresh dispatch, risk, sales &amp; finance from Goodshuffle — from any computer, no tablet needed.</p>
      </header>

      {/* Freshness */}
      <div className={`mb-6 flex items-start gap-2.5 border p-4 text-sm ${stale ? "border-amber-500/40 bg-amber-500/10 text-amber-200" : "border-emerald-500/30 bg-emerald-500/[0.06] text-emerald-200"}`}>
        {stale ? <AlertTriangle className="mt-0.5 size-4 shrink-0" /> : <CircleCheck className="mt-0.5 size-4 shrink-0" />}
        <div>
          <div className="font-semibold">{stale ? "Data may be stale" : "Data is current"}</div>
          <p className="mt-0.5 text-muted-foreground">
            Last successful pull: <b>{fmt(state.lastPullAt)}</b>
            {ageH != null ? ` (${ageH}h ago)` : ""}
            {state.lastStops != null ? ` · ${state.lastStops} stops` : ""}. Pull at least once a day.
          </p>
        </div>
      </div>

      {/* Auto-Pull extension — the recommended, zero-click path */}
      <section className="mb-6 space-y-3 border border-indigo-500/30 bg-indigo-500/[0.06] p-4">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <Puzzle className="size-5" /> Auto-Pull extension (recommended)
        </h2>
        <p className="text-sm text-muted-foreground">
          Install once on the <b>office machine</b>, then just stay <b>signed into Goodshuffle</b> in that browser —
          <b> there&apos;s no tab to keep open</b>. The extension schedules itself and opens/keeps its own background
          Goodshuffle tab, pulling every 10 minutes across browser restarts. And when you log into Zoe Ops, it kicks an
          immediate sync (prompting a Goodshuffle sign-in only if needed). Everyone else just uses the app; only this one
          machine needs it.
        </p>
        <p className="border-l-2 border-indigo-400/40 pl-3 text-[13px] text-muted-foreground">
          <b>Install only on the office machine(s)</b> that stay signed in, not on everyone&apos;s computer. Sign into
          both <b>Goodshuffle</b> and <b>Instawork</b> there (Instawork powers the temp-labor sync). Once it&apos;s
          published to the Chrome Web Store, install from the store link (open it in Chrome, Add to Chrome) and it
          <b> auto-updates</b> with no more manual reloads. Until then, use the download below and re-load it after an
          update.
        </p>

        {/* Live status from the extension's heartbeat */}
        <div className={`flex items-center gap-2 border px-3 py-2 text-sm ${agentLive && agent?.status === "ok" ? "border-emerald-500/30 bg-emerald-500/[0.06] text-emerald-200" : agentLive ? "border-amber-500/40 bg-amber-500/10 text-amber-200" : "border-white/10 bg-white/[0.03] text-muted-foreground"}`}>
          {agentLive && agent?.status === "ok" ? <CircleCheck className="size-4 shrink-0" /> : <AlertTriangle className="size-4 shrink-0" />}
          <span>
            {agent
              ? agentLive
                ? `Extension: ${AGENT_STATUS_LABEL[agent.status] ?? agent.status} (${agentAgeMin}m ago)`
                : `Extension last reported ${agentAgeMin}m ago — may not be running here.`
              : "Extension not detected yet. Install it below, or it hasn't run its first pull."}
          </span>
        </div>

        {/* Version query busts the browser cache when the zip is rebuilt — keep in sync with
            extension/manifest.json "version" (rebuild with scripts/build-extension-zip.ps1). */}
        <PullExtensionInstall downloadHref="/zoe-autopull-extension.zip?v=1.6.0" />

        {/* Setup checklist for the dedicated always-on machine that runs the pull. */}
        <details className="group border border-white/10 bg-white/[0.02]">
          <summary className="cursor-pointer select-none px-4 py-2.5 text-sm font-medium text-foreground hover:bg-white/[0.03]">
            Always-on puller machine — setup checklist
          </summary>
          <div className="space-y-3 px-4 pb-4 text-[13px] text-muted-foreground">
            <p>The pull runs in a real browser on this one machine, so it stays on an ordinary (non-datacenter) connection that Goodshuffle does not block. Set it up once so it runs unattended:</p>
            <div>
              <div className="font-medium text-foreground">Power &amp; boot</div>
              <ul className="ml-4 list-disc space-y-1">
                <li>Set it to <b>never sleep or hibernate</b> (plugged in). The schedule will not fire reliably if it sleeps.</li>
                <li><b>Auto-login the Windows user on boot</b> and add <b>Chrome to startup</b>, set to <b>Continue where you left off</b>, so after a reboot or update it comes back running on its own.</li>
              </ul>
            </div>
            <div>
              <div className="font-medium text-foreground">Chrome</div>
              <ul className="ml-4 list-disc space-y-1">
                <li>Turn off <b>Memory Saver / tab discarding</b> (or exclude pro.goodshuffle.com and app.instawork.com) so the background pull tab is never frozen.</li>
                <li>Stay <b>signed into Goodshuffle and Instawork</b> here, with remember-me checked.</li>
              </ul>
            </div>
            <div>
              <div className="font-medium text-foreground">Sessions</div>
              <ul className="ml-4 list-disc space-y-1">
                <li>The pull hits Goodshuffle every 10 minutes, which keeps the session alive on its own. It should only drop on an absolute timeout or if cookies are cleared.</li>
                <li>When it does drop, the extension opens a login tab and this page (plus the top status dot and a Slack alert) shows it, so someone just re-signs-in when prompted.</li>
              </ul>
            </div>
          </div>
        </details>
      </section>

      {/* Routes inspector — what the pull actually wrote to the DB (today onward). */}
      <section className="mb-6 space-y-2">
        <h2 className="text-lg font-semibold">Routes in the app (today →)</h2>
        <p className="text-[13px] text-muted-foreground">
          Exactly what&apos;s stored after a pull. If a route you built in Goodshuffle isn&apos;t here, the pull didn&apos;t
          import it; if it&apos;s here as <code>done</code>, it&apos;s a closed route still on record.
        </p>
        {dbRoutes.length === 0 ? (
          <p className="text-sm text-muted-foreground">No routes stored from today onward.</p>
        ) : (
          <div className="overflow-x-auto border border-white/10">
            <table className="w-full text-left text-[12px]">
              <thead className="bg-white/[0.03] text-muted-foreground">
                <tr>
                  <th className="px-2.5 py-1.5 font-medium">Date</th>
                  <th className="px-2.5 py-1.5 font-medium">Truck</th>
                  <th className="px-2.5 py-1.5 font-medium">GS route</th>
                  <th className="px-2.5 py-1.5 font-medium">Status</th>
                  <th className="px-2.5 py-1.5 font-medium">Stops</th>
                  <th className="px-2.5 py-1.5 font-medium">Order</th>
                  <th className="px-2.5 py-1.5 font-medium">Updated</th>
                </tr>
              </thead>
              <tbody>
                {dbRoutes.map((r) => (
                  <tr key={r.routeId} className="border-t border-white/5">
                    <td className="whitespace-nowrap px-2.5 py-1.5 tabular-nums">{r.date}</td>
                    <td className="whitespace-nowrap px-2.5 py-1.5">{r.truckId}</td>
                    <td className="whitespace-nowrap px-2.5 py-1.5 font-mono text-muted-foreground">{r.gsRouteId ?? "—"}</td>
                    <td className={`whitespace-nowrap px-2.5 py-1.5 ${r.status === "done" ? "text-muted-foreground" : r.status === "active" ? "text-amber-300" : "text-emerald-300"}`}>{r.status}</td>
                    <td className="px-2.5 py-1.5 tabular-nums">{r.stopCount}</td>
                    <td className="px-2.5 py-1.5 text-muted-foreground">{r.stopPreview}</td>
                    <td className="whitespace-nowrap px-2.5 py-1.5 text-muted-foreground">{fmt(r.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Install the bookmarklet — no-install alternative */}
      <section className="mb-6 space-y-3">
        <h2 className="text-lg font-semibold">Or, no install: the bookmarklet</h2>
        <h3 className="text-sm font-semibold text-muted-foreground">1 · Install the button (once)</h3>
        <p className="text-sm text-muted-foreground">
          Make sure your bookmarks bar is visible (Ctrl/Cmd+Shift+B), then <b>drag</b> this button onto it. Or click
          Copy and create a new bookmark with that as the URL.
        </p>
        <PullBookmarklet script={script} />
      </section>

      {/* Use */}
      <section className="mb-6 space-y-2">
        <h2 className="text-lg font-semibold">2 · Pull whenever you need fresh data</h2>
        <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
          <li>Open <b>pro.goodshuffle.com</b> in the same browser and make sure you&apos;re <b>signed in</b>.</li>
          <li>Click the <b>Pull Zoe Routes</b> bookmark.</li>
          <li>A banner appears top-right: &ldquo;Pulling…&rdquo; then &ldquo;✅ Pulled N stops.&rdquo; That&apos;s it — the board, risk, sales and finance update.</li>
        </ol>
      </section>

      {/* Auto-pull — the "no manual pull" path */}
      <section className="mb-6 space-y-3 border border-emerald-500/30 bg-emerald-500/[0.05] p-4">
        <h2 className="text-lg font-semibold">Hands-off: Auto-Pull (recommended)</h2>
        <p className="text-sm text-muted-foreground">
          Drag this <b>second</b> button to your bookmarks bar. On a computer that keeps <b>pro.goodshuffle.com</b> open
          and signed in all day (the office machine), click it <b>once each morning</b>. It pulls immediately and then
          <b> every {AUTO_MIN} minutes on its own</b> — routes, revenue and bookings stay fresh with no more clicking. A
          small badge top-right shows it&apos;s running and the last sync time. (It runs as long as that Goodshuffle tab
          stays open; if the browser restarts, click it again.)
        </p>
        <PullBookmarklet script={autoScript} label={`Auto-Pull Zoe (every ${AUTO_MIN}m)`} />
      </section>

      {/* Account note */}
      <div className="border border-white/10 bg-white/[0.02] p-4 text-[13px] text-muted-foreground">
        <p className="mb-1 font-semibold text-foreground">Use a full-access account</p>
        Sign in with an office account that can see <b>financials</b> — the driver/tablet account can&apos;t read contract
        totals, so pulling with it won&apos;t capture revenue. This pull grabs today&apos;s routes plus each event&apos;s
        line items, contract total (revenue), and customer id. Goodshuffle allows 3 concurrent sessions, so this won&apos;t
        bump anyone off.
      </div>
    </main>
  );
}
