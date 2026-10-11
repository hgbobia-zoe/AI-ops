// "Tomorrow's prep window" — a compact OPPORTUNITY callout on /dispatch (NOT a new dashboard). It reads
// the OPEN opportunity findings the Event Risk Engine already produced (category "OPPORTUNITY", the
// prep_window_* family) and lays them out for an operator: event, truck/route, dispatch time, the
// UNVERIFIED outstanding prep, the feasible window + deadline, the suggested action + owner, the
// consequence, and confidence + what's unknown. Actions reuse the existing risk lifecycle (RiskActions:
// acknowledge / start / view / resolve). Server component — reads getRiskQueue directly.

import { PackageCheck, Clock, AlertTriangle } from "lucide-react";
import { getRiskQueue, type StoredRisk } from "@/lib/risk/store";
import { RiskActions } from "@/components/RiskActions";
import { formatClockTime, formatYmdLong } from "@/lib/dates";

function meta(r: StoredRisk, key: string): string | number | null {
  const v = r.metadata?.[key];
  return typeof v === "string" || typeof v === "number" ? v : null;
}

const TYPE_TONE: Record<string, { label: string; ring: string; text: string }> = {
  prep_window_open: { label: "Window open", ring: "border-positive/50", text: "text-positive" },
  prep_window_threatened: { label: "Window closing", ring: "border-attention/60", text: "text-attention" },
  prep_window_missed: { label: "Window missed", ring: "border-critical/50", text: "text-critical" },
};

export function PrepWindowCallout(): React.JSX.Element | null {
  // Active OPPORTUNITY findings (OPEN/ACK/IN_PROGRESS), worst-first already from getRiskQueue. Missed
  // items are kept out of the primary callout (they are history/for the sweep), shown only if nothing is
  // actionable, so the operator sees the live opportunity first.
  const all = getRiskQueue().filter((r) => r.category === "OPPORTUNITY");
  const actionable = all.filter((r) => r.riskType !== "prep_window_missed");
  const items = actionable.length > 0 ? actionable : all;
  if (items.length === 0) return null;

  return (
    <section className="mb-4 rounded border border-border bg-panel p-3">
      <div className="mb-2 flex items-center gap-2 text-[13px] font-semibold">
        <PackageCheck className="size-4 shrink-0 text-positive" />
        Tomorrow&apos;s prep window
        <span className="rounded bg-[var(--row-hover)] px-1.5 py-0.5 text-[10.5px] font-medium uppercase tracking-wide text-meta">
          {items.length} opportunit{items.length === 1 ? "y" : "ies"}
        </span>
        <span className="ml-auto text-[11px] font-normal text-meta">Unverified — flags the window, not a loaded truck</span>
      </div>

      <div className="space-y-2">
        {items.map((r) => {
          const tone = TYPE_TONE[r.riskType] ?? TYPE_TONE.prep_window_open;
          const dispatch = meta(r, "dispatchWindow");
          const loadMin = meta(r, "loadMinutes");
          const confidence = meta(r, "confidence");
          const whatsUnknown = meta(r, "whatsUnknown");
          const consequence = meta(r, "consequence");
          return (
            <div key={r.id} className={`rounded border-l-2 ${tone.ring} border-y border-r border-border bg-[var(--surface,transparent)] p-2.5 text-[12.5px]`}>
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className={`text-[10.5px] font-semibold uppercase tracking-[0.06em] ${tone.text}`}>{tone.label}</span>
                <span className="font-medium">{r.affectedEntity || r.title}</span>
                <span className="text-meta">{r.truckId ? `· ${r.truckId}` : ""}{r.date ? ` · dispatches ${formatYmdLong(r.date)}` : ""}{dispatch ? ` ${formatClockTime(String(dispatch))}` : ""}</span>
              </div>

              <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-meta">
                {loadMin != null && (
                  <span className="inline-flex items-center gap-1"><PackageCheck className="size-3" /> ~{loadMin} min to prep &amp; load (unconfirmed)</span>
                )}
                {r.deadline && (
                  <span className="inline-flex items-center gap-1 text-foreground"><Clock className="size-3" /> Latest safe start {formatClockTime(r.deadline)}</span>
                )}
                {confidence && <span className="inline-flex items-center gap-1">Confidence: <span className={confidence === "moderate" ? "text-foreground" : "text-attention"}>{confidence}</span></span>}
              </div>

              {r.recommendedAction && (
                <div className="mt-1 text-foreground">
                  <span className="text-meta">Recommend:</span> {r.recommendedAction}
                  {r.owner ? <span className="text-meta"> · owner: {r.owner}</span> : null}
                </div>
              )}
              {consequence && <div className="mt-0.5 text-meta">{consequence}</div>}
              {whatsUnknown && (
                <div className="mt-1 flex items-start gap-1 text-[11.5px] text-meta">
                  <AlertTriangle className="mt-0.5 size-3 shrink-0 text-attention/70" />
                  <span>{whatsUnknown}</span>
                </div>
              )}

              <div className="mt-2">
                <RiskActions id={r.id} status={r.status} actionTarget={r.actionTarget ?? "dispatch"} />
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
