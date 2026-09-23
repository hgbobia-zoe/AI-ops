# Zoe Auto-Pull + Opportunity Radar — Chrome extension

Two jobs, one extension (install on the **office machine** that stays logged into Goodshuffle):

1. **Goodshuffle auto-pull** — on a timer, pulls routes/bookings/revenue from a logged-in
   `pro.goodshuffle.com` tab and drains write-backs. No clicking.
2. **Opportunity Radar capture** — on demand, scrapes a government procurement portal's solicitation
   list and sends the rows into Opportunity Radar (`/api/radar/ingest`).

## Install (unpacked)

1. Unzip anywhere.
2. Chrome → `chrome://extensions` → toggle **Developer mode** (top right).
3. **Load unpacked** → pick this folder.
4. Click the extension → **Settings**:
   - **Zoe Ops URL** — your deployment (default `https://zoe-dispatch.fly.dev`).
   - **Opportunity Radar ingest token** — only if `RADAR_INGEST_TOKEN` is set on the server (leave blank otherwise).

## Auto-pull: how it works + staying healthy

As of **v1.2.0** the auto-pull runs as a **declared content script** on `pro.goodshuffle.com`
(`content.js` + `pull-injected.js`), not as a background injection. Declared content scripts get their
site access at install, so the pull keeps working across Chrome updates instead of silently breaking
when Chrome resets an extension's per-site permission (the old `chrome.scripting.executeScript` path was
what kept getting revoked). The background worker now only drives the toolbar badge and the popup.

To stay healthy:
- Keep **one signed-in `pro.goodshuffle.com` tab open** in this browser (the pull runs in that tab).
- The toolbar badge shows **`ok`** (green) after each cycle; `!` means signed out / no tab / error.
- The app also alerts to Slack if the pull reports a failure for more than one cycle, so a broken
  puller is caught within minutes instead of going stale unnoticed.

**After updating this folder, click ↻ Reload on `chrome://extensions`** so Chrome picks up the new
version (unpacked extensions do not auto-update). If Chrome asks for site access, allow it on
`pro.goodshuffle.com`.

## Using "Capture to Opportunity Radar"

1. Open the portal and navigate to its **solicitation list** (the table of open bids/RFPs), e.g.:
   - Montgomery County → BidNet Direct
   - Maryland eMMA (Browse Public Solicitations)
   - City of Rockville / City of Gaithersburg bid pages
   - DC OCP solicitations
2. Click the extension → pick the matching **source** in the dropdown.
3. **Capture this page** — it reads the visible table rows (title, due date, agency, status, number, link).
4. Review the count, then **Send N to Radar**. They appear on `/radar` as real opportunities (deduped;
   re-capturing updates in place and logs changes like a new deadline or award).

Notes:
- It reads whatever table is on the page, so land on the **list**, not a single-solicitation detail page.
- It never sends anything until you click **Send**. Nothing is scraped in the background.
- Only the five registered portal sources are accepted by the server; add more in
  `src/lib/opportunity/sources/browser.ts` if you need another portal.
