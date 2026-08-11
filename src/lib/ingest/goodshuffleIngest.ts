// Local (mock) ingestion for dev and demos — used only when no ingestion worker
// is configured (INGEST_WORKER_URL unset). Returns the sample route after a short
// delay so the Start Route → "Loading route…" → ready lifecycle is exercisable
// without a browser or API key. In production the worker does the real scrape and
// owns route state; see src/app/api/ingest-route + worker/.

import type { Route } from "@/lib/types";
import { mockRoute } from "@/lib/mockData";
import { setRoute } from "./routeStore";

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Kick off a mock scrape: mark scraping, then land on ready after ~1.5s. */
export function startIngestion(truckId: string, date = today()): Route {
  const routeId = `R-${date}-${truckId}`;
  const scraping: Route = { routeId, date, truckId, status: "scraping", stops: [] };
  setRoute(scraping);

  void (async () => {
    await new Promise((r) => setTimeout(r, 1500));
    setRoute({ ...mockRoute(truckId, date), status: "ready" });
  })();

  return scraping;
}
