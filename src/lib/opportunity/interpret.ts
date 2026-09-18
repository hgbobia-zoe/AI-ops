// Opportunity Radar — AI INTERPRETATION layer (§3/§17). The deterministic engines always run for free;
// this only *interprets* — a plain-language summary, why it's relevant, and concrete research actions.
// It NEVER fabricates facts or changes a score. A deterministic template floor is always produced; the
// LLM refines it when configured, and the result is cached (opportunity_ai) so we don't re-bill. Every
// result is labelled method: "llm" | "template" for honesty.

import { getDb } from "@/lib/db";
import { chat, llmConfigured, llmModel } from "@/lib/llm";
import { singleView } from "./service";
import { CATEGORY_ANALOG, describeUnknowns } from "./research";
import { JURISDICTION_LABEL, KIND_LABEL, MATURITY_LABEL, ZOE_CATEGORY_LABEL } from "./types";

export interface OppSummary {
  summary: string;
  whyRelevant: string;
  researchActions: string[];
  method: "llm" | "template";
  model?: string;
}

function cacheGet(id: string, kind: string): { content: string; method: string; model: string | null } | null {
  return (getDb().prepare("SELECT content, method, model FROM opportunity_ai WHERE id = ?").get(`${id}:${kind}`) as { content: string; method: string; model: string | null } | undefined) ?? null;
}
function cacheSet(id: string, kind: string, content: unknown, method: string, model: string | null, now: Date): void {
  getDb().prepare("INSERT OR REPLACE INTO opportunity_ai (id, opportunity_id, kind, content, method, model, created_at) VALUES (?,?,?,?,?,?,?)")
    .run(`${id}:${kind}`, id, kind, JSON.stringify(content), method, model, now.toISOString());
}

/** Read a cached interpretation WITHOUT generating (so a page load never triggers the LLM). */
export function getCachedInterpretation(id: string): OppSummary | null {
  const cached = cacheGet(id, "summary");
  if (!cached) return null;
  return { ...(JSON.parse(cached.content) as Omit<OppSummary, "method" | "model">), method: cached.method as "llm" | "template", model: cached.model ?? undefined };
}

/** Deterministic summary from the derived view — always available, never wrong. */
function templateSummary(id: string): OppSummary | null {
  const v = singleView(id);
  if (!v) return null;
  const e = v.opp;
  const cats = e.zoeCategories.length ? e.zoeCategories.map((c) => ZOE_CATEGORY_LABEL[c]).join(", ") : CATEGORY_ANALOG[e.kind];
  const summary = `${KIND_LABEL[e.kind]} in ${JURISDICTION_LABEL[e.jurisdiction]}${e.organization ? ` (${e.organization})` : ""}. ${MATURITY_LABEL[v.maturity.maturity]}: ${v.maturity.headline}. Likely Zoe needs: ${cats}.`;
  const why = v.score.positives.slice(0, 4).map((p) => p.label).join("; ") || "relevance not yet established";
  return { summary, whyRelevant: why, researchActions: describeUnknowns(v), method: "template" };
}

/** Interpret one opportunity: cached → template → optional LLM refine. force re-generates. */
export async function interpretOpportunity(id: string, opts: { force?: boolean } = {}, now: Date = new Date()): Promise<OppSummary | null> {
  if (!opts.force) {
    const cached = cacheGet(id, "summary");
    if (cached) return { ...(JSON.parse(cached.content) as Omit<OppSummary, "method" | "model">), method: cached.method as "llm" | "template", model: cached.model ?? undefined };
  }
  const floor = templateSummary(id);
  if (!floor) return null;

  if (!llmConfigured()) {
    cacheSet(id, "summary", { summary: floor.summary, whyRelevant: floor.whyRelevant, researchActions: floor.researchActions }, "template", null, now);
    return floor;
  }

  const v = singleView(id)!;
  const facts = {
    name: v.opp.name, type: KIND_LABEL[v.opp.kind], jurisdiction: JURISDICTION_LABEL[v.opp.jurisdiction],
    organization: v.opp.organization, date: v.opp.estimatedDate, deadline: v.opp.deadline,
    zoeCategories: v.opp.zoeCategories, description: v.opp.description, positives: v.score.positives.map((p) => p.label),
    unknowns: v.score.unknowns.map((u) => u.label),
  };
  const sys = "You interpret a business opportunity for an event-rental company (tents, tables, chairs, staging, flooring, linens) in the DC/Maryland/Virginia area. Use ONLY the facts given. Never invent contacts, dates, dollar amounts, or requirements. If something is unknown, say it is unknown. Return strict JSON: {\"summary\": string (<=40 words, plain), \"whyRelevant\": string (<=30 words), \"researchActions\": string[] (2-4 concrete next steps to qualify it)}.";
  const res = await chat([{ role: "user", content: `${sys}\n\nFACTS:\n${JSON.stringify(facts, null, 2)}` }], { json: true, temperature: 0.3, maxTokens: 500 });
  if (res.ok && res.text) {
    try {
      const parsed = JSON.parse(res.text) as { summary?: string; whyRelevant?: string; researchActions?: string[] };
      const out: OppSummary = {
        summary: (parsed.summary ?? floor.summary).trim(),
        whyRelevant: (parsed.whyRelevant ?? floor.whyRelevant).trim(),
        researchActions: Array.isArray(parsed.researchActions) && parsed.researchActions.length ? parsed.researchActions.slice(0, 4) : floor.researchActions,
        method: "llm",
        model: res.model ?? llmModel(),
      };
      cacheSet(id, "summary", { summary: out.summary, whyRelevant: out.whyRelevant, researchActions: out.researchActions }, "llm", out.model ?? null, now);
      return out;
    } catch { /* fall through to template */ }
  }
  cacheSet(id, "summary", { summary: floor.summary, whyRelevant: floor.whyRelevant, researchActions: floor.researchActions }, "template", null, now);
  return floor;
}
