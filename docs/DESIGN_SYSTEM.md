# Nocturne design system — shared foundations

The one visual system every blade consumes: semantic tokens + a small set of primitives. This is the
Phase-1 foundation (prompt `01_SHARED_DESIGN_FOUNDATIONS`). The shell/nav (prompt 02) and the
individual blades (prompts 03+) build on what is documented here and do **not** re-declare global CSS,
tokens, typography, or chart colours.

> House rules this system respects: **one typeface (Inter)**, hierarchy from size + colour + weight
> (never above 600), flat panels (the border does the work — no glow), small radii, tabular numerals
> for money/hours, and status colour that always carries a text label (never colour alone).

Live reference: **`/admin/design`** (admin-only, not in the nav) renders every token and primitive and
has a light/dark preview toggle.

---

## 1. Where things live

| Thing | File |
| --- | --- |
| Tokens (light `:root` + dark `.dark`) + Tailwind `@theme` mapping | `src/app/globals.css` |
| Semantic tone vocabulary (positive/attention/critical/info/neutral) | `src/lib/tone.ts` |
| Chart tokens (categorical ramp vs semantic status) | `src/lib/chartTokens.ts` |
| Status chip | `src/components/ui/status.tsx` → `StatusBadge` |
| Surface / panel | `src/components/ui/surface.tsx` → `Surface` |
| Page header + toolbar | `src/components/ui/page-header.tsx` → `PageHeader`, `Toolbar` |
| Metric tile + grid | `src/components/ui/metric.tsx` → `Metric`, `MetricGrid` |
| Empty / error / stale states | `src/components/ui/states.tsx` → `EmptyState`, `ErrorState`, `StaleBadge` |
| Four layout patterns + blade container | `src/components/ui/layouts.tsx` |
| Pre-existing shared primitives (tiers, figures, verbs, tables, provenance, dots) | `src/components/console-primitives.tsx` |
| Form controls, dialog, select, badge, button, card | `src/components/ui/*` (shadcn base-nova on Base UI) |

`console-primitives.tsx` **predates** this task and is used by ~28 files — it is part of the system,
not legacy. This task **extended** it (see §7); it was not replaced.

---

## 2. Semantic tokens

Every colour is a CSS custom property so it themes automatically. The neutral base (canvas, surfaces,
borders, text tiers) is monochrome ink-on-white in light and indigo-tinted near-black in dark; **hue
appears only in the status layer**, because status colour means something.

| Role | Token | Tailwind utility |
| --- | --- | --- |
| Canvas | `--background` | `bg-background` |
| Sidebar | `--sidebar` | `bg-sidebar` |
| Surface / panel | `--panel` (and `.surface` = `--card`) | `bg-panel`, `.surface` |
| Row / inset well | `--row`, hover `--row-hover` | `bg-row`, `hover:bg-row-hover` |
| Raised surface (popover/menu) | `--lifted` | `bg-lifted` |
| Border / UI boundary | `--border`, rows `--row-rule`, grid `--grid-rule` | `border-border`, `border-rule`, `border-grid-rule` |
| Editable input | `--input` | `border-input` |
| Primary text | `--foreground` | `text-foreground` |
| Secondary text | `--text-secondary` | `text-secondary-text` |
| Tertiary text | `--text-tertiary` | `text-tertiary-text` |
| Muted / metadata text | `--text-meta` | `text-meta` |
| Focus ring | `--ring` | `ring-ring`, `focus-visible:*` |
| Brand action (high-contrast target) | `--primary` | `bg-primary` |
| Brand accent (Command Center only) | `--gold` | `text-gold`, `bg-gold` |
| Status: positive / attention / critical / info | `--positive` / `--attention` / `--critical` / `--info` | `text-positive`, `bg-attention/10`, … |
| Chart bars / neutral marks | `--bar`, `--bar-2`, `--chart-1..5` | `bg-bar`, `bg-chart-1` |

### Tone vocabulary (`src/lib/tone.ts`)

`Tone = "positive" | "attention" | "critical" | "info" | "neutral"`. Maps: `TONE_TEXT`, `TONE_DOT`,
`TONE_SOFT` (bordered chip), `TONE_SOLID` (dense pill). Use these instead of re-typing the class
strings so "blocked" reads the same everywhere.

---

## 3. Measured contrast (WCAG)

Computed with the WCAG 2.x formula on the actual token values, including translucent chips composited
over their surface. Target: **4.5:1** normal text, **3:1** large text / meaningful boundaries.

**Dark (shipped theme), foreground pairs:**

| Pair | Ratio | Note |
| --- | --- | --- |
| `foreground` on canvas / panel / row | 14.5 / 14.3 / 13.7 | AAA |
| `text-secondary` on canvas | 11.8 | AAA |
| `text-tertiary` on canvas | 8.8 | AAA |
| `text-meta` on canvas / panel / row / lifted | 5.4 / 5.3 / 5.1 / 4.7 | **AA** — raised from the old `#75798c` (3.8–4.1, failed AA) to `#8a8ea2` |
| `positive` / `attention` / `critical` / `info` on canvas | 8.7 / 8.8 / 6.4 / 8.3 | AAA |
| soft chip text over `/10` tint on panel | 5.0–7.2 | AA–AAA |
| `ring` (#9184d9) on canvas | 5.5 | ≥3:1 focus |

**Light theme (now token-complete; see §6), foreground pairs:**

| Pair | Ratio |
| --- | --- |
| `foreground` on white | 19.4 |
| `text-secondary` / `text-tertiary` / `text-meta` on white | 12.7 / 8.5 / 6.0 |
| `positive #147a43` / `attention #8a5a00` / `critical #bf2d1c` / `info #2060c0` on white | 5.4 / 5.9 / 5.8 / 6.0 |
| status text over its `/10` tint (chip) | 4.6–5.4 |
| `gold #7a5c12` on white | 6.2 |

Decorative hairlines (`--row-rule`, `--grid-rule`) are intentionally below 3:1 — they are not
meaningful boundaries; the meaningful boundary token is `--border`.

**Focus & targets:** `:focus-visible` is a 2px `--ring` outline with 2px offset (global, in
`globals.css`). Buttons are ≥24px (xs) up to 36px (lg); the default is 32px tall.

---

## 4. Typography scale

Inter throughout. `--font-heading` is an explicit alias of the body font (so the `font-heading`
utility resolves instead of falling back to a system font).

| Use | Size | Where |
| --- | --- | --- |
| Display / hero | 28px | overview/Command-Center header (`PageHeader size="display"`) |
| Page title | 22px | blade header (`PageHeader size="page"`, default) |
| Section | 18px | sub-section headings |
| Body / input | 14–15px | prose, form controls |
| Dense table | 12.5–13px | data tables |
| Metadata | 11–12px | labels, captions, meta tier |

Money/hours use `tabular-nums` (the `<body>` sets it globally). Avoid widespread uppercase tracking —
reserve small-caps for column headers and short severity pills.

> **Conflict resolved:** prompt 01 suggested 26–30px page titles, but every shipped blade (Payroll
> included) uses a 22px `tracking-tight` title. **Payroll/Nocturne wins** — changing it would desync
> every header. `PageHeader` defaults to 22px (`size="page"`) and offers 28px (`size="display"`) for
> hero headers, which lands inside the prompt's range where it's wanted.

---

## 5. Primitives — quick reference

- **`PageHeader`** `{ title, icon?, subtitle?, actions?, size? }` — the blade header.
- **`Toolbar`** `{ justify? }` — a wrapping control row.
- **`Surface`** `{ pad?, raised?, border? }` — the flat `.surface border` panel.
- **`Metric` / `MetricGrid`** — stat tiles; `tone` emphasises a value.
- **`StatusBadge`** `{ tone, variant: "soft"|"solid", icon?, uppercase? }` — the status chip.
- **`EmptyState` / `ErrorState` / `StaleBadge`** — ZERO vs UNAVAILABLE vs STALE, kept distinct.
- **Layouts:** `BladeMain` (page container), `OverviewLayout`, `WorkSurfaceLayout`,
  `TimelineLayout` + `TimelineItem`, `FocusFormLayout`.
- **From `console-primitives`:** `StatusMark` (dot + label), `FigureStrip`, `ActionVerb`,
  `Provenance`, tier helpers, and the two table recipes below.

### Tables — two archetypes (both in `console-primitives.tsx`)

- **A · Data grid** (`tableCls`/`theadCls`/`thCls`/`tdCls`/`rowCls`): `table-fixed`, sticky header on
  the canvas, 13.5px. For a table that *is* the page.
- **B · Compact bounded** (`compactTableFrameCls`/`compactTableCls`/`compactThCls`/…): a bordered
  surface that scrolls horizontally in its own box, 12.5px, small-caps header. The Payroll style.

Either way, tables scroll inside a **bounded container** — the page never scrolls sideways.

---

## 6. Themes

The app currently ships **dark-locked** (`<html class="dark">` in `src/app/layout.tsx`; there is no
theme switcher yet). Before this task the extended tokens existed only under `.dark`, so the light
theme's surfaces, text tiers and statuses were undefined/broken. This task defined the **full token
set in light `:root`** too (measured AA, §3), so the single system is now complete and consistent in
both themes. **Wiring a real light/dark/system switch is prompt 02's job** (shell/nav); the tokens are
ready for it. `/admin/design` previews light by toggling `.dark` for that view only.

---

## 7. Chart tokens (`src/lib/chartTokens.ts`)

Two separate languages — never mix:

- **Categorical series** → `CHART_CATEGORY` / `categoryColor(i)`: the ordered `--chart-1..5` ramp,
  stable by index. For >5 categories, group the tail into "Other" rather than inventing colours.
- **Semantic status marks** → `CHART_STATUS` (positive/attention/critical/info/neutral): use only
  when a mark *means* a state.
- **`CHART_ACCENT`** (gold) is the Command-Center accent only. **`CHART_CHROME`** gives axis/grid/
  label/tooltip colours. Always pair a chart with a readable legend or an equivalent data table
  (colour is not the only encoding).

---

## 8. What this task changed vs. what already existed

**Already existed (kept, preserved, consumed):** the Nocturne token names and dark values, `.surface`,
the `@theme` utility mapping, Inter via `next/font`, the shadcn base-nova primitives (`button`,
`badge`, `card`, `input`, …), and `console-primitives.tsx` (tiers, `FigureStrip`, `StatusMark`,
`ActionVerb`, `Provenance`, the data-grid table constants). Payroll's styling is unchanged.

**Added / fixed by this task:**
1. **Light `:root`** now carries the full extended token set (was dark-only) — measured AA.
2. **`--text-meta`** darkened→lightened to AA (`#75798c` → `#8a8ea2`) — fixes the "looks disabled" note.
3. **`--info`** status + **`--font-heading`** alias + utility mappings (`--color-row-hover`,
   `--color-grid-rule`, `--color-bar(-2)`, `--color-gold`, `--color-info`).
4. **New primitives:** `PageHeader`, `Toolbar`, `Surface`, `Metric`/`MetricGrid`, `StatusBadge`,
   `EmptyState`/`ErrorState`/`StaleBadge`, the four layout patterns, `tone.ts`, `chartTokens.ts`.
5. **Extended `console-primitives.tsx`:** tokenised the hard-coded dark hex in `tierRowBg` (now works
   in light), added the compact-table constant set.
6. The shared **console `not-found.tsx`** rebuilt on these primitives (the representative migration),
   and the **`/admin/design`** showcase.

Later prompts: consume these primitives and tokens; do not add competing ones or edit `globals.css`.
