// Anthropic Computer Use agent that scrapes today's Goodshuffle route.
//
// Loop: send Claude the current screenshot → Claude emits a computer action or
// calls submit_route → we execute the action against the ComputerDriver and
// return the new screenshot → repeat until submit_route or the turn cap.
//
// This is the production "AI browsing" path. It is guarded: it only runs when
// ANTHROPIC_API_KEY is set and a real driver is supplied. Locally, the mock
// ingestion strategy bypasses it entirely (see goodshuffleIngest.ts).

import Anthropic from "@anthropic-ai/sdk";
import type { ComputerDriver, IngestResult } from "./types";
import type { Stop } from "@/lib/types";
import { normalizePhone } from "./dayOfContact";

const MODEL = process.env.INGEST_MODEL || "claude-opus-5";
const MAX_TURNS = Number(process.env.INGEST_MAX_TURNS || 40);

// Custom tool Claude calls once it has read the whole route. Its input is the
// structured result — no screen scraping of our own required.
const SUBMIT_ROUTE_TOOL = {
  name: "submit_route",
  description:
    "Call this once when you have read every stop of today's route from Goodshuffle. Provide the stops in the exact order shown.",
  input_schema: {
    type: "object" as const,
    properties: {
      stops: {
        type: "array",
        items: {
          type: "object",
          properties: {
            sequence: { type: "integer", description: "1-based stop order" },
            custName: { type: "string" },
            custPhone: { type: "string" },
            address: { type: "string" },
            dayOfName: {
              type: "string",
              description:
                "Name of the day-of coordinator / 'Day of Contact', if the stop lists one. Omit if none.",
            },
            dayOfPhone: {
              type: "string",
              description: "Phone of the day-of coordinator, if listed. Omit if none.",
            },
            plannedWindow: { type: "string", description: "delivery time window" },
            eta: { type: "string" },
          },
          required: ["sequence", "custName", "address"],
        },
      },
    },
    required: ["stops"],
  },
};

interface SubmittedStop {
  sequence: number;
  custName: string;
  custPhone?: string;
  address: string;
  dayOfName?: string;
  dayOfPhone?: string;
  plannedWindow?: string;
  eta?: string;
}

/** Run the Computer Use loop and return the extracted stops. */
export async function scrapeGoodshuffle(
  driver: ComputerDriver,
  routeId: string,
): Promise<IngestResult> {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { ok: false, error: "ANTHROPIC_API_KEY not set" };
  }

  const client = new Anthropic();
  const computerTool = {
    type: "computer_20251124" as const,
    name: "computer",
    display_width_px: driver.width,
    display_height_px: driver.height,
  };

  const system =
    "You are reading a delivery dispatch route from the Goodshuffle Pro web app. " +
    "Scroll through today's route for the selected truck, read every stop in order " +
    "(customer name, address, phone, time window, ETA, and whether it is a Delivery, " +
    "Pickup, or Warehouse stop). If a stop lists a day-of coordinator / 'Day of Contact' " +
    "(a name and/or phone), include it as dayOfName/dayOfPhone; omit when absent. Then " +
    "call submit_route with all stops. Do not modify anything in Goodshuffle — only read.";

  // Seed the conversation with the first screenshot.
  const first = await driver.screenshot();
  // Using loose typing: the beta computer-tool content shapes aren't fully in
  // the SDK's exported param types yet.
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    {
      role: "user",
      content: [
        { type: "text", text: "Here is the current screen. Begin reading the route." },
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: first.base64 },
        },
      ] as unknown as Anthropic.Beta.BetaContentBlockParam[],
    },
  ];

  let turns = 0;
  while (turns < MAX_TURNS) {
    turns++;
    const res = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 4096,
      betas: ["computer-use-2025-11-24"],
      system,
      // Beta computer-tool param types lag the SDK; cast to the create() param shape.
      tools: [computerTool, SUBMIT_ROUTE_TOOL] as never,
      messages,
    });

    messages.push({ role: "assistant", content: res.content });

    if (res.stop_reason !== "tool_use") {
      return { ok: false, error: `agent stopped: ${res.stop_reason}`, turns };
    }

    const toolResults: Anthropic.Beta.BetaContentBlockParam[] = [];
    for (const block of res.content) {
      if (block.type !== "tool_use") continue;

      if (block.name === "submit_route") {
        const stops = assembleStops(
          (block.input as { stops: SubmittedStop[] }).stops,
          routeId,
        );
        return { ok: true, stops, turns };
      }

      // computer action → drive the browser, return a fresh screenshot
      const shot = await runComputerAction(driver, block.input as ComputerAction);
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: shot
          ? [{ type: "image", source: { type: "base64", media_type: "image/png", data: shot.base64 } }]
          : [{ type: "text", text: "done" }],
      } as unknown as Anthropic.Beta.BetaContentBlockParam);
    }

    messages.push({ role: "user", content: toolResults });
  }

  return { ok: false, error: `hit turn cap (${MAX_TURNS})`, turns };
}

interface ComputerAction {
  action: string;
  coordinate?: [number, number];
  text?: string;
  scroll_direction?: "up" | "down" | "left" | "right";
  scroll_amount?: number;
  duration?: number;
}

async function runComputerAction(driver: ComputerDriver, a: ComputerAction) {
  const [x, y] = a.coordinate ?? [0, 0];
  switch (a.action) {
    case "screenshot":
      return driver.screenshot();
    case "left_click":
      await driver.click(x, y, "left");
      return driver.screenshot();
    case "right_click":
      await driver.click(x, y, "right");
      return driver.screenshot();
    case "mouse_move":
      await driver.moveMouse(x, y);
      return driver.screenshot();
    case "type":
      await driver.type(a.text ?? "");
      return driver.screenshot();
    case "key":
      await driver.key(a.text ?? "");
      return driver.screenshot();
    case "scroll":
      await driver.scroll(x, y, a.scroll_direction ?? "down", a.scroll_amount ?? 3);
      return driver.screenshot();
    case "wait":
      await driver.wait((a.duration ?? 1) * 1000);
      return driver.screenshot();
    default:
      return driver.screenshot();
  }
}

function assembleStops(submitted: SubmittedStop[], routeId: string): Stop[] {
  return submitted
    .slice()
    .sort((a, b) => a.sequence - b.sequence)
    .map((s, i) => ({
      // Route-scope the id: stop_id is a global PK, so a bare `S-1` would collide
      // across trucks/routes in the shared DB.
      stopId: `${routeId}-S${i + 1}`,
      routeId,
      customerId: `${routeId}-C${i + 1}`,
      sequence: s.sequence ?? i + 1,
      state: "Waiting" as const,
      custName: s.custName,
      custPhone: s.custPhone ?? "",
      address: s.address,
      dayOfName: s.dayOfName || undefined,
      dayOfPhone: s.dayOfPhone ? normalizePhone(s.dayOfPhone) : undefined,
      plannedWindow: s.plannedWindow,
      eta: s.eta,
    }));
}
