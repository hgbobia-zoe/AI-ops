// Route ingestion — runs in-process (the app self-hosts on a Node server with
// Chromium available, so no separate worker). "Start Route" marks the route
// `scraping` in the DB, runs the scrape in the background, then writes the stops
// and flips to `ready` (or `failed`).
//
// Strategy: real Anthropic Computer Use + Playwright when ANTHROPIC_API_KEY is set;
// otherwise the mock route (local dev). The tablet polls /api/route for status.

import type { Route } from "@/lib/types";
import { mockRoute } from "@/lib/mockData";
import { writeRoute, setRouteStatus } from "@/lib/db/repo";
import { alertOps } from "@/lib/notify/alert";
import { todayInOpsTz } from "@/lib/dates";
import { PlaywrightDriver } from "./playwrightDriver";
import { scrapeGoodshuffle } from "./computerUseAgent";

const today = todayInOpsTz;

function realScraperEnabled(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY) && process.env.INGEST_MODE !== "mock";
}

/** Kick off ingestion: mark scraping, scrape in the background, land ready/failed. */
export function startIngestion(truckId: string, date = today()): Route {
  const routeId = `R-${date}-${truckId}`;
  const scraping: Route = { routeId, date, truckId, status: "scraping", stops: [] };
  writeRoute(scraping);
  void runIngest(truckId, date, routeId);
  return scraping;
}

async function runIngest(truckId: string, date: string, routeId: string): Promise<void> {
  try {
    // Manual mode: Goodshuffle is behind Cloudflare (no automated scrape), so skip
    // straight to the manual-entry / route-import flow instead of a doomed scrape.
    if (process.env.INGEST_MODE === "manual") {
      setRouteStatus(routeId, "failed");
      return;
    }
    if (!realScraperEnabled()) {
      await new Promise((r) => setTimeout(r, 1500));
      writeRoute({ ...mockRoute(truckId, date), status: "ready" });
      return;
    }

    const driver = new PlaywrightDriver();
    try {
      await driver.prepare(truckId, date);
      const result = await scrapeGoodshuffle(driver, routeId);
      if (result.ok && result.stops?.length) {
        writeRoute({ routeId, date, truckId, status: "ready", stops: result.stops });
        console.log(`[ingest] ready truck=${truckId} stops=${result.stops.length}`);
      } else {
        console.error(`[ingest] scrape failed truck=${truckId}: ${result.error}`);
        setRouteStatus(routeId, "failed");
        void alertOps("Route scrape (Goodshuffle)", `truck ${truckId}: ${result.error ?? "no stops returned"} — use manual entry`);
      }
    } finally {
      await driver.dispose();
    }
  } catch (err) {
    console.error(`[ingest] error truck=${truckId}`, err);
    setRouteStatus(routeId, "failed");
    void alertOps("Route scrape (Goodshuffle)", `truck ${truckId}: ${String(err)} — use manual entry`);
  }
}
