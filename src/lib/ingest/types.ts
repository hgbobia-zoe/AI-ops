// Route ingestion — types shared by the orchestrator, the Computer Use agent,
// and the pluggable browser drivers.
//
// Goodshuffle Pro has no API, so "Start Route" scrapes it with an Anthropic
// Computer Use agent (claude-opus-5 by default): Claude looks at a screenshot,
// decides the next click/type, our driver performs it, and the loop repeats
// until Claude calls submit_route with the structured route. The driver is
// pluggable so the same agent runs against a mock (local dev), a hosted browser
// (Browserbase/Anthropic container in prod), or a headless Playwright instance.

import type { Route, Stop } from "@/lib/types";

/** A screenshot the agent reasons over. Base64 PNG + pixel dimensions. */
export interface Screenshot {
  base64: string;
  width: number;
  height: number;
}

/**
 * The surface Claude's computer tool acts on. Any of these may be driven by a
 * real headless browser, a hosted browser API, or a mock. Coordinates are in
 * screenshot pixels (the computer tool works in pixel space).
 */
export interface ComputerDriver {
  readonly width: number;
  readonly height: number;
  screenshot(): Promise<Screenshot>;
  click(x: number, y: number, button?: "left" | "right" | "middle"): Promise<void>;
  type(text: string): Promise<void>;
  key(combo: string): Promise<void>;
  scroll(x: number, y: number, direction: "up" | "down" | "left" | "right", amount: number): Promise<void>;
  moveMouse(x: number, y: number): Promise<void>;
  wait(ms: number): Promise<void>;
  /** Log into Goodshuffle and navigate to today's dispatch for a truck. */
  prepare(truckId: string, date: string): Promise<void>;
  dispose?(): Promise<void>;
}

export interface IngestResult {
  ok: boolean;
  route?: Route;
  error?: string;
  /** Structured stops the agent extracted, before assembly into a Route. */
  stops?: Stop[];
  /** Rough count of agent turns — useful for cost/monitoring. */
  turns?: number;
}
