// Playwright-backed ComputerDriver. This is the "browser Claude drives": a
// headless Chromium bundled with Playwright (NOT the machine's installed Chrome),
// so it runs on a server with no display. Claude's Computer Use tool emits
// actions; these methods perform them and hand back screenshots.
//
// IMPORTANT: only the ingestion worker imports this file — never the Next app —
// so Playwright/Chromium is never bundled into the Vercel deployment.
//
// Auth: log in to Goodshuffle ONCE in a real browser, save the session with
// `playwright ... storageState`, and point GOODSHUFFLE_STORAGE_STATE at that JSON.
// The worker loads it so no credentials live in code or in Claude's prompt.

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { ComputerDriver, Screenshot } from "./types";

const WIDTH = Number(process.env.INGEST_VIEWPORT_W || 1280);
const HEIGHT = Number(process.env.INGEST_VIEWPORT_H || 800);

export class PlaywrightDriver implements ComputerDriver {
  readonly width = WIDTH;
  readonly height = HEIGHT;
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;

  async prepare(truckId: string, date: string): Promise<void> {
    this.browser = await chromium.launch({
      headless: process.env.INGEST_HEADLESS !== "false",
    });
    const storageState = process.env.GOODSHUFFLE_STORAGE_STATE || undefined;
    this.context = await this.browser.newContext({
      viewport: { width: this.width, height: this.height },
      storageState,
    });
    this.page = await this.context.newPage();

    // Navigate to today's dispatch. {truckId}/{date} placeholders let you point
    // GOODSHUFFLE_URL straight at the right view; otherwise the agent navigates.
    const url = (process.env.GOODSHUFFLE_URL || "https://app.goodshuffle.com/")
      .replace("{truckId}", encodeURIComponent(truckId))
      .replace("{date}", encodeURIComponent(date));
    await this.page.goto(url, { waitUntil: "domcontentloaded" });
    await this.page.waitForTimeout(1500);
  }

  private get p(): Page {
    if (!this.page) throw new Error("driver not prepared");
    return this.page;
  }

  async screenshot(): Promise<Screenshot> {
    const buf = await this.p.screenshot({ type: "png" });
    return { base64: buf.toString("base64"), width: this.width, height: this.height };
  }

  async click(x: number, y: number, button: "left" | "right" | "middle" = "left"): Promise<void> {
    await this.p.mouse.click(x, y, { button });
  }

  async moveMouse(x: number, y: number): Promise<void> {
    await this.p.mouse.move(x, y);
  }

  async type(text: string): Promise<void> {
    await this.p.keyboard.type(text);
  }

  async key(combo: string): Promise<void> {
    await this.p.keyboard.press(mapKey(combo));
  }

  async scroll(
    x: number,
    y: number,
    direction: "up" | "down" | "left" | "right",
    amount: number,
  ): Promise<void> {
    await this.p.mouse.move(x, y);
    const step = amount * 100;
    const dx = direction === "left" ? -step : direction === "right" ? step : 0;
    const dy = direction === "up" ? -step : direction === "down" ? step : 0;
    await this.p.mouse.wheel(dx, dy);
  }

  async wait(ms: number): Promise<void> {
    await this.p.waitForTimeout(ms);
  }

  async dispose(): Promise<void> {
    await this.context?.close().catch(() => {});
    await this.browser?.close().catch(() => {});
  }
}

// Translate Anthropic computer-tool key names (X keysyms / xdotool style) to
// Playwright key names.
const KEY_MAP: Record<string, string> = {
  Return: "Enter",
  KP_Enter: "Enter",
  Tab: "Tab",
  Escape: "Escape",
  BackSpace: "Backspace",
  Delete: "Delete",
  space: " ",
  Up: "ArrowUp",
  Down: "ArrowDown",
  Left: "ArrowLeft",
  Right: "ArrowRight",
  Page_Up: "PageUp",
  Page_Down: "PageDown",
  Home: "Home",
  End: "End",
  ctrl: "Control",
  control: "Control",
  alt: "Alt",
  shift: "Shift",
  super: "Meta",
  cmd: "Meta",
};

function mapKey(combo: string): string {
  return combo
    .split("+")
    .map((part) => {
      const k = part.trim();
      return KEY_MAP[k] ?? (k.length === 1 ? k : cap(k));
    })
    .join("+");
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
