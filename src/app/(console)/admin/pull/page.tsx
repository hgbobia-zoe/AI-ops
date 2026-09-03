// Office pull setup — the tablet-independent way to refresh Goodshuffle data. Install the
// bookmarklet once, then click it from any logged-in (full-access) Goodshuffle tab to pull
// today's routes — with revenue + customer identity the driver/tablet account can't see.

import { headers } from "next/headers";
import { Download, CircleCheck, AlertTriangle } from "lucide-react";
import { PullBookmarklet } from "@/components/PullBookmarklet";
import { buildOfficePullScript } from "@/lib/gsPull";
import { getPullState } from "@/lib/pull/state";
import { DISPLAY_TZ } from "@/lib/dates";

export const dynamic = "force-dynamic";

function fmt(iso?: string): string {
  if (!iso) return "never";
  try {
    return new Date(iso).toLocaleString("en-US", { timeZone: DISPLAY_TZ, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  } catch {
    return iso;
  }
}

export default async function PullSetupPage(): Promise<React.JSX.Element> {
  const h = await headers();
  const host = h.get("host") ?? "zoe-dispatch.fly.dev";
  const proto = h.get("x-forwarded-proto") ?? "https";
  const base = `${proto}://${host}`;
  const script = buildOfficePullScript(base, process.env.GS_INGEST_TOKEN);

  const state = getPullState();
  const ageH = state.lastPullAt ? Math.round((Date.now() - Date.parse(state.lastPullAt)) / 3_600_000) : null;
  const stale = ageH == null || ageH >= 26;

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

      {/* Install */}
      <section className="mb-6 space-y-3">
        <h2 className="text-lg font-semibold">1 · Install the button (once)</h2>
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
