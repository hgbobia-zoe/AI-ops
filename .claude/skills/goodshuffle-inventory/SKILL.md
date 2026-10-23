---
name: goodshuffle-inventory
description: Bulk-create, import, or backfill Goodshuffle Pro (GSPRO) INVENTORY items — e.g. copy a partner's rental catalog (sofas, barstools, any furniture) into Zoe's own Goodshuffle inventory so it appears on zoeeventsdmv.com, or attach photos to items that are missing them. Use when the task mentions importing/subrenting another vendor's Goodshuffle storefront, bulk-adding inventory items, or fixing missing item photos. NOT for Goodshuffle PROJECTS/bookings/routes (that's the pull/outbox path) — this is the inventory CATALOG.
---

# Goodshuffle Pro — inventory bulk write / import

Everything below was reverse-engineered LIVE against the real GSPRO API and verified against 200 responses (2026-10-22). It replaces hours of trial-and-error — follow it exactly; the gotchas are each a real failure that cost a debugging round.

## The hard constraints (read first)
- **GSPRO has no public write API and Cloudflare blocks datacenter IPs.** All writes run from a **logged-in `pro.goodshuffle.com` browser tab** (same-origin `fetch`, `credentials:"include"`). The server cannot do this.
- **A Claude tool-issued mutating fetch (saveRegularItem POST) is blocked by the auto-mode security classifier ("Unrequested Commit in a Connected App").** Do NOT try to work around that guardrail. The deliverable is a **console script the user runs themselves** in their GSPRO tab (it executes as them — no guardrail). READS (GET, and the search POST) are fine to run via the browser tools; only the mutating writes must be user-run. See `[[self-unblock-with-browser]]`.
- **Ready-to-run scripts are bundled here:** `scripts/importer.js` (bulk-create a partner's catalog) and `scripts/photo-repair.js` (attach photos to existing items). Hand the user the fitting one; both default to `DRY_RUN=true` + `LIMIT=1` so they preview, test one, then run all.

## Source = Goodshuffle PUBLIC storefront data API (no auth, reachable anywhere)
`GET https://data.goodshuffle.com/vendor/<VENDOR_TOKEN>/inventory?categories=<c>&groups=<g, space-separated>&size=200`
→ `{ total, items:[{ id, title, description(HTML), tags[], images:[{rawImagePath,imagePath,croppedNoPaddingPath,primaryImage,viewOrder,fileName}], category, groups, ... }] }`
Any site using the `@goodshuffle/gspro-wc` web component exposes this; the vendor token is the page's `gspro-wishlist-config[data-url]`. Server-side HTML-regex `data\.goodshuffle\.com/vendor/([A-Za-z0-9]+)` finds it for WordPress sites but NOT Wix (JS-injected) — then ask the user to paste the data URL/token.
- Zoe's own token: `y2lcwfwX40RpfPiD6jorw7ipHI6gUK` (sofa group `sofa-rentals`, barstool group `stools-rentals`).
- Known Zoe category IDs: Sofas `primaryCategoryID 657`, Barstools/Stools `661`, both under server-derived rootGroup **Furniture 9038**. Default tax type: `maryland id 228186759`.

## REQUEST HEADERS — the #1 gotcha
Every `pro.goodshuffle.com/app/*` call MUST send the headers the app's own XHR sends, above all **`Accept-version: v3.2`** — the server validates against that API version and **400s ANY body without it**. Also `X-Requested-With: XMLHttpRequest`, `Accept: application/json, text/plain, */*`, and `Content-Type: application/json` on POSTs. (The S3 image PUT to amazonaws.com must NOT get these.)

## Create / update an item — `POST /app/inventory/saveRegularItem`
Two-step per item (mirrors the UI: BASICS create, then DETAILS save):
1. **CREATE (minimal):** NO `id`, NO `uuid`, NO rootGroup (server derives from category). Untracked = `quantityTracked:false` and **OMIT `quantityPosted` entirely** (sending it as `null` → 400). Keys: `attributes:[], selected:false, title, primaryCategoryID, primaryCategoryName, quantityTracked:false, marketplace_visible:true, website_wishlist_visible:true, useContractDescriptionForWeb:true, pricingMap, inventoryType:{name:"PRODUCT"}, originalInventoryType:"PRODUCT", poolMembers:[]…parentPackages:[], images:[], applied_tax_types`. Response: `{inventoryItem:{…id,uuid,rootGroup…}}`.
2. **UPDATE:** the created item + `{contract_description, web_description, useContractDescriptionForWeb:false, internal_notes, tags, images, temporaryImages}`, then `delete quantityPosted; delete quantitySetAside` (untracked).

- **pricingMap (unpriced, exact minimal):** `{ flatFeesByGeo:[], rateType:"UNPRICED", unpriced:true, flatFee:null, dailyPriceVisibleOnECommerce:true, hourlyPriceVisibleOnECommerce:true, flatFeePriceVisibleOnECommerce:true, purchasePriceVisibleOnECommerce:true }`.
- **applied_tax_types:** fetch live `GET /app/taxType/list` → `{taxTypes:[…]}`, filter `autoAppliedToProducts`, and **map each to add `selected:true` + `translatedAutoAppliedString`** (the list omits them; the create 400s without `selected`).
- **tags:** COMMA-SEPARATED STRING; base tag "Sofa"/"Barstool", normalize "Bar stool"→"Barstool", drop `/^(group |event rental)/i`. Website placement is driven by the CATEGORY, not tags.

## Photos — the #2 gotcha (save 200s but photo silently dropped if wrong)
1. `GET /app/image/getPresignedUploadURL?fileName=<n>` → `{presignedUrl, s3Path, s3Url}`.
2. `PUT presignedUrl` the image Blob with headers `{Content-Type:<mime-by-ext>, "x-amz-acl":"public-read"}` (**x-amz-acl REQUIRED or S3 403**). Fetch the source blob from the partner's public S3 URL (CORS-open).
3. On saveRegularItem the new photo must go in a **`temporaryImages`** array (NOT only `images`) — temporaryImages is the trigger that relocates the tmp upload and actually attaches it. Send the entry in BOTH:
   - `images[]`: `{id:null, cloudflareUrl, cloudflareThumbUrl, s3Path, originalS3Path, caption:"", viewOrder, fileName, isAnimatedGIF:false, rawWidth, rawHeight}`
   - `temporaryImages[]`: same minus `fileName`, plus `croppedNoPaddingPath` (= `s3Url`).
   - URL derivations from the presign `s3Url`: `originalS3Path = croppedNoPaddingPath = s3Url`; `cloudflareUrl = "https://pro.goodshuffle.com/cdn-cgi/image/width=760,height=428,quality=85,fit=pad,background=white,format=auto/"+s3Url`; `cloudflareThumbUrl` same with `width=280,height=158`.
Newly-attached photos take ~a minute to appear on the public storefront (Goodshuffle processes them).

## Finding an existing item (for backfill) — `POST /app/inventory/searchInventoryItems`
It's a **POST** (a GET 400s): body `{countOnly:false, searchMode:"QUERY", inventoryTypes:["PRODUCT"], categoryIDs:[], tags:[], taxTypes:[], searchText:"<title>", availabilityFromDate:"MMM D YYYY", availabilityToDate:"MMM D YYYY"}`. Returns `items[]` with the internal numeric `id`, `uuid`, category/rootGroup, and `thumbImagePath` (null = no photo → needs backfill). It's a read, so safe to run via the browser tools.

## Rate limits
`pro.goodshuffle.com` (Cloudflare) 429s scripted bursts. Pace every GSPRO call through a self-tuning throttle: start ~1500ms gap, grow ×1.6 on each 429 (honor Retry-After), abort cleanly after ~12 consecutive 429s (then wait a few minutes and re-run — the scripts are idempotent). S3 PUTs aren't throttled. A sustained burst trips a cooldown that needs quiet time to clear.

## The /inventory blade
The app's `/inventory` "Inventory Automation" blade productizes this: configure partners by URL, map their groups to Zoe categories, preview, and generate the importer. The verified payload builders live in `src/lib/inventory/bookmarklets.ts`. Keep that file and the two bundled scripts in sync — they are the single source of truth for the write recipe. Related: `[[goodshuffle-inventory-automation]]`, `[[goodshuffle-writeback-proven]]`.
