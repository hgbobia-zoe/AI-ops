// Bid pursuit — the review-ready package generator. Given a radar opportunity, it assembles a tailored
// capability statement, a short response letter, a submission checklist, and readiness gaps, drawing ONLY
// from the Zoe capability profile + the opportunity's own facts. Deterministic floor always available;
// the narrative can be AI-refined (facts-only, house voice) when an LLM is configured. Nothing is sent
// or submitted here — a human reviews and submits every bid.

import { chat, llmConfigured, llmModel } from "@/lib/llm";
import { humanize } from "@/lib/salesos/outreach";
import { opportunityDetail } from "@/lib/opportunity/service";
import { JURISDICTION_LABEL, ZOE_CATEGORY_LABEL } from "@/lib/opportunity/types";
import { getCapabilityProfile } from "./capabilityProfile";
import { profileCompleteness } from "./capabilityProfileShape";
import { CERT_OPTIONS } from "./capabilityProfileShape";
import type { CapabilityProfile } from "./capabilityProfileShape";
import type { BidPackage, ChecklistItem } from "./bidPackageShape";
import { formatYmdLong } from "@/lib/dates";

const CERT_LABEL: Record<string, string> = Object.fromEntries(CERT_OPTIONS.map((c) => [c.value, c.label]));

function certPhrase(p: CapabilityProfile): string {
  const named = p.certifications.map((c) => CERT_LABEL[c] ?? c);
  if (p.certificationsOther) named.push(p.certificationsOther);
  return named.join(", ");
}

function categoriesPhrase(cats: string[]): string {
  const labels = cats.map((c) => ZOE_CATEGORY_LABEL[c as keyof typeof ZOE_CATEGORY_LABEL] ?? c).filter(Boolean);
  return labels.length ? labels.map((l) => l.toLowerCase()).join(", ") : "event rentals and infrastructure";
}

/** A line only appears when its value is present — never fabricate a blank field. */
function line(label: string, value: string | null | undefined): string | null {
  const v = (value ?? "").trim();
  return v ? `${label}: ${v}` : null;
}

function buildCapabilityStatement(p: CapabilityProfile, ctx: { name: string; buyer: string | null; jurisdiction: string; cats: string[] }): string {
  const name = p.legalName || "Zoe Event Rentals";
  const blocks: string[] = [];

  // Header
  blocks.push(`${name.toUpperCase()} — CAPABILITY STATEMENT`);
  const preparedFor = ctx.buyer || ctx.name;
  if (preparedFor) blocks.push(`Prepared for ${preparedFor} (${ctx.jurisdiction})`);

  // Company
  const company: string[] = [];
  const dba = p.dba ? ` (dba ${p.dba})` : "";
  const founded = p.foundedYear ? ` Established ${p.foundedYear}.` : "";
  const area = p.serviceArea ? ` Serving ${p.serviceArea}.` : "";
  company.push(`${name}${dba} is a full-service event rental company.${founded}${area}`.trim());
  const contact = [p.website, p.phone, p.email].filter((s) => s && s.trim()).join("  |  ");
  if (contact) company.push(contact);
  if (p.address) company.push(p.address);
  blocks.push(["COMPANY", ...company].join("\n"));

  // Core competencies (tailored to the opportunity)
  const core: string[] = [];
  if (p.coreCompetencies) core.push(p.coreCompetencies);
  core.push(`Relevant to this opportunity: ${categoriesPhrase(ctx.cats)}.`);
  blocks.push(["CORE COMPETENCIES", ...core].join("\n"));

  if (p.capacitySummary) blocks.push(["CAPACITY", p.capacitySummary].join("\n"));
  if (p.differentiators) blocks.push([`WHY ${name.toUpperCase()}`, p.differentiators].join("\n"));

  if (p.pastPerformance.length) {
    const rows = p.pastPerformance.map((pp) => {
      const yr = pp.year ? ` (${pp.year})` : "";
      const detail = pp.detail ? ` — ${pp.detail}` : "";
      return `- ${pp.name}${detail}${yr}`;
    });
    blocks.push(["PAST PERFORMANCE", ...rows].join("\n"));
  }

  const certs = certPhrase(p);
  if (certs) blocks.push(["CERTIFICATIONS", certs].join("\n"));

  // Company data
  const data = [
    line("UEI", p.uei),
    line("CAGE", p.cageCode),
    line("NAICS", p.naicsCodes),
    p.samRegistered ? "SAM.gov: registered and active" : null,
    line("General liability", p.generalLiability),
    line("Auto liability", p.autoLiability),
    line("Workers' comp", p.workersComp),
    line("Umbrella / excess", p.umbrella),
    p.providesAdditionalInsured ? "Can name the client as additional insured on request" : null,
  ].filter((x): x is string => !!x);
  if (data.length) blocks.push(["COMPANY DATA", ...data].join("\n"));

  // Point of contact
  const poc: string[] = [];
  if (p.bidContactName) poc.push([p.bidContactName, p.bidContactTitle].filter(Boolean).join(", "));
  const pocContact = [p.bidContactEmail, p.bidContactPhone].filter((s) => s && s.trim()).join("  |  ");
  if (pocContact) poc.push(pocContact);
  if (poc.length) blocks.push(["POINT OF CONTACT", ...poc].join("\n"));

  return blocks.join("\n\n");
}

function buildResponseLetter(p: CapabilityProfile, ctx: { name: string; buyer: string | null; jurisdiction: string; cats: string[]; deadline: string | null; solicitation: string | null }): string {
  const name = p.legalName || "Zoe Event Rentals";
  const re = `Re: ${ctx.name}${ctx.solicitation ? ` (Solicitation ${ctx.solicitation})` : ""}`;
  const greeting = ctx.buyer ? `Dear ${ctx.buyer},` : "To the procurement team,";
  const areaClause = p.serviceArea ? ` across ${p.serviceArea}` : " across the DC, Maryland and Virginia area";
  const body: string[] = [];
  body.push(
    `${name} is interested in responding to ${ctx.name}. We provide ${categoriesPhrase(ctx.cats)}${areaClause}, and we believe we are a strong fit for this ${ctx.jurisdiction} opportunity.`,
  );
  if (p.pastPerformance.length) {
    body.push(`We have delivered comparable events and can provide references and a certificate of insurance on request.`);
  }
  const by = ctx.deadline ? ` by ${formatYmdLong(ctx.deadline)}` : " by the stated deadline";
  body.push(`We will submit a complete response${by}. Please let us know if any additional information would help.`);
  const sign = [p.bidContactName || name, [p.bidContactEmail, p.bidContactPhone].filter((s) => s && s.trim()).join("  |  ")].filter(Boolean).join("\n");

  return humanize([re, "", greeting, "", ...body, "", "Sincerely,", sign].join("\n"));
}

function buildChecklist(p: CapabilityProfile, ctx: { federal: boolean; deadline: string | null; sourceUrl: string | null; setAside: string | null }): ChecklistItem[] {
  const hasInsurance = !!(p.generalLiability || p.autoLiability || p.workersComp || p.umbrella);
  const items: ChecklistItem[] = [];

  if (ctx.federal) {
    items.push({
      id: "sam",
      label: "SAM.gov registration active",
      detail: "Required to receive a federal award.",
      kind: "blocker",
      suggestedDone: p.samRegistered,
    });
  }
  items.push({ id: "deadline", label: "Confirm the response deadline", detail: ctx.deadline ? formatYmdLong(ctx.deadline) : "No deadline on file — verify it on the source.", kind: "todo", suggestedDone: !!ctx.deadline });
  items.push({ id: "docs", label: "Download the solicitation documents", detail: ctx.sourceUrl ?? "No source link on file.", kind: "todo", suggestedDone: false });
  items.push({ id: "statement", label: "Finalize the capability statement", detail: "Review the draft on this page and edit as needed.", kind: "todo", suggestedDone: false });
  items.push({ id: "pricing", label: "Prepare pricing / quote", detail: "Build the line-item pricing the solicitation asks for.", kind: "todo", suggestedDone: false });
  items.push({ id: "coi", label: "Certificate of insurance", detail: hasInsurance ? "Insurance limits on file — request a COI naming the client as additional insured if required." : "No insurance limits in the capability profile yet.", kind: "todo", suggestedDone: hasInsurance });
  items.push({ id: "w9", label: "W-9 on file", kind: "todo", suggestedDone: false });
  if (ctx.setAside) {
    items.push({ id: "setaside", label: `Confirm set-aside eligibility (${ctx.setAside})`, detail: p.certifications.length || p.certificationsOther ? "Check Zoe's certifications match the set-aside." : "No certifications on file to satisfy a set-aside.", kind: "blocker", suggestedDone: false });
  }
  items.push({ id: "portal", label: "Identify the submission method / portal", detail: ctx.sourceUrl ?? "Find where to submit.", kind: "todo", suggestedDone: !!ctx.sourceUrl });
  items.push({ id: "sign", label: "Bid contact reviews and signs", detail: p.bidContactName ? p.bidContactName : "No bid point of contact set in the capability profile.", kind: "todo", suggestedDone: false });
  items.push({ id: "submit", label: "Submit before the deadline (a person does this)", detail: "Zoe never auto-submits. Attach everything and submit yourself.", kind: "todo", suggestedDone: false });
  return items;
}

function buildGaps(p: CapabilityProfile, completeness: number, ctx: { federal: boolean; deadline: string | null; buyer: string | null; sourceUrl: string | null }): string[] {
  const gaps: string[] = [];
  if (completeness < 0.6) gaps.push(`Capability Profile is only ${Math.round(completeness * 100)}% complete. Fill it in at Admin → Capability Profile for a stronger package.`);
  if (ctx.federal && !p.samRegistered) gaps.push("Not registered in SAM.gov, which is required for a federal award.");
  if (!ctx.deadline) gaps.push("No response deadline on file. Verify it on the source before committing.");
  if (!ctx.buyer) gaps.push("No buyer or point of contact identified for this opportunity.");
  if (!ctx.sourceUrl) gaps.push("No source link on file, so the solicitation can't be opened from here.");
  if (!p.bidContactName) gaps.push("No bid point of contact set in the capability profile.");
  return gaps;
}

/** Build the deterministic bid package for one opportunity. Returns null if the opportunity is unknown. */
export function buildBidPackage(opportunityId: string): BidPackage | null {
  const d = opportunityDetail(opportunityId);
  if (!d) return null;
  const p = getCapabilityProfile();
  const completeness = profileCompleteness(p);

  const buyer =
    d.entityMemos.find((m) => m.edge.relationship === "DIRECT_BUYER" || m.edge.relationship === "PROCUREMENT_CONTACT")?.edge.entity.name ??
    d.opp.organization ??
    null;
  const federal = d.opp.jurisdiction === "FEDERAL" || d.opp.kind === "PROCUREMENT";
  const deadline = d.procurement?.responseDeadline ?? d.opp.deadline ?? null;
  const solicitation = d.procurement?.solicitationNumber ?? null;
  const jurisdiction = JURISDICTION_LABEL[d.opp.jurisdiction];
  const cats = d.opp.zoeCategories as string[];

  return {
    opportunityId,
    opportunityName: d.opp.name,
    buyer,
    jurisdictionLabel: jurisdiction,
    deadline,
    sourceUrl: d.opp.sourceUrl,
    solicitationNumber: solicitation,
    capabilityStatement: buildCapabilityStatement(p, { name: d.opp.name, buyer, jurisdiction, cats }),
    responseLetter: buildResponseLetter(p, { name: d.opp.name, buyer, jurisdiction, cats, deadline, solicitation }),
    checklist: buildChecklist(p, { federal, deadline, sourceUrl: d.opp.sourceUrl, setAside: d.procurement?.setAside ?? null }),
    gaps: buildGaps(p, completeness, { federal, deadline, buyer, sourceUrl: d.opp.sourceUrl }),
    narrativeSource: "template",
    profileCompleteness: completeness,
    aiAvailable: llmConfigured(),
  };
}

/** Optionally refine the narrative (statement + response) with the LLM. Facts-only, house voice; on any
 *  failure or when no LLM is configured, returns the deterministic text unchanged. */
export async function refineBidNarrative(pkg: BidPackage): Promise<{ capabilityStatement: string; responseLetter: string; narrativeSource: "template" | "ai"; model?: string }> {
  if (!llmConfigured()) {
    return { capabilityStatement: pkg.capabilityStatement, responseLetter: pkg.responseLetter, narrativeSource: "template" };
  }
  const sys =
    "You refine a government/commercial CAPABILITY STATEMENT and a short RESPONSE LETTER for Zoe Event Rentals (event infrastructure: tents, tables, chairs, staging, flooring, linens) in the DC/MD/VA area. " +
    "Use ONLY the facts in the drafts provided. Never invent a certification, a past project, a dollar amount, a date, a UEI/CAGE/NAICS, a name, or a capability that is not already present. If a section is thin, keep it thin. " +
    "Keep the capability statement's section headings and factual lines intact; improve clarity and flow only. No dashes as punctuation, no emojis, plain and professional. " +
    'Return strict JSON: {"capabilityStatement": string, "responseLetter": string}.';
  const res = await chat([{ role: "user", content: `${sys}\n\nCAPABILITY STATEMENT DRAFT:\n${pkg.capabilityStatement}\n\nRESPONSE LETTER DRAFT:\n${pkg.responseLetter}` }], { json: true, temperature: 0.3, maxTokens: 1400 });
  if (res.ok && res.text) {
    try {
      const parsed = JSON.parse(res.text) as { capabilityStatement?: string; responseLetter?: string };
      if (parsed.capabilityStatement && parsed.responseLetter) {
        return {
          capabilityStatement: parsed.capabilityStatement.trim(),
          responseLetter: humanize(parsed.responseLetter.trim()),
          narrativeSource: "ai",
          model: res.model ?? llmModel(),
        };
      }
    } catch {
      /* fall through to template */
    }
  }
  return { capabilityStatement: pkg.capabilityStatement, responseLetter: pkg.responseLetter, narrativeSource: "template" };
}
