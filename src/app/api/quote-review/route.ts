// Quote review — deterministic crew rules + (if a model is configured) an LLM risk pass.
// POST { items:[{name,quantity?}], eventName?, eventDate?, venue? } → QuoteReview.

import { NextResponse } from "next/server";
import { reviewQuote } from "@/lib/quoteReview";
import type { LineItem } from "@/lib/crewRules";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  let body: { items?: unknown; eventName?: string; eventDate?: string; venue?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const items: LineItem[] = Array.isArray(body.items)
    ? body.items
        .map((i) => {
          const o = (i ?? {}) as { name?: unknown; quantity?: unknown };
          return { name: String(o.name ?? "").trim(), quantity: typeof o.quantity === "number" ? o.quantity : undefined };
        })
        .filter((i) => i.name)
    : [];
  if (items.length === 0) return NextResponse.json({ error: "items[] required" }, { status: 400 });

  const review = await reviewQuote({
    items,
    eventName: body.eventName,
    eventDate: body.eventDate,
    venue: body.venue,
  });
  return NextResponse.json(review);
}
