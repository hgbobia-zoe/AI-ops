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

import type { Route, Stop } from "@/lib/types";
import { mockRoute } from "@/lib/mockData";
import { setRoute, setStatus } from "./routeStore";

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

    // computer-use strategy → delegate to the ingestion worker (the server that
    // owns the browser). Playwright/Chromium never runs inside the Next app.
    const workerUrl = process.env.INGEST_WORKER_URL;
    if (!workerUrl) {
      console.error("[ingest] INGEST_WORKER_URL not set — cannot scrape");
      setStatus(truckId, "failed");
      return;
    }
    const res = await fetch(`${workerUrl.replace(/\/$/, "")}/ingest`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(process.env.INGEST_WORKER_SECRET
          ? { authorization: `Bearer ${process.env.INGEST_WORKER_SECRET}` }
          : {}),
      },
      body: JSON.stringify({ truckId, date }),
    });
    const result = (await res.json()) as {
      ok: boolean;
      stops?: Stop[];
      error?: string;
    };
    if (res.ok && result.ok && result.stops?.length) {
      setRoute({ routeId, date, truckId, status: "ready", stops: result.stops });
    } else {
      console.error("[ingest] worker scrape failed:", result.error);
      setStatus(truckId, "failed");
    }
  } catch (err) {
    console.error("[ingest] unexpected error:", err);
    setStatus(truckId, "failed");
  }
}
