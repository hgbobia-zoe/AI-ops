import { describe, it, expect } from "vitest";
import { cardBlocks, cardToText, type BotCard } from "./aiBots";
import {
  slackBlockquote,
  relativeRecency,
  actionItemKindLabel,
  buildActionItemCard,
  type ActionItemCardItem,
} from "./cards";

// Block Kit shape helpers for assertions.
type Block = { type: string; text?: { type: string; text: string }; elements?: { type: string; text: string }[]; fields?: unknown[] };
const blocksOf = (card: BotCard) => cardBlocks(card) as Block[];
const sectionTexts = (bs: Block[]) => bs.filter((b) => b.type === "section" && b.text).map((b) => b.text!.text);

describe("slackBlockquote", () => {
  it("prefixes each line with '> ' and trims; empty → empty", () => {
    expect(slackBlockquote("strike paragraph 24")).toBe("> strike paragraph 24");
    expect(slackBlockquote("line one\nline two")).toBe("> line one\n> line two");
    expect(slackBlockquote("  padded  ")).toBe("> padded");
    expect(slackBlockquote("")).toBe("");
    expect(slackBlockquote("   ")).toBe("");
  });
});

describe("relativeRecency", () => {
  const now = Date.parse("2027-01-01T12:00:00.000Z");
  it("buckets by minutes / hours / days and handles missing/future stamps", () => {
    expect(relativeRecency("2027-01-01T11:59:40.000Z", now)).toBe("just now");
    expect(relativeRecency("2027-01-01T11:45:00.000Z", now)).toBe("15m ago");
    expect(relativeRecency("2027-01-01T09:00:00.000Z", now)).toBe("3h ago");
    expect(relativeRecency("2026-12-30T12:00:00.000Z", now)).toBe("2d ago");
    expect(relativeRecency("2027-01-01T12:30:00.000Z", now)).toBe("just now"); // future/skew
    expect(relativeRecency(null, now)).toBeNull();
    expect(relativeRecency("not-a-date", now)).toBeNull();
  });
});

describe("actionItemKindLabel", () => {
  it("maps known kinds and falls back to 'Open ask'", () => {
    expect(actionItemKindLabel("contract_change")).toBe("Contract change");
    expect(actionItemKindLabel("pricing_question")).toBe("Pricing question");
    expect(actionItemKindLabel("scheduling")).toBe("Scheduling");
    expect(actionItemKindLabel("decision")).toBe("Decision");
    expect(actionItemKindLabel("objection")).toBe("Objection");
    expect(actionItemKindLabel("something-weird")).toBe("Open ask");
  });
});

describe("buildActionItemCard", () => {
  const items: ActionItemCardItem[] = [
    { summary: "Remove paragraph 24 from the T&C", kind: "contract_change", verbatimQuote: "strike paragraph 24 of the T&C" },
    { summary: "Explain the 500 vs 300 lb block", kind: "product_question", verbatimQuote: "difference between a 500 vs 300 lb block" },
  ];
  const now = Date.parse("2027-08-01T12:00:00.000Z");
  const card = buildActionItemCard({
    customer: "Holly Chang",
    project: "Holly wedding",
    projectUrl: "https://pro.goodshuffle.com/app/project/detail?id=SCAN-1",
    items,
    latestInboundAt: "2027-08-01T10:00:00.000Z",
    now,
  });

  it("produces a Viktor-style card: pluralized header, subtitle, one section per ask, closing CTA", () => {
    expect(card.title).toBe("Open customer asks"); // 2 items → plural
    expect(card.subtitle).toContain("Holly Chang");
    expect(card.subtitle).toContain("Holly wedding");
    expect(card.subtitle).toContain("2h ago");
    expect(card.sections).toHaveLength(2);
    expect(card.body).toBe("*Needs a response.*");
    expect(card.link).toEqual({ text: "Open in Goodshuffle", url: "https://pro.goodshuffle.com/app/project/detail?id=SCAN-1" });
    expect(card.context).toContain("no reply was sent");
  });

  it("singular header for one ask", () => {
    const one = buildActionItemCard({ customer: "Pat", project: "Gala", items: [items[0]], now });
    expect(one.title).toBe("Open customer ask");
  });

  it("each section has the bold kind label, the summary, and the verbatim quote as a blockquote", () => {
    const [s1, s2] = card.sections!;
    expect(s1).toContain("*Contract change*");
    expect(s1).toContain("Remove paragraph 24 from the T&C");
    expect(s1).toContain("> strike paragraph 24 of the T&C"); // blockquote = obviously their words
    expect(s2).toContain("*Product question*");
    expect(s2).toContain("> difference between a 500 vs 300 lb block");
  });

  it("emits valid Block Kit: a header, a context subtitle, and one section block per ask with the quote", () => {
    const bs = blocksOf(card);
    expect(bs[0].type).toBe("header");
    expect(bs[0].text!.text).toBe("Open customer asks"); // no emoji (house style)
    // the subtitle is a context block right under the header
    const ctx = bs.find((b) => b.type === "context");
    expect(ctx).toBeTruthy();
    expect(ctx!.elements![0].text).toContain("Holly Chang");
    // one section block per ask, each carrying the kind label + the blockquoted verbatim quote
    const secs = sectionTexts(bs);
    expect(secs.some((t) => t.includes("*Contract change*") && t.includes("> strike paragraph 24 of the T&C"))).toBe(true);
    expect(secs.some((t) => t.includes("*Product question*") && t.includes("> difference between a 500 vs 300 lb block"))).toBe(true);
    // the closing CTA renders as its own section
    expect(secs.some((t) => t === "*Needs a response.*")).toBe(true);
  });

  it("the text fallback carries the header, both asks, their quotes, and the CTA", () => {
    const text = cardToText(card);
    expect(text).toContain("Open customer asks");
    expect(text).toContain("Holly Chang");
    expect(text).toContain("Contract change");
    expect(text).toContain("> strike paragraph 24 of the T&C");
    expect(text).toContain("difference between a 500 vs 300 lb block");
    expect(text).toContain("Needs a response.");
    expect(text).toContain("Open in Goodshuffle");
  });

  it("drops the link button when no URL is available", () => {
    const noUrl = buildActionItemCard({ customer: "Pat", project: "Gala", projectUrl: null, items: [items[0]], now });
    const actions = (cardBlocks(noUrl) as Block[]).find((b) => b.type === "actions");
    expect(actions).toBeUndefined();
  });
});

describe("cardBlocks / cardToText back-compat", () => {
  it("a body-only card (no subtitle/sections) still renders header + divider + body, as before", () => {
    const card: BotCard = { title: "Online signing cutoff: Gala", body: "entered the window", link: { text: "Open", url: "https://x" } };
    const bs = blocksOf(card);
    expect(bs[0].type).toBe("header");
    expect(bs[1].type).toBe("divider");
    expect(sectionTexts(bs)).toContain("entered the window");
    expect(bs.find((b) => b.type === "context")).toBeUndefined(); // no subtitle, no footer → no context block
    expect(cardToText(card)).toContain("Online signing cutoff: Gala");
    expect(cardToText(card)).toContain("entered the window");
  });

  it("sections render before body; both appear", () => {
    const card: BotCard = { title: "T", sections: ["first", "second"], body: "closing" };
    const secs = sectionTexts(blocksOf(card));
    expect(secs).toEqual(["first", "second", "closing"]);
  });
});
