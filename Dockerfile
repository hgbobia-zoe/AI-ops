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

COPY package.json package-lock.json ./
RUN npm ci

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
