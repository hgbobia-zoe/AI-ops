// Goodshuffle ingestion worker — run this on YOUR server (Docker recommended).
//
// It owns the browser AND the route state. Because this is a single persistent
// process (unlike the Next app on Vercel, which is serverless and stateless), it
// can hold the per-truck route in memory across the tablet's polls. The Next app
// just proxies to the endpoints below.
//
//   POST /ingest   { truckId, date }   → 202 { route:{status:"scraping"} }   (starts scrape, async)
//   GET  /route?truckId=...            → { route } | { route:null }          (poll for status/stops)
//   GET  /health                       → { ok:true }
//   All routes except /health require:  Authorization: Bearer <INGEST_WORKER_SECRET>
//
// Run:  npm run ingest-worker      (needs: npx playwright install chromium)
// Self-test the browser:  npm run ingest-worker -- --selftest

import { createServer, type IncomingMessage } from "node:http";
import { PlaywrightDriver } from "../src/lib/ingest/playwrightDriver";
import { scrapeGoodshuffle } from "../src/lib/ingest/computerUseAgent";
import type { Route } from "../src/lib/types";

const PORT = Number(process.env.INGEST_WORKER_PORT || 8787);
const SECRET = process.env.INGEST_WORKER_SECRET || "";

// Per-truck route store. In-memory is fine for a single worker (routes re-scrape
// on restart). For multiple workers, back this with Redis/SQLite behind the same
// get/set calls.
const routes = new Map<string, Route>();

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Start a scrape for a truck: mark scraping, run async, land on ready/failed. */
function startIngest(truckId: string, date: string): Route {
  const routeId = `R-${date}-${truckId}`;
  const scraping: Route = { routeId, date, truckId, status: "scraping", stops: [] };
  routes.set(truckId, scraping);

  void (async () => {
    const driver = new PlaywrightDriver();
    try {
      await driver.prepare(truckId, date);
      const result = await scrapeGoodshuffle(driver, routeId);
      if (result.ok && result.stops?.length) {
        routes.set(truckId, { routeId, date, truckId, status: "ready", stops: result.stops });
        console.log(`[worker] ready truck=${truckId} stops=${result.stops.length}`);
      } else {
        routes.set(truckId, { routeId, date, truckId, status: "failed", stops: [] });
        console.error(`[worker] failed truck=${truckId}: ${result.error}`);
      }
    } catch (err) {
      routes.set(truckId, { routeId, date, truckId, status: "failed", stops: [] });
      console.error(`[worker] error truck=${truckId}`, err);
    } finally {
      await driver.dispose();
    }
  })();

  return scraping;
}

async function selftest(): Promise<void> {
  console.log("[worker] self-test: launching Chromium…");
  const driver = new PlaywrightDriver();
  try {
    await driver.prepare("SELFTEST", today());
    const shot = await driver.screenshot();
    console.log(`[worker] ✓ Chromium launched and screenshotted ${shot.width}x${shot.height}`);
  } finally {
    await driver.dispose();
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });
}

function authed(req: IncomingMessage): boolean {
  return Boolean(SECRET) && req.headers.authorization === `Bearer ${SECRET}`;
}

async function main() {
  if (process.argv.includes("--selftest")) {
    await selftest();
    return;
  }

  const server = createServer(async (req, res) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const url = new URL(req.url || "/", "http://localhost");

    if (req.method === "GET" && url.pathname === "/health") {
      return send(200, { ok: true });
    }

    if (!authed(req)) return send(401, { error: "unauthorized" });

    if (req.method === "GET" && url.pathname === "/route") {
      const truckId = url.searchParams.get("truckId");
      if (!truckId) return send(400, { error: "missing_truckId" });
      return send(200, { route: routes.get(truckId) ?? null });
    }

    if (req.method === "POST" && url.pathname === "/ingest") {
      let body: { truckId?: string; date?: string };
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return send(400, { error: "invalid_json" });
      }
      if (!body.truckId) return send(400, { error: "missing_truckId" });
      const route = startIngest(body.truckId, body.date || today());
      console.log(`[worker] ingest truck=${body.truckId}`);
      return send(202, { route });
    }

    send(404, { error: "not_found" });
  });

  server.listen(PORT, () => {
    console.log(`[worker] ingestion worker listening on :${PORT}`);
    if (!SECRET) console.warn("[worker] WARNING: INGEST_WORKER_SECRET unset — endpoints are unauthenticated");
  });
}

void main();
