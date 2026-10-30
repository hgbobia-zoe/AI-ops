// Inbound "Gusto received your wire transfer" email → payroll-channel confirmation. The RECEIVE-side bookend
// to the Mercury "wire sent" alert (/api/payroll/wire-detected): Gusto itself confirms the payroll wire
// landed, so the team sees the loop close in the payroll channel. A Gmail → Zapier zap (trigger: a new email
// from assurance@gusto.com whose subject contains "wire transfer") POSTs the email to
// /api/payroll/gusto-wire-received; this module is the deterministic, Slack-free core behind that endpoint:
// parse the amount/date out of the (untrusted) email, then build the confirmation card. The correlation to the
// wire we already recorded and the Slack post itself live in the endpoint. Message strings run through
// humanize() so they follow the house COMMS_STYLE (no dashes, no emoji). READ-only: never moves money and
// never runs or confirms payroll in Gusto.

import { humanize } from "@/lib/salesos/outreach";
import { appUrl, type BotCard } from "@/lib/notify/aiBots";
import { formatUsd, fmtDate, type WirePeriodMatch } from "./wireEvent";

// ── Normalize the (untrusted / partial) email payload ─────────────────────────────────────────────────
export interface GustoReceiptInput {
  amount?: unknown; // structured amount, if the Zap parsed it (sign ignored)
  amountText?: unknown; // or the raw "$2,158.58"
  date?: unknown; // ISO or human date the Zap passed (the email's received date is ideal)
  receivedOn?: unknown; // alias for date
  text?: unknown; // email body (plain text)
  body?: unknown; // alias for text
  snippet?: unknown; // Gmail snippet
  subject?: unknown;
  messageId?: unknown; // Gmail message id → the stable dedup key when present
}

export interface NormalizedReceipt {
  amountAbs: number | null;
  date: string | null; // yyyy-mm-dd (UTC) when parseable
  messageId: string | null;
  rawText: string;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** Parse a USD amount out of free text, e.g. "$2,158.58" → 2158.58. First match wins; null when none. */
export function parseUsdAmount(text: string | null): number | null {
  if (!text) return null;
  const m = text.match(/\$\s*([0-9][0-9,]*(?:\.[0-9]{2})?)/);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

/** Best-effort date → yyyy-mm-dd (UTC). Accepts ISO or anything Date parses; null when unparseable. */
export function parseReceiptDate(v: string | null): string | null {
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/** Coerce an arbitrary POST body into a NormalizedReceipt. Never throws; unknown fields become null. */
export function normalizeGustoReceipt(raw: unknown): NormalizedReceipt {
  const b = (raw ?? {}) as GustoReceiptInput;
  const rawText = [str(b.text), str(b.body), str(b.snippet), str(b.subject), str(b.amountText)].filter(Boolean).join("\n");
  // Structured amount wins; otherwise parse the text.
  const structured =
    typeof b.amount === "number" && Number.isFinite(b.amount)
      ? Math.abs(b.amount)
      : typeof b.amount === "string"
        ? parseUsdAmount(b.amount)
        : null;
  const amountAbs = structured ?? parseUsdAmount(rawText);
  const date = parseReceiptDate(str(b.date) ?? str(b.receivedOn));
  return { amountAbs, date, messageId: str(b.messageId), rawText };
}

/** Stable dedup key: the Gmail message id when present, else amount+date, so a Zapier retry never double-posts. */
export function receiptDedupKey(r: NormalizedReceipt): string {
  if (r.messageId) return `gusto-recv:${r.messageId}`;
  return `gusto-recv:${r.amountAbs ?? "?"}:${r.date ?? "?"}`;
}

// ── Card (Payroll Bot voice, house COMMS_STYLE: no dashes, no emoji) ──────────────────────────────────
/** The "Gusto received the wire" confirmation card. Body runs through humanize() (dash and emoji free). */
export function gustoReceiptCard(r: NormalizedReceipt, period: WirePeriodMatch | null): BotCard {
  const amount = r.amountAbs != null ? formatUsd(r.amountAbs) : null;
  const dateStr = r.date ? fmtDate(r.date) : null;
  const periodLabel = period?.periodLabel ?? null;
  const fields = [
    ...(amount ? [{ label: "Amount", value: amount }] : []),
    ...(dateStr ? [{ label: "Received", value: dateStr }] : []),
    ...(periodLabel ? [{ label: "Pay period", value: periodLabel }] : []),
    { label: "Confirmed by", value: "Gusto (assurance@gusto.com)" },
  ];
  const body = humanize(
    `Gusto confirmed it received the payroll wire${amount ? `, ${amount}` : ""}${dateStr ? ` on ${dateStr}` : ""}${periodLabel ? ` for the ${periodLabel} pay period` : ""}. Payroll is funded. No action needed.`,
  );
  return {
    title: "Gusto confirmed the payroll wire",
    fields,
    body,
    link: { text: "Open Payroll", url: appUrl("/payroll") },
    context: "Payroll Bot. Gusto has the funds, the payroll wire loop is closed.",
  };
}
