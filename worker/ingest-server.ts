// Goodshuffle ingestion worker — run this on YOUR server (Docker recommended).
//
// It owns the browser: a headless Chromium (Playwright) that Claude's Computer
// Use tool drives to read today's route from Goodshuffle. The Next app (on
// Vercel) never runs a browser — it just calls this worker over HTTP.
//
//   POST /ingest   { truckId, date }   Authorization: Bearer <INGEST_WORKER_SECRET>
//     → { ok: true, stops: [...] }  or  { ok: false, error }
//   GET  /health                        → { ok: true }
//
// Run:  npm run ingest-worker      (needs: npx playwright install chromium)
// Self-test the browser without Claude/Goodshuffle:
//        npm run ingest-worker -- --selftest      (screenshots GOODSHUFFLE_URL)

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { PlaywrightDriver } from "../src/lib/ingest/playwrightDriver";
import { scrapeGoodshuffle } from "../src/lib/ingest/computerUseAgent";

const PORT = Number(process.env.INGEST_WORKER_PORT || 8787);
const SECRET = process.env.INGEST_WORKER_SECRET || "";

async function selftest(): Promise<void> {
  console.log("[worker] self-test: launching Chromium…");
  const driver = new PlaywrightDriver();
  try {
    await driver.prepare("SELFTEST", new Date().toISOString().slice(0, 10));
    const shot = await driver.screenshot();
    console.log(
      `[worker] ✓ Chromium launched and screenshotted ${shot.width}x${shot.height} ` +
        `(${Math.round((shot.base64.length * 3) / 4 / 1024)} KB PNG)`,
    );
  } finally {
    await driver.dispose();
  }
}

async function ingest(truckId: string, date: string) {
  const routeId = `R-${date}-${truckId}`;
  const driver = new PlaywrightDriver();
  try {
    await driver.prepare(truckId, date);
    return await scrapeGoodshuffle(driver, routeId);
  } finally {
    await driver.dispose();
  }
}

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });
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

    if (req.method === "GET" && req.url === "/health") {
      return send(200, { ok: true });
    }

    if (req.method === "POST" && req.url === "/ingest") {
      if (!SECRET || req.headers.authorization !== `Bearer ${SECRET}`) {
        return send(401, { ok: false, error: "unauthorized" });
      }
      let body: { truckId?: string; date?: string };
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return send(400, { ok: false, error: "invalid_json" });
      }
      if (!body.truckId) return send(400, { ok: false, error: "missing_truckId" });
      const date = body.date || new Date().toISOString().slice(0, 10);
      const id = randomUUID().slice(0, 8);
      console.log(`[worker] [${id}] ingest truck=${body.truckId} date=${date}`);
      try {
        const result = await ingest(body.truckId, date);
        console.log(`[worker] [${id}] done ok=${result.ok} stops=${result.stops?.length ?? 0}`);
        return send(result.ok ? 200 : 502, result);
      } catch (err) {
        console.error(`[worker] [${id}] error`, err);
        return send(500, { ok: false, error: String(err) });
      }
    }

    send(404, { ok: false, error: "not_found" });
  });

  server.listen(PORT, () => {
    console.log(`[worker] ingestion worker listening on :${PORT}`);
    if (!SECRET) console.warn("[worker] WARNING: INGEST_WORKER_SECRET unset — /ingest is unauthenticated");
  });
}

void main();
