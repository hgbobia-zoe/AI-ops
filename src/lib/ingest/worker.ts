// Helper for talking to the ingestion worker (the persistent server that owns
// the browser and the route state). When INGEST_WORKER_URL is set, the Next app
// is stateless and proxies route reads/writes to the worker — which is what makes
// the app safe on Vercel's serverless (no shared in-memory state needed).

export function workerBase(): string | null {
  const u = process.env.INGEST_WORKER_URL;
  return u ? u.replace(/\/$/, "") : null;
}

export function workerHeaders(): Record<string, string> {
  const s = process.env.INGEST_WORKER_SECRET;
  return s ? { authorization: `Bearer ${s}` } : {};
}
