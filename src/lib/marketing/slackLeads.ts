// Reads one #new-leads Slack post into a lead record. PURE (no DB, no network).
//
// #new-leads is the most complete record of inbound leads: every source posts there.
//  - Website form: a Zapier post, "Reminder: Webform inquiries are time sensitive ... Name: ... Email: ..."
//  - Goodshuffle wishlist: a Zapier post, "Congrats! <name> submitted a new Wishlist '<project>' #<id>"
//  - Google Business Profile: the old Zapier post ("Google Profile Lead inquiries ...") or, since Nov 2026,
//    the app's own post as "New Google Lead"
//  - Yelp: the app's own post as "New Yelp Lead" (since Nov 2, 2026; older Yelp leads never reached Slack)
// Team chat, Viktor's replies and anything else without lead fields is ignored (returns null).

import { isTestLead, leadChannel } from "./leadSources";

export interface SlackPostLike {
  ts: string;
  text: string;
  username: string | null;
  botId: string | null;
}

export interface ParsedSlackLead {
  slackTs: string;
  receivedAt: string; // ISO
  channel: string; // website | wishlist | yelp | google | <other source key>
  name: string;
  email: string;
  phone: string;
  /** Goodshuffle project id for a wishlist, when the post carries it. */
  ref: string;
  isTest: boolean;
}

/** Slack's escaping: <mailto:a@b.com|a@b.com>, <tel:...|...>, <http://x|label>, &amp; &lt; &gt;. */
function unescapeSlack(s: string): string {
  return s
    .replace(/<(?:mailto|tel):[^|>]*\|([^>]*)>/g, "$1")
    .replace(/<(?:mailto|tel):([^>]*)>/g, "$1")
    .replace(/<(https?:[^|>]*)\|([^>]*)>/g, "$2")
    .replace(/<(https?:[^>]*)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function field(text: string, label: string): string {
  const m = text.match(new RegExp(`(?:^|\\n)\\s*${label}\\s*:\\s*([^\\n]*)`, "i"));
  return m ? m[1].trim() : "";
}

function messageField(text: string): string {
  const m = text.match(/(?:^|\n)\s*Message\s*:\s*([\s\S]*)/i);
  return m ? m[1].trim() : "";
}

function cleanEmail(raw: string): string {
  const m = raw.match(/[^\s<>()|]+@[^\s<>()|]+\.[a-z]{2,}/i);
  return m ? m[0].toLowerCase() : "";
}

function channelFor(text: string, username: string): string | null {
  if (/messaging\.yelp\.com|Yelp request:|Reply in Yelp/i.test(text) || /yelp/i.test(username)) return "yelp";
  if (/Google Profile Lead|Google Business Profile Lead/i.test(text) || /google/i.test(username)) return "google";
  if (/Webform inquiries/i.test(text)) return "website";
  const ch = leadChannel(username.replace(/^new\s+/i, "").replace(/\s+lead$/i, ""));
  return ch ? ch.key : null;
}

export function parseLeadPost(m: SlackPostLike): ParsedSlackLead | null {
  const seconds = Number(m.ts);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const receivedAt = new Date(seconds * 1000).toISOString();
  const text = unescapeSlack(m.text || "");
  // Leads are posted by Zapier or the app. A post from a person only counts when it carries a Zap's own
  // wording (a Zap set to post as its user), never a pasted "Name: ..." block.
  if (!m.botId && !/Webform inquiries|submitted a new Wishlist|Google Profile Lead/i.test(text)) return null;
  const username = m.username ?? "";

  const wish = text.match(/Congrats!\s*(.+?)\s+submitted a new Wishlist/i);
  if (wish) {
    const name = wish[1].trim();
    const ref = text.match(/#(\d{6,})/)?.[1] ?? "";
    return { slackTs: m.ts, receivedAt, channel: "wishlist", name, email: "", phone: "", ref, isTest: isTestLead({ name }) };
  }

  const name = field(text, "Name");
  if (!name) return null; // no lead fields: chat, a forwarded email, a bot notice
  const channel = channelFor(text, username) ?? "website";
  const email = cleanEmail(field(text, "Email"));
  const phone = field(text, "Phone(?: Number)?");
  const message = messageField(text);
  return { slackTs: m.ts, receivedAt, channel, name, email, phone, ref: "", isTest: isTestLead({ name, email, message }) };
}
