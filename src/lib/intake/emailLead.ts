// Email to hello@ → lead. A Gmail Zap POSTs each new email (raw trigger output) to /api/intake/email. This
// module is the pure part: read the email out of whatever shape Zapier sends, then run the FREE checks that
// throw out everything that is not a new customer (our own mail, automated mail, replies, other platforms,
// sales pitches). Only what survives, and still reads like a rental inquiry, can become a Goodshuffle project.
// The route adds the I/O checks (existing contact, already a lead) and a cheap model for the unclear ones.
// No DB, no network: unit-testable.

import { flattenPayload, splitName } from "./sourceAdapters";
import type { WebLeadInput } from "./webLead";

export interface InboundEmail {
  fromEmail: string;
  fromName: string;
  subject: string;
  /** The new text only: quoted replies, forwarded headers and phone signatures cut off. */
  body: string;
  messageId: string;
  threadId: string;
  /** Lowercased header name → value, when the Zap sends headers. */
  headers: Record<string, string>;
  /** Gmail labels / categories (CATEGORY_PROMOTIONS, SPAM, ...). */
  labels: string[];
}

type Flat = Record<string, string>;

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

/** First flattened value whose key ends with one of these (exact suffix match on "__"-joined keys). */
function byKey(flat: Flat, ...suffixes: string[]): string {
  for (const s of suffixes) if (flat[s]) return flat[s];
  for (const s of suffixes) {
    const hit = Object.entries(flat).find(([k, v]) => v && k.endsWith(`__${s}`));
    if (hit) return hit[1];
  }
  return "";
}

/** `"Jane Doe" <jane@x.com>` → { name, email }. */
export function parseAddress(raw: string): { name: string; email: string } {
  const email = (raw.match(EMAIL_RE)?.[0] ?? "").toLowerCase();
  const name = raw.replace(/<[^>]*>/g, "").replace(EMAIL_RE, "").replace(/["']/g, "").trim();
  return { name, email };
}

function headersFrom(flat: Flat): Record<string, string> {
  const out: Record<string, string> = {};
  // [{name, value}] arrays (Gmail API payload.headers), flattened to ...headers__3__name / ...headers__3__value
  for (const [k, v] of Object.entries(flat)) {
    const m = k.match(/^(.*headers__\d+)__name$/);
    if (m) {
      const val = flat[`${m[1]}__value`];
      if (val != null) out[v.toLowerCase()] = val;
    }
  }
  // { "List-Unsubscribe": "..." } objects, flattened to ...headers__list-unsubscribe
  for (const [k, v] of Object.entries(flat)) {
    const m = k.match(/headers__([a-z][a-z0-9-]*)$/);
    if (m && !/^\d+$/.test(m[1]) && m[1] !== "name" && m[1] !== "value") out[m[1]] ??= v;
  }
  return out;
}

/** Keep only the sender's new words: drop quoted history, forwarded blocks and "Sent from my iPhone". */
export function newText(body: string): string {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (/^On .{4,200}wrote:?$/i.test(t)) break;
    if (/^-{2,}\s*(Original Message|Forwarded message)/i.test(t)) break;
    if (/^From:\s.+/i.test(t) && out.length) break; // Outlook-style quoted header
    if (/^_{8,}$/.test(t)) break;
    if (/^Sent from my (iPhone|iPad|Android|Galaxy|phone)/i.test(t)) break;
    if (t.startsWith(">")) continue;
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function stripHtml(html: string): string {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/p>|<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ");
}

/** Whatever the Gmail trigger sends (nested JSON, Zapier "__" keys, or plain fields) → one InboundEmail. */
export function parseInboundEmail(raw: unknown): InboundEmail {
  const flat = flattenPayload(raw);
  let fromEmail = byKey(flat, "from__email", "from_email", "sender__email", "sender_email", "fromemail").toLowerCase();
  let fromName = byKey(flat, "from__name", "from_name", "sender__name", "sender_name", "fromname");
  const fromRaw = byKey(flat, "from", "sender", "reply_to");
  if (!fromEmail && fromRaw) {
    const a = parseAddress(fromRaw);
    fromEmail = a.email;
    fromName ||= a.name;
  }
  const headers = headersFrom(flat);
  if (!fromEmail && headers.from) {
    const a = parseAddress(headers.from);
    fromEmail = a.email;
    fromName ||= a.name;
  }
  const subject = byKey(flat, "subject") || headers.subject || "";
  const plain = byKey(flat, "body_plain", "plain", "text", "body", "snippet");
  const html = plain ? "" : byKey(flat, "body_html", "html");
  const labels = Object.entries(flat)
    .filter(([k]) => /(^|__)(labels?|label_ids|labelids|categories)(__\d+)?$/.test(k))
    .flatMap(([, v]) => v.split(/[,\s]+/))
    .filter(Boolean);
  return {
    fromEmail: fromEmail.trim(),
    fromName: fromName.trim(),
    subject: subject.trim(),
    body: newText(plain || stripHtml(html)),
    messageId: byKey(flat, "message_id", "messageid", "id"),
    threadId: byKey(flat, "thread_id", "threadid"),
    headers,
    labels,
  };
}

// ── The free checks ─────────────────────────────────────────────────────────────────────────────────────

export type SkipReason =
  | "no_sender"
  | "own_address"
  | "automated"
  | "reply"
  | "other_channel"
  | "not_a_lead";

const OWN_DOMAINS = ["zoeeventsdmv.com", "zoeeventrentals.com"];

/** Senders whose mail is never a new customer writing to us: platforms with their own lead Zap (Yelp,
 *  Google), the tools we run on, payment and social notifications. EMAIL_INTAKE_SKIP_DOMAINS adds more. */
const PLATFORM_DOMAINS = [
  "yelp.com", "google.com", "googlemail.com", "goodshuffle.com", "goodshufflepro.com", "zapier.com", "slack.com",
  "openphone.com", "openphone.co", "quo.com", "gusto.com", "connecteam.com", "instawork.com", "intuit.com",
  "stripe.com", "paypal.com", "squareup.com", "square.com", "mercury.com", "facebookmail.com", "meta.com",
  "linkedin.com", "instagram.com", "amazon.com", "thumbtack.com", "theknot.com", "weddingwire.com",
  "eventective.com", "zonarsystems.com", "kinsta.com", "wordpress.com", "wpengine.com", "docusign.net",
  "calendly.com", "hubspot.com", "mailchimp.com", "constantcontact.com", "canva.com", "apple.com", "microsoft.com",
];

const AUTOMATED_LOCAL =
  /^(no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|bounces?|notifications?|notify|alerts?|newsletters?|news|updates|digest|automated|system|billing|invoices?|receipts?|accounts?|security|verify|wordpress|calendar|support-noreply)([+._-].*)?$/i;

const BULK_LABELS = /^(CATEGORY_)?(PROMOTIONS|SOCIAL|UPDATES|FORUMS|SPAM|TRASH)$/i;

function listEnv(name: string): string[] {
  return (process.env[name] ?? "").split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function domainOf(email: string): string {
  return email.split("@")[1]?.toLowerCase() ?? "";
}

function domainIn(domain: string, list: string[]): boolean {
  return list.some((d) => domain === d || domain.endsWith(`.${d}`));
}

/** Signals that a stranger is asking to rent. Counted, not weighted: a real inquiry trips several. */
const POSITIVE: RegExp[] = [
  /\brent(al|als|ing)?\b/i,
  /\bquotes?\b|\bestimate\b|\bpric(e|es|ing)\b|\bhow much\b|\bcost\b/i,
  /\bavailab(le|ility)\b/i,
  /\btents?\b|\bcanop(y|ies)\b/i,
  /\bchairs?\b|\btables?\b|\blinens?\b|\bdance floor\b|\bstag(e|ing)\b|\blounge\b|\bfurniture\b|\bbar\b|\bheaters?\b/i,
  /\bwedding\b|\bbirthday\b|\bparty\b|\bshower\b|\bgraduation\b|\breception\b|\bgala\b|\bfestival\b|\bcorporate event\b|\bpicnic\b|\bquincea/i,
  /\b\d{2,4}\s*(guests|people|attendees|pax|persons)\b|\bguest count\b/i,
  /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(st|nd|rd|th)?\b|\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/i,
  /\bdeliver(y|ed)?\b|\bset ?up\b|\bpick ?up\b/i,
  /\b(book|reserve)\b/i,
];

/** Signals of a pitch, a job seeker, a vendor or a bill. */
const NEGATIVE: RegExp[] = [
  /\bseo\b|\bbacklinks?\b|\bguest post\b|\bdomain authority\b|\brank(ing)? (higher|on google|#?1)\b/i,
  /\bweb ?(site)? (design|redesign|development)\b|\bmarketing (services|agency|campaign)\b|\blead generation\b|\bsocial media management\b/i,
  /\bpartnership\b|\bcollaborat(e|ion)\b|\bsponsor(ship)?\b|\baffiliate\b|\binfluencer\b/i,
  /\binvoice\b|\bpayment (reminder|due|failed)\b|\bpast due\b|\byour (account|subscription|order)\b/i,
  /\bunsubscribe\b|\bview (this|it) in your browser\b|\bmanage (your )?preferences\b/i,
  /\bresume\b|\bcv\b|\bjob (opening|application|posting)\b|\bpositions?\b|\bhiring\b|\bemployment\b/i,
  /\bwholesale\b|\bsupplier\b|\bmanufacturer\b|\bfactory\b|\bdistributor\b|\bcatalog(ue)? attached\b/i,
  /\bwe (offer|provide|specialize)\b|\bour (company|agency|team) (offers|provides|helps)\b|\bi am reaching out from\b/i,
  /\bloans?\b|\bfunding\b|\bmerchant cash\b|\bcredit line\b|\bcrypto\b|\bbitcoin\b/i,
];

export interface Signals {
  positive: number;
  negative: number;
}

export function signals(e: Pick<InboundEmail, "subject" | "body">): Signals {
  const text = `${e.subject}\n${e.body}`;
  return { positive: POSITIVE.filter((r) => r.test(text)).length, negative: NEGATIVE.filter((r) => r.test(text)).length };
}

export type RuleVerdict =
  | { decision: "skip"; reason: SkipReason; detail: string }
  | { decision: "lead" | "unsure"; signals: Signals };

/** The free, deterministic gate. Order matters: the cheapest, surest reasons first. */
export function ruleVerdict(e: InboundEmail): RuleVerdict {
  const skip = (reason: SkipReason, detail: string): RuleVerdict => ({ decision: "skip", reason, detail });
  if (!e.fromEmail || !EMAIL_RE.test(e.fromEmail)) return skip("no_sender", "no sender address");
  const domain = domainOf(e.fromEmail);
  const local = e.fromEmail.split("@")[0];
  if (domainIn(domain, [...OWN_DOMAINS, ...listEnv("EMAIL_INTAKE_OWN_DOMAINS")])) return skip("own_address", `from our own domain (${domain})`);
  if (domainIn(domain, [...PLATFORM_DOMAINS, ...listEnv("EMAIL_INTAKE_SKIP_DOMAINS")])) return skip("other_channel", `platform or tool sender (${domain})`);
  if (AUTOMATED_LOCAL.test(local)) return skip("automated", `automated sender (${local}@)`);
  const h = e.headers;
  if ((h["auto-submitted"] && !/^no$/i.test(h["auto-submitted"])) || h["list-unsubscribe"] || h["list-id"] || /bulk|list|junk/i.test(h.precedence ?? "") || h["x-autoreply"] || h["x-autorespond"]) {
    return skip("automated", "bulk or auto-generated (mail headers)");
  }
  const bulk = e.labels.find((l) => BULK_LABELS.test(l));
  if (bulk) return skip("automated", `Gmail filed it as ${bulk.replace(/^CATEGORY_/i, "").toLowerCase()}`);
  if (/^\s*(re|fw|fwd|aw|sv|tr)\s*(\[\d+\])?\s*[:：]/i.test(e.subject) || h["in-reply-to"] || h.references) {
    return skip("reply", "a reply or forward in an existing thread");
  }
  if (/^(auto(matic)? ?reply|out of (the )?office|delivery status notification|undeliverable|returned mail)/i.test(e.subject)) {
    return skip("automated", "auto reply or bounce");
  }
  const s = signals(e);
  if (s.negative >= 2 && s.positive < 3) return skip("not_a_lead", `reads like a pitch, a bill or a job inquiry (${s.negative} signs)`);
  if (s.negative >= 1 && s.positive <= 1) return skip("not_a_lead", "no sign of a rental request");
  if (s.positive >= 3 && s.negative === 0) return { decision: "lead", signals: s };
  return { decision: "unsure", signals: s };
}

// ── Lead fields ─────────────────────────────────────────────────────────────────────────────────────────

/** Our own numbers appear in quoted signatures; never take them as the customer's. EMAIL_INTAKE_OWN_PHONES adds more. */
const OWN_PHONES = ["3012915296"];

/** The first 10 digit US phone written in the email that is not one of ours. */
export function phoneIn(text: string): string {
  const own = new Set([...OWN_PHONES, ...listEnv("EMAIL_INTAKE_OWN_PHONES").map((p) => p.replace(/\D/g, "").slice(-10))]);
  for (const m of text.match(/(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g) ?? []) {
    const d = m.replace(/\D/g, "").slice(-10);
    if (d.length === 10 && !own.has(d)) return d;
  }
  return "";
}

/** What a model may add (all optional; every field is validated before use). */
export interface ModelExtract {
  firstName?: string;
  lastName?: string;
  phone?: string;
  eventType?: string;
  eventDate?: string;
  guestCount?: number | string | null;
}

/** The lead the shared intake tail receives. Message = subject + the new text, trimmed for the notes. */
export function leadInputFromEmail(e: InboundEmail, x: ModelExtract = {}): WebLeadInput {
  const fromName = splitName(e.fromName.includes("@") ? "" : e.fromName);
  const phone = (x.phone ?? "").replace(/\D/g, "").length >= 10 ? String(x.phone) : phoneIn(e.body);
  const message = `${e.subject ? `Subject: ${e.subject}\n` : ""}${e.body}`.slice(0, 1500).trim();
  return {
    source: "email",
    firstName: (x.firstName ?? "").trim() || fromName.firstName,
    lastName: (x.lastName ?? "").trim() || fromName.lastName,
    email: e.fromEmail,
    phone,
    eventType: x.eventType ?? "",
    eventDate: /^\d{4}-\d{2}-\d{2}$/.test(x.eventDate ?? "") ? x.eventDate : "",
    guestCount: x.guestCount ?? null,
    message,
  };
}

/** The #new-leads post for an email lead (carries the email + phone Viktor's project reply matches on). */
export function emailLeadSlackText(lead: { firstName: string; lastName: string; email: string; phone: string }, e: InboundEmail): string {
  const name = `${lead.firstName} ${lead.lastName}`.trim() || "(no name)";
  return [
    `Name: ${name}`,
    `Email: ${lead.email}`,
    lead.phone ? `Phone Number: ${lead.phone}` : "",
    e.subject ? `Subject: ${e.subject}` : "",
    e.body ? `Message: ${e.body.slice(0, 600)}${e.body.length > 600 ? "..." : ""}` : "",
    "Came in by email to hello@. The original is still in the inbox.",
  ].filter(Boolean).join("\n");
}
