// Ingestion orchestrator. "Start Route" calls startIngestion(), which flips the
// route to `scraping`, runs the configured strategy in the background, and lands
// on `ready` (stops loaded) or `failed` (→ manual entry fallback on the tablet).
//
// Strategies:
//   - "mock" (default): returns the sample route after a short delay. No API key,
//     no browser — exercises the whole Start Route lifecycle locally.
//   - "computer-use": the real Anthropic Computer Use agent against a browser
//     driver. Enabled with INGEST_STRATEGY=computer-use + ANTHROPIC_API_KEY + a
//     configured driver (see driver TODO below).

import type { Route } from "@/lib/types";
import { mockRoute } from "@/lib/mockData";
import { setRoute, setStatus } from "./routeStore";
import { scrapeGoodshuffle } from "./computerUseAgent";
import type { ComputerDriver } from "./types";

function strategy(): "mock" | "computer-use" {
  return process.env.INGEST_STRATEGY === "computer-use" ? "computer-use" : "mock";
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Kicks off ingestion for a truck. Returns immediately with a `scraping` route;
 * the tablet polls /api/route until it flips to `ready` or `failed`. Never throws
 * to the caller — failures land as status `failed`.
 */
export function startIngestion(truckId: string, date = today()): Route {
  const routeId = `R-${date}-${truckId}`;
  const scraping: Route = {
    routeId,
    date,
    truckId,
    status: "scraping",
    stops: [],
  };
  setRoute(scraping);

  // Fire-and-forget; the tablet learns the result by polling status.
  void runIngestion(truckId, date, routeId);
  return scraping;
}

async function runIngestion(truckId: string, date: string, routeId: string): Promise<void> {
  try {
    if (strategy() === "mock") {
      // Simulate the scrape latency so the "Loading route…" state is real.
      await new Promise((r) => setTimeout(r, 1500));
      const route = mockRoute(truckId, date);
      setRoute({ ...route, status: "ready" });
      return;
    }

    // computer-use strategy
    const driver = await makeDriver();
    if (!driver) {
      setStatus(truckId, "failed");
      return;
    }
    try {
      const result = await scrapeGoodshuffle(driver, routeId);
      if (result.ok && result.stops?.length) {
        setRoute({ routeId, date, truckId, status: "ready", stops: result.stops });
      } else {
        console.error("[ingest] scrape failed:", result.error);
        setStatus(truckId, "failed");
      }
    } finally {
      await driver.dispose?.();
    }
  } catch (err) {
    console.error("[ingest] unexpected error:", err);
    setStatus(truckId, "failed");
  }
}

/**
 * Build the production browser driver. TODO(M2 hosting): implement against a
 * hosted browser — an Anthropic Computer Use container, Browserbase, or a
 * headless Playwright instance — that logs into Goodshuffle with credentials
 * from the server secret store (never the client). Returning null makes the
 * computer-use strategy fail cleanly into the manual-entry fallback. The real
 * implementation logs into Goodshuffle for the truck/date being ingested.
 */
async function makeDriver(): Promise<ComputerDriver | null> {
  return null;
}
