# Goodshuffle cloud puller — a dedicated headless-Chromium worker (Increment 2 of the cloud runtime).
# It runs the SAME Playwright runner used on the office machine (scripts/zoe-pull/run.mts), but headless,
# in a loop, routed through a RESIDENTIAL PROXY so Goodshuffle's Cloudflare sees a residential IP instead
# of Fly's datacenter IP. Separate from the main app image (which stays lean — no Chromium).
#
# The Playwright base image bundles Chromium + all system deps at a pinned version; keep it in sync with
# the "playwright" version in package.json (currently ^1.62.1).

FROM mcr.microsoft.com/playwright:v1.62.1-jammy

WORKDIR /app

# Install deps (playwright + tsx are in package.json). Browsers come from the base image.
COPY package.json package-lock.json ./
RUN npm ci

# Only what the runner needs: the pull-script builder (src/lib/gsPull.ts) + the runner + tsconfig.
COPY tsconfig*.json ./
COPY src ./src
COPY scripts ./scripts

# Headless, loop forever, use the base image's bundled Chromium (no "chrome" channel in the container),
# and keep the logged-in profile on a mounted volume so the Goodshuffle session survives restarts.
ENV ZOE_HEADLESS=1 \
    ZOE_WATCH=1 \
    ZOE_CHANNEL=chromium \
    ZOE_PROFILE=/profile \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

CMD ["npx", "tsx", "scripts/zoe-pull/run.mts"]
