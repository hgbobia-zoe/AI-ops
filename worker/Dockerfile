# Goodshuffle ingestion worker — deploy this to your own server.
# The Playwright base image ships Chromium + all OS deps, so no display needed.
FROM mcr.microsoft.com/playwright:v1.62.1-noble

WORKDIR /app

# Install deps (needs the repo's package.json + lockfile at build context root).
COPY package.json package-lock.json ./
RUN npm ci

# App source (the worker imports src/lib/ingest/*).
COPY tsconfig.json ./
COPY src ./src
COPY worker ./worker

ENV INGEST_WORKER_PORT=8787
EXPOSE 8787

# Env you must supply at runtime:
#   ANTHROPIC_API_KEY           (Computer Use)
#   INGEST_WORKER_SECRET        (shared with the Next app)
#   GOODSHUFFLE_URL             (dispatch URL; supports {truckId}/{date})
#   GOODSHUFFLE_STORAGE_STATE   (path to a saved Playwright storageState.json)
CMD ["npm", "run", "ingest-worker"]
