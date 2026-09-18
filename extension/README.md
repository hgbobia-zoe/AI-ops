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
