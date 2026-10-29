"use client";

// Design-system showcase (dev/ops tool, admin-only, not in the nav). Renders the shared tokens and
// primitives so they can be eyeballed in both themes. The Theme toggle flips `.dark` on <html> for
// THIS view only (it restores dark on unmount) — a real persisted theme switch belongs to prompt 02.
// No product data: everything here is static fixture content.

import * as React from "react";
import { Tent, Sun, Moon, Clock3, Inbox, Plug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/ui/status";
import { Surface } from "@/components/ui/surface";
import { PageHeader, Toolbar } from "@/components/ui/page-header";
import { Metric, MetricGrid } from "@/components/ui/metric";
import { EmptyState, ErrorState, StatusBanner, StaleBadge } from "@/components/ui/states";
import {
  OverviewLayout,
  WorkSurfaceLayout,
  TimelineLayout,
  TimelineItem,
  FocusFormLayout,
} from "@/components/ui/layouts";
import {
  FigureStrip,
  StatusMark,
  ActionVerb,
  Provenance,
  compactTableFrameCls,
  compactTableCls,
  compactTheadRowCls,
  compactThCls,
  compactTdCls,
  compactRowCls,
} from "@/components/console-primitives";
import { CHART_CATEGORY, CHART_STATUS, CHART_ACCENT } from "@/lib/chartTokens";
import type { Tone } from "@/lib/tone";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-[18px] font-semibold tracking-tight">{title}</h2>
      {children}
    </section>
  );
}

function Swatch({ name, varName, note }: { name: string; varName: string; note?: string }) {
  return (
    <div className="flex items-center gap-3">
      <span
        className="size-9 shrink-0 rounded-md border border-border"
        style={{ background: `var(${varName})` }}
        aria-hidden
      />
      <div className="min-w-0">
        <div className="text-[12.5px] text-foreground">{name}</div>
        <div className="text-[11px] text-meta">
          {varName}
          {note ? ` · ${note}` : ""}
        </div>
      </div>
    </div>
  );
}

const WORKERS: { n: string; h: string; r: string; tone: Tone; s: string }[] = [
  { n: "Marquis Alexander-Washington", h: "38.0", r: "$22/hr", tone: "positive", s: "Ready" },
  { n: "Dana R.", h: "41.5", r: "$24/hr", tone: "attention", s: "Requires review" },
  { n: "Theo P.", h: "—", r: "missing", tone: "critical", s: "Blocked" },
  { n: "Priya N.", h: "12.0", r: "$20/hr", tone: "info", s: "Syncing" },
];

export function DesignShowcase(): React.JSX.Element {
  const [dark, setDark] = React.useState(true);
  const [selected, setSelected] = React.useState("Marquis Alexander-Washington");
  React.useEffect(() => {
    const root = document.documentElement;
    const had = root.classList.contains("dark");
    root.classList.toggle("dark", dark);
    return () => {
      root.classList.toggle("dark", had);
    };
  }, [dark]);

  return (
    <main className="mx-auto max-w-[1400px] p-3 pb-16 md:p-4">
      <PageHeader
        size="display"
        icon={<Tent className="size-6 text-[var(--gold)]" />}
        title="Nocturne design system"
        subtitle="Shared tokens and primitives — the foundation every blade consumes. Fixture content only."
        actions={
          <Button variant="outline" onClick={() => setDark((d) => !d)}>
            {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
            {dark ? "Preview light" : "Preview dark"}
          </Button>
        }
      />

      <div className="space-y-10">
        <Section title="Surfaces & borders">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            <Swatch name="Canvas" varName="--background" />
            <Swatch name="Sidebar" varName="--sidebar" />
            <Swatch name="Surface / panel" varName="--panel" />
            <Swatch name="Row" varName="--row" />
            <Swatch name="Row hover" varName="--row-hover" />
            <Swatch name="Raised (lifted)" varName="--lifted" />
            <Swatch name="Border" varName="--border" />
            <Swatch name="Row rule" varName="--row-rule" />
            <Swatch name="Editable input" varName="--input" />
            <Swatch name="Focus ring" varName="--ring" />
          </div>
        </Section>

        <Section title="Text tiers (measured on canvas)">
          <Surface className="space-y-1.5">
            <p className="text-[15px] text-foreground">Primary — foreground. 14.5:1 dark · 19:1 light.</p>
            <p className="text-[15px] text-secondary-text">Secondary — text-secondary. 11.8:1 · 12.7:1.</p>
            <p className="text-[15px] text-tertiary-text">Tertiary — text-tertiary. 8.8:1 · 8.5:1.</p>
            <p className="text-[15px] text-meta">Meta — text-meta. 5.1:1 · 6.0:1 (muted, not disabled).</p>
          </Surface>
        </Section>

        <Section title="Status — coloured indicator + crisp label (colour on the icon, never the label)">
          <Surface className="flex flex-wrap items-center gap-x-6 gap-y-3">
            <StatusBadge tone="positive">Ready</StatusBadge>
            <StatusBadge tone="critical">Blocked</StatusBadge>
            <StatusBadge tone="attention">Requires review</StatusBadge>
            <StatusBadge tone="info" animated>Syncing</StatusBadge>
            <StatusBadge tone="neutral">No data</StatusBadge>
          </Surface>
          <div className="flex flex-wrap items-center gap-6">
            <StatusMark tone="positive" label="Live" />
            <StatusMark tone="attention" label="Stale" />
            <StatusMark tone="critical" label="Down" />
            <StatusMark tone="idle" label="Idle" />
            <StaleBadge><Clock3 className="size-3" /> as of 2h ago</StaleBadge>
          </div>
          <div className="space-y-2">
            <div className="text-[12px] text-meta">Long label wraps cleanly; filled is the reserved exceptional case only:</div>
            <div className="flex flex-wrap items-center gap-4">
              <StatusBadge tone="attention">Requires review — unmatched Gusto worker on an international contract</StatusBadge>
              <StatusBadge tone="critical" filled>SLA breached</StatusBadge>
            </div>
          </div>
        </Section>

        <Section title="Blocking banner (states the problem once, with the next action)">
          <StatusBanner
            tone="critical"
            title="2 workers blocked — payroll can't be approved"
            action={<Button size="sm">Resolve in review</Button>}
          >
            A blocking issue (missing Gusto mapping) prevents this run. Map or exclude the blocked
            workers, then re-check readiness. Colour stays on the icon + the hairline edge — the banner
            itself is the neutral surface.
          </StatusBanner>
          <StatusBanner
            tone="info"
            title="Sync in progress"
            icon={<span className="inline-flex size-5 items-center justify-center"><span className="size-2 rounded-full bg-status-syncing motion-safe:animate-pulse" /></span>}
          >
            Pulling Connecteam hours and reconciling workers. This updates the readiness state when it
            finishes.
          </StatusBanner>
        </Section>

        <Section title="Typography scale">
          <Surface className="space-y-2">
            <div className="text-[28px] font-semibold tracking-tight">Display 28 — hero / overview</div>
            <div className="text-[22px] font-semibold tracking-tight">Page title 22 — blade header</div>
            <div className="text-[18px] font-semibold tracking-tight">Section 18</div>
            <div className="text-[15px]">Body / input 15</div>
            <div className="text-[13px]">Dense table 13</div>
            <div className="text-[12px] text-meta">Metadata 12</div>
            <div className="text-[15px] tabular-nums">Tabular figures 1,234,567 · $48,250 · 162.5 h</div>
          </Surface>
        </Section>

        <Section title="Buttons">
          <Toolbar justify="start">
            <Button>Primary</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="outline">Outline</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="destructive">Destructive</Button>
            <Button variant="link">Link</Button>
            <Button disabled>Disabled</Button>
          </Toolbar>
          <Toolbar justify="start">
            <Button size="xs">Extra small</Button>
            <Button size="sm">Small</Button>
            <Button size="default">Default</Button>
            <Button size="lg">Large</Button>
          </Toolbar>
          <div className="flex flex-wrap gap-2">
            <Badge>Badge</Badge>
            <Badge variant="secondary">Secondary</Badge>
            <Badge variant="outline">Outline</Badge>
            <Badge variant="destructive">Destructive</Badge>
          </div>
        </Section>

        <Section title="Metric tiles — values stay white; colour goes on the dot, not the number">
          <MetricGrid>
            <Metric label="Total hours" value="162.5 h" sub="actual · from Connecteam" />
            <Metric label="Est. ready payroll" value="$48,250" sub="12 ready workers" tone="positive" />
            <Metric label="Blocked payroll" value="$3,100" sub="2 blocked" tone="attention" />
            <Metric label="Exceptions" value="4" sub="anomalies to review" tone="critical" />
          </MetricGrid>
          <FigureStrip
            figures={[
              { label: "Workers", value: 14 },
              { label: "Ready", value: 12, tone: "positive" },
              { label: "Review", value: 2, tone: "attention", sep: true },
              { label: "Hours", value: "162.5" },
            ]}
          />
        </Section>

        <Section title="Compact table — hover, selected row, keyboard-focusable action">
          <div className={compactTableFrameCls}>
            <table className={compactTableCls} style={{ minWidth: 640 }}>
              <thead>
                <tr className={compactTheadRowCls}>
                  <th className={compactThCls}>Worker</th>
                  <th className={`${compactThCls} text-right`}>Hours</th>
                  <th className={`${compactThCls} text-right`}>Rate</th>
                  <th className={compactThCls}>Status</th>
                  <th className={`${compactThCls} text-right`}>Action</th>
                </tr>
              </thead>
              <tbody>
                {WORKERS.map((w) => {
                  const isSel = selected === w.n;
                  return (
                    <tr
                      key={w.n}
                      aria-selected={isSel}
                      className={`${compactRowCls} ${isSel ? "bg-row-hover ring-1 ring-inset ring-ring/40" : ""}`}
                    >
                      <td className={`${compactTdCls} font-medium text-foreground`}>{w.n}</td>
                      <td className={`${compactTdCls} text-right tabular-nums`}>{w.h}</td>
                      <td className={`${compactTdCls} text-right tabular-nums`}>{w.r}</td>
                      <td className={compactTdCls}>
                        <StatusBadge tone={w.tone} animated={w.tone === "info"} size="sm">{w.s}</StatusBadge>
                      </td>
                      <td className={`${compactTdCls} text-right`}>
                        <Button size="xs" variant="outline" onClick={() => setSelected(w.n)}>
                          {isSel ? "Selected" : "Select"}
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-meta">Tab to the Select buttons to see the focus ring; the selected row keeps a subtle inset ring + row-hover fill.</p>
        </Section>

        <Section title="Empty / error states">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <EmptyState icon={<Inbox className="size-5" />} title="Nothing to review yet" body="No worker hours for this period. Run a sync to pull hours." action={<Button size="sm">Sync hours</Button>} />
            <ErrorState tone="attention" title="Connecteam unavailable" body="The time source did not respond. This is not an empty set — retry the pull." action={<Button size="sm" variant="outline">Retry</Button>} />
          </div>
        </Section>

        <Section title="Integration states">
          <Surface className="flex flex-wrap items-center gap-x-8 gap-y-3">
            <span className="inline-flex items-center gap-2"><Plug className="size-4 text-meta" /><StatusMark tone="positive" label="Goodshuffle — live" /></span>
            <span className="inline-flex items-center gap-2"><Plug className="size-4 text-meta" /><StatusMark tone="attention" label="Connecteam — stale 2h" /></span>
            <span className="inline-flex items-center gap-2"><Plug className="size-4 text-meta" /><StatusMark tone="critical" label="Gusto — disconnected" /></span>
            <span className="inline-flex items-center gap-2"><Plug className="size-4 text-meta" /><StatusMark tone="idle" label="Instawork — idle" /></span>
          </Surface>
        </Section>

        <Section title="Layout patterns">
          <div className="space-y-2">
            <div className="text-[12px] text-meta">1 · Overview with context column</div>
            <OverviewLayout
              main={<Surface className="h-24">Main work area</Surface>}
              context={<Surface className="h-24">Context rail</Surface>}
            />
          </div>
          <div className="space-y-2">
            <div className="text-[12px] text-meta">2 · Full-width work surface</div>
            <WorkSurfaceLayout toolbar={<Toolbar justify="start"><Button size="sm" variant="outline">Filter</Button><Button size="sm" variant="outline">Sort</Button></Toolbar>}>
              <Surface className="h-20">Table / board</Surface>
            </WorkSurfaceLayout>
          </div>
          <div className="space-y-2">
            <div className="text-[12px] text-meta">3 · Operational timeline</div>
            <TimelineLayout>
              <TimelineItem dot={<StatusMark tone="positive" label="done" />}><span className="text-[13px]">Connecteam import · 162.5 h</span></TimelineItem>
              <TimelineItem dot={<StatusMark tone="attention" label="warn" />}><span className="text-[13px]">Unmatched workers · 2</span></TimelineItem>
              <TimelineItem dot={<StatusMark tone="idle" label="idle" />}><span className="text-[13px]">Gusto push · disabled</span></TimelineItem>
            </TimelineLayout>
          </div>
          <div className="space-y-2">
            <div className="text-[12px] text-meta">4 · Focused form with summary</div>
            <FocusFormLayout
              form={<Surface className="h-24">Form fields</Surface>}
              summary={<Surface className="h-24">Summary · what happens on save</Surface>}
            />
          </div>
        </Section>

        <Section title="Chart tokens">
          <div className="space-y-3">
            <div>
              <div className="mb-1.5 text-[12px] text-meta">Categorical ramp (stable by index)</div>
              <div className="flex gap-2">
                {CHART_CATEGORY.map((c, i) => (
                  <div key={i} className="flex flex-col items-center gap-1">
                    <span className="size-10 rounded-md border border-border" style={{ background: c }} aria-hidden />
                    <span className="text-[11px] text-meta">{i + 1}</span>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <div className="mb-1.5 text-[12px] text-meta">Semantic status marks + accent (separate from the status-indicator palette)</div>
              <div className="flex gap-2">
                {Object.entries(CHART_STATUS).map(([k, c]) => (
                  <div key={k} className="flex flex-col items-center gap-1">
                    <span className="size-10 rounded-md border border-border" style={{ background: c }} aria-hidden />
                    <span className="text-[11px] text-meta">{k}</span>
                  </div>
                ))}
                <div className="flex flex-col items-center gap-1">
                  <span className="size-10 rounded-md border border-border" style={{ background: CHART_ACCENT }} aria-hidden />
                  <span className="text-[11px] text-meta">gold</span>
                </div>
              </div>
            </div>
          </div>
        </Section>

        <Section title="Verified / inferred provenance">
          <Surface className="flex flex-wrap gap-4">
            <Provenance kind="verified" detail="live from Connecteam" />
            <Provenance kind="inferred" detail="from schedule" />
            <Provenance kind="unverified" detail="no source" />
            <ActionVerb primary="Approve" secondary="then push" />
          </Surface>
        </Section>
      </div>
    </main>
  );
}
