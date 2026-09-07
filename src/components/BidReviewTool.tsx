"use client";

// Competitive Bid Review tool — enter a proposed bid (and optional event month), get a read on whether
// it's priced to win against Zoe's own comparable won/lost history. Client-side form → /api/salesos/
// bid-review. All numbers come from the deterministic engine; nothing here is invented.

import { useState } from "react";
import { Gauge, Search, TrendingUp, AlertTriangle, CheckCircle2, ArrowDownCircle, HelpCircle } from "lucide-react";
import type { BidReview, BidVerdict } from "@/lib/salesos/bidReview";

type Result = BidReview & { historyCount: number };

const money = (n: number | null): string => (n == null ? "—" : "$" + Math.round(n).toLocaleString("en-US"));
const pct = (r: number | null): string => (r == null ? "—" : `${Math.round(r * 100)}%`);

const MONTHS = ["Any month", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const VERDICT: Record<BidVerdict, { label: string; cls: string; icon: typeof CheckCircle2 }> = {
  competitive: { label: "Priced to compete", cls: "border-emerald-500/40 bg-emerald-500/10 text-emerald-100", icon: CheckCircle2 },
  aggressive: { label: "Aggressive — tough close", cls: "border-amber-500/40 bg-amber-500/10 text-amber-100", icon: AlertTriangle },
  conservative: { label: "Low — likely wins, check margin", cls: "border-sky-500/40 bg-sky-500/10 text-sky-100", icon: ArrowDownCircle },
  insufficient: { label: "Not enough history", cls: "border-white/15 bg-white/5 text-muted-foreground", icon: HelpCircle },
};

export function BidReviewTool(): React.JSX.Element {
  const [value, setValue] = useState("");
  const [month, setMonth] = useState("0");
  const [result, setResult] = useState<Result | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    const v = Number(value.replace(/[^0-9.]/g, ""));
    if (!Number.isFinite(v) || v <= 0) {
      setError("Enter a bid amount.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/salesos/bid-review", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: v, month: Number(month) || undefined }),
      });
      if (!res.ok) throw new Error(String(res.status));
      setResult((await res.json()) as Result);
    } catch {
      setError("Couldn't review that bid. Try again.");
      setResult(null);
    } finally {
      setLoading(false);
    }
  };

  const v = result ? VERDICT[result.verdict] : null;
  const VIcon = v?.icon;

  return (
    <div>
      <form onSubmit={submit} className="mb-5 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wide text-muted-foreground">Proposed bid</span>
          <div className="flex items-center border border-white/15 bg-transparent px-2 focus-within:border-white/40">
            <span className="text-muted-foreground">$</span>
            <input
              inputMode="decimal"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="2,500"
              className="w-32 bg-transparent px-1.5 py-2 tabular-nums outline-none"
            />
          </div>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wide text-muted-foreground">Event month (optional)</span>
          <select value={month} onChange={(e) => setMonth(e.target.value)} className="border border-white/15 bg-transparent px-2 py-2 outline-none focus:border-white/40">
            {MONTHS.map((m, i) => (
              <option key={i} value={String(i)}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" disabled={loading} className="btn-hero flex items-center gap-1.5 px-4 py-2 text-sm disabled:opacity-60">
          <Search className="size-4" /> {loading ? "Reviewing…" : "Review bid"}
        </button>
      </form>

      {error && <div className="mb-4 border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-200">{error}</div>}

      {result && v && VIcon && (
        <div className="space-y-4">
          <div className={`flex items-start gap-3 border p-4 ${v.cls}`}>
            <VIcon className="mt-0.5 size-5 shrink-0" />
            <div>
              <div className="text-lg font-semibold">{v.label}</div>
              <div className="text-sm opacity-90">{money(result.value)} bid · {result.confidence} confidence ({result.comparables} comparable deals)</div>
            </div>
          </div>

          {result.verdict !== "insufficient" && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Stat icon={Gauge} label="Win rate at this size" value={pct(result.winRate)} sub={`${result.wonComparables}W · ${result.lostComparables}L`} />
              <Stat icon={TrendingUp} label="Your winning range" value={result.wonRange ? `${money(result.wonRange.p25)}–${money(result.wonRange.p75)}` : "—"} sub={result.wonRange ? `median ${money(result.wonRange.median)}` : ""} />
              <Stat icon={Search} label="This bid's percentile" value={result.percentileAmongWins != null ? pct(result.percentileAmongWins) : "—"} sub="of your past wins" />
            </div>
          )}

          <div className="border border-white/10">
            {result.reasons.map((r, i) => (
              <div key={i} className="border-b border-white/5 px-3 py-2.5 text-sm last:border-b-0">{r}</div>
            ))}
          </div>

          <p className="text-[11px] text-muted-foreground">
            Based on {result.historyCount.toLocaleString("en-US")} decided quotes in your own DMV history — real market behavior, not an external benchmark.
            Comparable = past deals within ±40% of this bid.
          </p>
        </div>
      )}
    </div>
  );
}

function Stat({ icon: Icon, label, value, sub }: { icon: typeof Gauge; label: string; value: string; sub?: string }): React.JSX.Element {
  return (
    <div className="surface border border-white/5 p-3">
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
        <Icon className="size-3.5" /> {label}
      </div>
      <div className="mt-0.5 text-lg font-bold tabular-nums">{value}</div>
      {sub && <div className="text-[11px] text-muted-foreground">{sub}</div>}
    </div>
  );
}
