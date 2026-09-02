// Quote review — the AI Event Risk layer over a Goodshuffle quote.
//
// Two tiers, cheapest first:
//   1) Deterministic rules (free, instant, reliable): crew size from line items (tents),
//      and other checks we can encode. These ALWAYS run.
//   2) An LLM pass (optional) for the fuzzy judgment a rule can't capture — missing
//      complementary items, delivery/venue logistics, unusual scale. Runs only when an
//      LLM is configured (point it at a LOCAL model to keep this ~free). Falls back to
//      tier 1 silently if the model is down.

import { crewForItems, type LineItem } from "./crewRules";
import { chat, llmConfigured } from "./llm";

export interface Quote {
  eventName?: string;
  eventDate?: string;
  venue?: string;
  items: LineItem[];
}

export interface QuoteReview {
  // Tier 1 — deterministic.
  crew: number;
  crewReasons: string[];
  hasTent: boolean;
  // Tier 2 — optional LLM.
  llm: { risks: string[]; notes: string } | null;
  llmError?: string;
  llmModel?: string;
}

const SYSTEM =
  "You review event-rental quotes for an operations team. Given the event and its line " +
  "items, flag concrete logistics or staffing risks the crew should know before the job: " +
  "missing complementary items (e.g. a tent with no sidewalls/lighting/flooring when the " +
  "scale implies it), access/setup concerns, or unusual scale. Do NOT restate the crew " +
  "count — that's computed separately. Be terse and specific. Respond ONLY as JSON: " +
  '{"risks": string[], "notes": string}. Empty risks array if nothing stands out.';

export async function reviewQuote(q: Quote): Promise<QuoteReview> {
  const need = crewForItems(q.items);
  const base = { crew: need.crew, crewReasons: need.reasons, hasTent: need.hasTent };

  if (!llmConfigured()) return { ...base, llm: null };

  const user = JSON.stringify({
    eventName: q.eventName,
    eventDate: q.eventDate,
    venue: q.venue,
    items: q.items.map((i) => ({ name: i.name, qty: i.quantity })),
    computedCrew: need.crew,
  });

  const r = await chat(
    [
      { role: "system", content: SYSTEM },
      { role: "user", content: user },
    ],
    { json: true, timeoutMs: 45000 },
  );

  if (!r.ok || !r.text) return { ...base, llm: null, llmError: r.error };
  try {
    const parsed = JSON.parse(r.text) as { risks?: unknown; notes?: unknown };
    return {
      ...base,
      llm: {
        risks: Array.isArray(parsed.risks) ? parsed.risks.map(String) : [],
        notes: typeof parsed.notes === "string" ? parsed.notes : "",
      },
      llmModel: r.model,
    };
  } catch {
    return { ...base, llm: null, llmError: "model did not return valid JSON" };
  }
}
