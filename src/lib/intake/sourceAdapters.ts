// Lead-source adapters for /api/intake/lead. The website Zap maps its fields by hand (firstName, email, ...).
// Other sources can skip the mapping: a Zapier "Webhooks by Zapier POST" step with an EMPTY Data field sends
// the previous step's raw output, so the Yelp Leads trigger's whole lead (or an AI parser's first_name /
// email_address JSON) arrives as-is. These adapters turn those raw shapes into the receiver's WebLeadInput.
// Tolerant on purpose: keys are matched by name fragments on a flattened copy, so nesting, Zapier's "__"
// key flattening, and case all work. Pure, no I/O.

import type { WebLeadInput } from "./webLead";

/** Flatten nested objects/arrays into lowercased "a__b__0__c" keys with string values. */
export function flattenPayload(raw: unknown, prefix = "", out: Record<string, string> = {}): Record<string, string> {
  if (raw == null) return out;
  if (Array.isArray(raw)) {
    raw.forEach((v, i) => flattenPayload(v, prefix ? `${prefix}__${i}` : String(i), out));
    return out;
  }
  if (typeof raw === "object") {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      flattenPayload(v, prefix ? `${prefix}__${k.toLowerCase()}` : k.toLowerCase(), out);
    }
    return out;
  }
  const s = String(raw).trim();
  if (s) out[prefix.replace(/\s+/g, "_")] = s;
  return out;
}

type Flat = Record<string, string>;

/** First value whose key contains every fragment and none of the excluded ones. */
function pick(flat: Flat, all: string[], none: string[] = []): string {
  for (const [k, v] of Object.entries(flat)) {
    if (all.every((f) => k.includes(f)) && !none.some((f) => k.includes(f))) return v;
  }
  return "";
}

/** A raw Yelp Leads trigger payload (it always carries the Yelp relay email or the Yelp lead id). */
export function isYelpLeadPayload(raw: unknown): boolean {
  const flat = flattenPayload(raw);
  return Object.keys(flat).some((k) => k.includes("temporary_email") || k.includes("yelp_lead_id") || k.includes("leads_center"))
    || Object.values(flat).some((v) => /@messaging\.yelp\.com$/i.test(v));
}

/** "Mel H." → { firstName: "Mel", lastName: "H." }. Yelp shows a first name and a last initial. */
export function splitName(full: string): { firstName: string; lastName: string } {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return { firstName: parts[0] ?? "", lastName: "" };
  return { firstName: parts.slice(0, -1).join(" "), lastName: parts[parts.length - 1] };
}

export interface YelpLeadExtras {
  /** Link to reply to the lead in Yelp's leads center (when the ids are present). */
  replyUrl: string;
  postalCode: string;
  /** "What do you need to rent?: Bar and beverage service equipment" lines. */
  answers: string[];
  /** The relay email stops working after this (ISO), so the team should get a real address. */
  emailExpiry: string;
}

/** Turn a raw Yelp Leads trigger payload into a lead + the Yelp-only extras. */
export function fromYelpLead(raw: unknown): { lead: WebLeadInput; yelp: YelpLeadExtras } {
  const flat = flattenPayload(raw);
  const email =
    pick(flat, ["temporary_email"], ["expir"]) || Object.values(flat).find((v) => /@messaging\.yelp\.com$/i.test(v)) || "";
  const phone = pick(flat, ["temporary_phone"], ["expir"]);
  const name = pick(flat, ["display_name"]) || pick(flat, ["user_name"]) || pick(flat, ["user", "name"], ["business"]);
  const { firstName, lastName } = splitName(name);
  const info = pick(flat, ["additional_info"]);
  const postalCode = pick(flat, ["postal_code"], ["business"]);
  const jobs = Object.entries(flat).filter(([k]) => k.includes("job_name")).map(([, v]) => v);

  // Survey answers come flattened as ...survey_answers__<i>__question_text and ...__answer_text(__<j>).
  const answers: string[] = [];
  const qKeys = Object.keys(flat).filter((k) => /survey_answers__\d+__question_text$/.test(k));
  for (const qk of qKeys) {
    const base = qk.replace(/__question_text$/, "");
    const a = Object.entries(flat)
      .filter(([k]) => k.startsWith(`${base}__answer_text`))
      .map(([, v]) => v)
      .join(", ");
    if (a) answers.push(`${flat[qk]}: ${a}`);
  }
  if (!answers.length) {
    const formatted = pick(flat, ["survey_answers_formatted"]);
    if (formatted) answers.push(...formatted.split(/\n+/).filter(Boolean));
  }

  const leadId = pick(flat, ["yelp_lead_id"]) || flat["id"] || "";
  const bizId = pick(flat, ["business_id"]) || pick(flat, ["yelp_business_id"]);
  const replyUrl =
    pick(flat, ["leads_center"]) ||
    Object.values(flat).find((v) => v.includes("biz.yelp.com/leads_center")) ||
    (leadId && bizId ? `https://biz.yelp.com/leads_center/${bizId}/leads/${leadId}` : "");

  const message = [
    jobs.length ? `Yelp request: ${jobs.join(", ")}` : "",
    ...answers,
    postalCode ? `ZIP: ${postalCode}` : "",
    info ? `\n${info}` : "",
  ]
    .filter(Boolean)
    .join("\n")
    .trim();

  return {
    lead: {
      source: "yelp",
      firstName,
      lastName,
      email,
      phone,
      message,
      submittedAt: pick(flat, ["time_created"]) || undefined,
    },
    yelp: { replyUrl, postalCode, answers, emailExpiry: pick(flat, ["temporary_email", "expir"]) },
  };
}

/** Any POSTed body → the receiver's WebLeadInput. A raw Yelp lead is recognized by shape; anything else goes
 *  through the loose field-name mapping. `sourceHint` (the ?source= query param) fills a missing source. */
export function adaptLeadBody(body: unknown, sourceHint = ""): { input: WebLeadInput; yelp: YelpLeadExtras | null } {
  const obj = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  if (isYelpLeadPayload(obj)) {
    const { lead, yelp } = fromYelpLead(obj);
    return { input: lead, yelp };
  }
  const input = fromLooseFields(obj);
  if (!String(input.source ?? "").trim() && sourceHint.trim()) input.source = sourceHint.trim();
  return { input, yelp: null };
}

/** The #new-leads post for a lead whose Zap does not post one itself (Yelp). Same shape as the website
 *  form's post, so the team reads every lead the same way, and it carries the email/phone Viktor's
 *  "project created" thread reply matches on. */
export function newLeadSlackText(
  lead: { source: string; firstName: string; lastName: string; email: string; phone: string; message: string },
  yelp: YelpLeadExtras | null,
): string {
  const name = `${lead.firstName} ${lead.lastName}`.trim() || "(no name)";
  const lines = [
    `Name: ${name}`,
    lead.email ? `Email: ${lead.email}${yelp ? " (Yelp relay address, replies reach the customer in Yelp)" : ""}` : "",
    lead.phone ? `Phone Number: ${lead.phone}` : "",
    lead.message ? `Message: ${lead.message}` : "",
    yelp?.replyUrl ? `Reply in Yelp: ${yelp.replyUrl}` : "",
  ];
  return lines.filter(Boolean).join("\n");
}

/** snake_case / alternate field names (an AI parser's first_name, email_address, phone_number, ...) onto the
 *  receiver's camelCase fields. Fields already in camelCase win. */
export function fromLooseFields(raw: Record<string, unknown>): WebLeadInput {
  const flat = flattenPayload(raw);
  const get = (...keys: string[]) => {
    for (const k of keys) if (flat[k]) return flat[k];
    return "";
  };
  const name = get("name", "full_name", "fullname");
  const split = splitName(name);
  return {
    source: get("source"),
    firstName: get("firstname", "first_name") || split.firstName,
    lastName: get("lastname", "last_name") || split.lastName,
    email: get("email", "email_address", "emailaddress"),
    phone: get("phone", "phone_number", "phonenumber"),
    eventType: get("eventtype", "event_type"),
    eventDate: get("eventdate", "event_date"),
    guestCount: get("guestcount", "guest_count", "guests"),
    message: get("message", "notes", "body"),
    submittedAt: get("submittedat", "submitted_at"),
  };
}
