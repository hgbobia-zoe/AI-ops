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

**Install once, log into Goodshuffle in your browser, done — there's no tab to keep open.**

As of **v1.3.0** the background service worker OWNS scheduling (via `chrome.alarms`, which survives the
worker sleeping — a plain `setInterval` does not) and the Goodshuffle tab lifecycle. On each cycle (and
on install/startup) it makes sure a signed-in `pro.goodshuffle.com` tab EXISTS — if none is open, it
opens a single **pinned, background** tab at the GS dashboard and keeps it alive (no per-cycle flicker).
The declared content script (`content.js` + `pull-injected.js`) then runs the read-pull IN that tab,
using your own Goodshuffle cookies. Declared content scripts get their site access at install, so this
keeps working across Chrome updates instead of breaking when Chrome resets a `chrome.scripting.executeScript`
per-site permission (the old failure mode).

**Log into Zoe Ops → it syncs.** The extension also listens for a handshake from the Zoe Ops platform
(`externally_connectable`). When you open the console and the pull looks stale, Zoe Ops asks the
extension to sync immediately using this browser's Goodshuffle session. If Goodshuffle is signed out, the
extension opens a GS login tab so you can sign in; once you do, the next cycle pulls.

**Creating projects from queued intakes (optional, OFF by default).** Turn on *"Create projects from
queued intakes"* in Settings to have the extension drain `create_project` intake ops: for each one it
opens a background GS tab at `createNewProject` and populates a new project (no popup, one at a time).
Leave it OFF if a standalone runner already creates projects — reads/routes/bookings work either way.

To stay healthy:
- Just stay **signed into Goodshuffle** in this browser. You do **not** need to keep a GS tab open — the
  extension opens/keeps one itself.
- The toolbar badge shows **`ok`** (green) after each cycle; `!` means signed out / error.
- The app also alerts to Slack if the pull reports a failure for more than one cycle, so a broken
  puller is caught within minutes instead of going stale unnoticed.

**After updating this folder, click ↻ Reload on `chrome://extensions`** so Chrome picks up the new
version (unpacked extensions do not auto-update). If Chrome asks for site access, allow it on
`pro.goodshuffle.com`. The extension ships a fixed `key` so its ID stays stable across reinstalls (the
platform handshake relies on that ID).

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
