// LeadTouchTimeline — the graphical conversation rail under each lead row in the Bulk Review-and-Fire
// cockpit. A thin horizontal RAIL carries channel-colored NODES in chronological order (oldest left →
// newest right). Direction is read two ways at once: OUTBOUND touches sit ABOVE the rail and are FILLED;
// INBOUND touches sit BELOW the rail and are OUTLINED. The quote-send is the gold ANCHOR node (larger,
// badged); the most recent touch glows. Connector length conveys cadence (bigger real time gaps → longer
// segments). Every node has a keyboard-focusable hover/focus card with the channel, direction, exact
// timestamp and the REAL preview text — facts only, never invented. An empty lead renders an honest
// "no activity yet". Identity is never color-alone: each channel carries a distinct icon + a legend label,
// so it reads for color-blind users and in forced-colors mode.
//
// Pure, node-testable layout math lives in "@/lib/salesos/touchpointLayout"; this file is presentation.

import { MessageSquare, Phone, Mail, StickyNote, ReceiptText, FileText, ArrowUpRight, ArrowDownLeft } from "lucide-react";
import type { LeadTouchpoint } from "@/lib/salesos/timeline";
import type { TimelineChannel } from "@/lib/salesos/timeline";
import { connectorWeights, mostRecentIndex, touchDateLabel } from "@/lib/salesos/touchpointLayout";

// Channel palette — validated against the dark cockpit surface with the dataviz validator (lightness band,
// chroma floor, contrast, and the normal-vision separation floor all PASS). The residual CVD (red-green)
// overlap is carried by the mandatory secondary encoding: a distinct icon per channel + the legend label +
// the above/below-rail direction. Defined as scoped CSS vars so the palette lives in one place.
const CHANNEL_VARS = {
  "--tc-sms": "#5b79f7", // text — blue
  "--tc-call": "#00a4b3", // call — teal
  "--tc-email": "#cc4da9", // email — magenta
  "--tc-note": "#5e9a00", // note — olive
  "--tc-quote": "var(--gold, #d4b36b)", // quote — Zoe gold anchor
  "--tc-system": "var(--color-meta, #9397ab)", // internal activity — neutral
} as React.CSSProperties;

type ChannelMeta = { label: string; cssVar: string; Icon: typeof MessageSquare };
const CHANNEL: Record<TimelineChannel, ChannelMeta> = {
  sms: { label: "Text", cssVar: "var(--tc-sms)", Icon: MessageSquare },
  call: { label: "Call", cssVar: "var(--tc-call)", Icon: Phone },
  email: { label: "Email", cssVar: "var(--tc-email)", Icon: Mail },
  note: { label: "Note", cssVar: "var(--tc-note)", Icon: StickyNote },
  quote: { label: "Quote", cssVar: "var(--tc-quote)", Icon: ReceiptText },
  system: { label: "Activity", cssVar: "var(--tc-system)", Icon: FileText },
};

// Strip geometry (px). The top band is reserved headroom so a hover card opens upward WITHIN the strip's
// own box — never relying on the scrolling table to not clip it.
const H = 124; // total strip height
const RAIL_Y = 92; // the baseline's y
const OUT_Y = 72; // outbound node centre (above the rail)
const IN_Y = 110; // inbound node centre (below the rail)
const CAP_Y = 110; // date-caption y (below the rail, clear of outbound/quote nodes)
const COL_W = 34; // node-column width (room for the emphasis ring)

function directionOf(p: LeadTouchpoint): "out" | "in" | "neutral" {
  return p.direction === "out" ? "out" : p.direction === "in" ? "in" : "neutral";
}

function exactStamp(iso: string | null, dateToken: string | null): string {
  if (iso) {
    const ms = Date.parse(iso.length > 10 ? iso : `${iso}T00:00:00Z`);
    if (Number.isFinite(ms)) return new Date(ms).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
    return "";
  }
  return dateToken ? `${dateToken} (undated)` : "undated";
}

function dirWord(d: "out" | "in" | "neutral"): string {
  return d === "out" ? "Outbound" : d === "in" ? "Inbound" : "Logged";
}

function Node({ p, emphasised }: { p: LeadTouchpoint; emphasised: boolean }): React.JSX.Element {
  const meta = CHANNEL[p.channel];
  const dir = directionOf(p);
  const color = meta.cssVar;
  const y = p.isQuote ? RAIL_Y : dir === "out" ? OUT_Y : dir === "in" ? IN_Y : RAIL_Y;
  const size = p.isQuote ? 28 : 22;
  const filled = dir === "out" || p.isQuote; // sent → filled; received → outlined; note/system → outlined
  const undated = !p.iso;

  const markerStyle: React.CSSProperties = {
    width: size,
    height: size,
    background: filled ? color : "var(--panel)",
    borderColor: color,
    borderStyle: undated ? "dashed" : "solid",
    color: filled ? "var(--background)" : color,
    boxShadow: emphasised
      ? `0 0 0 2px var(--panel), 0 0 0 4px ${color}, 0 0 12px -1px ${color}`
      : p.isQuote
        ? `0 0 0 2px var(--panel), 0 0 0 3px ${color}`
        : undefined,
  };

  const DirArrow = dir === "out" ? ArrowUpRight : dir === "in" ? ArrowDownLeft : null;

  return (
    <div className="group relative shrink-0" style={{ width: COL_W, height: H }} role="listitem">
      {/* stem from the node to the rail */}
      <span aria-hidden className="absolute left-1/2 -translate-x-1/2 bg-[var(--row-rule)]" style={{ top: Math.min(y, RAIL_Y), height: Math.abs(RAIL_Y - y), width: 1 }} />
      {/* the node — a focusable button carrying the hover/focus card */}
      <button
        type="button"
        className="absolute left-1/2 flex -translate-x-1/2 items-center justify-center rounded-full border-[1.5px] outline-none ring-offset-0 focus-visible:ring-2 focus-visible:ring-[var(--ring)] motion-safe:transition-transform motion-safe:duration-150 motion-safe:group-hover:scale-110"
        style={{ ...markerStyle, top: y - size / 2 }}
        aria-label={`${dirWord(dir)} ${meta.label}${p.isQuote ? " (quote milestone)" : ""}, ${exactStamp(p.iso, p.dateToken)}`}
      >
        <meta.Icon style={{ width: size * 0.56, height: size * 0.56 }} strokeWidth={2} />
        {DirArrow && (
          <span
            aria-hidden
            className="absolute -bottom-1 -right-1 flex items-center justify-center rounded-full border border-[var(--panel)]"
            style={{ width: 11, height: 11, background: "var(--panel)", color }}
          >
            <DirArrow style={{ width: 8, height: 8 }} strokeWidth={3} />
          </span>
        )}
      </button>

      {/* date caption at the foot of the strip (shown via the `showDate` wrapper, see render) */}
      {/* hover / focus card — pinned to the reserved headroom so it never needs the table to overflow */}
      <div
        role="tooltip"
        className="pointer-events-none absolute left-1/2 z-20 w-[220px] -translate-x-1/2 rounded-md border border-border bg-lifted p-2 text-left opacity-0 shadow-lg motion-safe:transition-opacity motion-safe:duration-150 group-hover:opacity-100 group-focus-within:opacity-100"
        style={{ top: 0 }}
      >
        <div className="flex items-center gap-1.5 text-[11px] font-medium text-foreground">
          <span aria-hidden className="inline-flex size-3.5 items-center justify-center" style={{ color }}>
            <meta.Icon className="size-3.5" strokeWidth={2.25} />
          </span>
          <span>{p.title}</span>
        </div>
        <div className="mt-0.5 text-[10.5px] text-meta">
          {dirWord(dir)} {meta.label} · {exactStamp(p.iso, p.dateToken)}
        </div>
        {p.preview && <div className="mt-1 line-clamp-2 text-[11px] leading-snug text-tertiary-text">{p.preview}</div>}
      </div>
    </div>
  );
}

/** The compact, self-explanatory legend. Icon + color + label per channel, plus the direction key — so the
 *  encoding reads without relying on color (icon + label backup; color-blind and forced-colors safe). */
export function LeadTouchLegend(): React.JSX.Element {
  return (
    <div style={CHANNEL_VARS} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-meta">
      <span className="text-tertiary-text">Timeline:</span>
      {(Object.keys(CHANNEL) as TimelineChannel[])
        .filter((c) => c !== "system")
        .map((c) => {
          const m = CHANNEL[c];
          return (
            <span key={c} className="inline-flex items-center gap-1">
              <span className="inline-flex size-3.5 items-center justify-center rounded-full border-[1.5px]" style={{ borderColor: m.cssVar, color: m.cssVar }}>
                <m.Icon className="size-2.5" strokeWidth={2.25} />
              </span>
              {m.label}
            </span>
          );
        })}
      <span className="ml-1 inline-flex items-center gap-1 border-l border-border pl-3">
        <ArrowUpRight className="size-3" strokeWidth={2.5} /> Outbound (above, filled)
      </span>
      <span className="inline-flex items-center gap-1">
        <ArrowDownLeft className="size-3" strokeWidth={2.5} /> Inbound (below, outline)
      </span>
    </div>
  );
}

/** The per-lead conversation rail. `touchpoints` are oldest → newest; `earlier` is how many real touches
 *  predate this bounded window (rendered as a quiet "+K earlier" affordance at the left). */
export function LeadTouchTimeline({ touchpoints, earlier = 0 }: { touchpoints: LeadTouchpoint[]; earlier?: number }): React.JSX.Element {
  if (touchpoints.length === 0) {
    return <div className="py-2 text-[11.5px] text-meta">No activity logged yet.</div>;
  }

  const isos = touchpoints.map((p) => p.iso);
  const weights = connectorWeights(isos);
  const recent = mostRecentIndex(isos);
  // Show a date caption only at sensible intervals — the first, the last, and the quote anchor — so the
  // strip stays scannable; every node's exact date is in its hover card.
  const quoteIdx = touchpoints.findIndex((p) => p.isQuote);
  const captionIdx = new Set<number>([0, touchpoints.length - 1, recent, quoteIdx].filter((i) => i >= 0));

  return (
    <div style={CHANNEL_VARS} className="relative w-full" aria-label="Conversation timeline">
      {/* the rail baseline, drawn full-width behind the nodes */}
      <span aria-hidden className="pointer-events-none absolute left-0 right-0 h-px bg-border" style={{ top: RAIL_Y }} />
      <div className="relative flex items-stretch" style={{ height: H }} role="list">
        {earlier > 0 && (
          <div className="relative flex shrink-0 items-center" style={{ height: H }}>
            <span className="rounded-full border border-border bg-[var(--row)] px-1.5 py-0.5 text-[10px] text-meta" style={{ position: "relative", top: RAIL_Y - H / 2 }} title={`${earlier} earlier touch${earlier === 1 ? "" : "es"} not shown`}>
              +{earlier} earlier
            </span>
          </div>
        )}
        {touchpoints.map((p, i) => (
          <div key={i} className="flex items-stretch">
            {i > 0 && (
              <span aria-hidden className="shrink-0" style={{ flexGrow: weights[i - 1] ?? 0.35, flexBasis: 0, minWidth: 16 }} />
            )}
            <div className="relative">
              <Node p={p} emphasised={i === recent} />
              {/* Date caption sits below the rail; only for nodes that are NOT inbound (inbound nodes live in
                  that lower band, so their date stays in the hover card) — keeps labels collision-free. */}
              {captionIdx.has(i) && p.direction !== "in" && (
                <span className="pointer-events-none absolute left-1/2 -translate-x-1/2 whitespace-nowrap text-[9.5px] text-meta" style={{ top: CAP_Y }}>
                  {touchDateLabel(p.iso, p.dateToken) || "·"}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
