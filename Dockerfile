# Zoe Dispatch — one self-contained container: the Next.js app, the in-process
# Goodshuffle scraper (Playwright/Chromium), and the SQLite DB. Deploy to any
# container host (Fly.io, Railway, a VPS). SQLite lives on a mounted volume at /data.
#
# The Playwright base image ships Chromium + all OS libraries + Node.

FROM mcr.microsoft.com/playwright:v1.62.1-noble

WORKDIR /app
ENV NODE_ENV=production
# Chromium is already in the base image at the matching version — don't re-download.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Build tools so better-sqlite3 can compile its native binding (the base image
# has no compiler, and there's no prebuilt binary for this Node version).
RUN apt-get update && apt-get install -y --no-install-recommends build-essential python3 \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
# npm install (not ci): resolves platform-specific native deps in the Linux
# container. The lockfile is generated on Windows and omits some Linux-only
# optional deps (@emnapi/*), which `npm ci` rejects.
# --include=dev because NODE_ENV=production would otherwise skip devDeps that the
# build needs (@tailwindcss/postcss, typescript, eslint).
RUN npm install --include=dev --no-audit --no-fund

COPY . .
RUN npm run build

ENV PORT=3000
ENV DATABASE_PATH=/data/dispatch.db
EXPOSE 3000

# Env you supply at runtime (see .env.example / DEPLOY.md):
#   ANTHROPIC_API_KEY, GOODSHUFFLE_URL, GOODSHUFFLE_STORAGE_STATE  (route scraping)
#   OPENPHONE_API_KEY, OPENPHONE_FROM                              (customer SMS)
#   SLACK_WEBHOOK_URL                                              (Slack alerts)
#   PUBLIC_BASE_URL, VEHICLES_JSON
CMD ["npm", "run", "start"]
