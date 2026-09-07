@AGENTS.md

# Goodshuffle Pro — read AND write (no public API)

Goodshuffle has no public API. We drive it by replaying its own internal endpoints
from **inside a logged-in session** (the kiosk WebView, or a logged-in Chrome) — same-
origin `fetch` with `credentials: "include"`, because Cloudflare blocks server-side
calls. This works for **reads and writes**.

Proven live (2026-09-02) against the Zoe sandbox projects **TEST 1 / TEST 2 / TEST 3**
(account `hello@zoeeventsdmv.com` — full user, contract edit + delete):

- **Read:** `POST /app/routing/listRoutes` + `GET /app/routing/getRoute`,
  `GET /app/project/searchProjects`, `GET /app/vendorTransaction/initProjectTimeline`,
  `GET /app/vendorPayment/loadPaymentHistoryAndContractTotals`.
- **Read — FULL project history:** `GET /app/project/searchProjects` with
  `?page=N&pageSize=500&allProjects=true&sortColumn=logistics_start_date&sortDirection=desc&useV2DateHandling=true`
  returns **all statuses + all years incl. archived** (~2.8k projects). Without `allProjects`
  it returns only the ~90 active, non-archived. **Amounts are CENTS** (verified via the Projects
  Totals row — the platform ÷100s to dollars; do NOT "fix" this).
- **Create a project:** `GET /app/project/createNewProject` makes a blank draft and
  redirects to `/app/project/detail?id=<newId>`. (Empty drafts don't show in
  `searchProjects` until populated, but exist and are readable.)
- **Update a field (rename):** `POST /app/vendorTransaction/…` form body
  `transactionID` + `eventName`.
- **Add a client contact:** works — assigns an existing contact via the app's
  autocomplete.
- **Upload a file / delivery photo (PROVEN 2026-09-05):** `POST /app/files/uploadFileToProject?transactionID=<id>`,
  multipart body just `{file: <blob>}` (it's flow.js, but a plain single-part POST works — no
  flowChunk* fields) → `200 {attachments:[{id,name,path:<S3 url>}]}`. Wired end-to-end: driver
  checklist camera → `/api/pod` (volume) → completion queues a `photo_upload` gs_outbox op → the
  office pull's drainer fetches `/api/pod/<id>` (CORS'd to pro.goodshuffle.com) and uploads it.
- **Sign a contract in person (no email until final):** toolbar **Digital → Contract eSignature →
  View** opens `/ui/clientView/eSignContract?transactionID=<id>` on-device (hand to client); agree
  to e-signature, draw + name, **I Approve And Sign** → status becomes Contract Signed, deposit
  becomes *due* (no auto-charge without a card on file), and a signed-copy PDF emails the client.

Write mechanics + gotchas:
- **CSRF is handled automatically** by the logged-in session — no token to manage for
  same-origin calls (it's in the `initProjectSearch` response if ever needed).
- The prod app **disables AngularJS debug info**, so `angular.element(el).scope()`
  returns nothing — you can't call controllers directly. Button-driven writes can be
  fired by clicking the element (`[ng-click]`) or replaying the captured request.
- **Picker fields (contact/venue) use md-autocomplete that ignores synthetic events** —
  capture their exact request from ONE real user interaction. Use **browser-level**
  network capture, not an in-page `fetch`/XHR hook: the contact panel reloads the page,
  which wipes in-page hooks.
- To capture a new write: do it once in the UI on a TEST project while recording, then
  codify it (endpoint + body), matching records by `transactionID`.

## How pulls actually run (Cloudflare blocks the server)

The server **cannot** call Goodshuffle (Cloudflare blocks datacenter IPs), so the in-repo
Playwright scraper (`src/lib/ingest/*`) is a non-working legacy fallback — **do not rely on it**.
The working path is a **logged-in browser** replaying the endpoints and POSTing to our ingest APIs:
- **Office Auto-Pull** — a self-repeating bookmarklet built by `src/lib/gsPull.ts`
  (`buildOfficePullScript`), installed from **/admin/pull**. Run once/day in the logged-in
  `pro.goodshuffle.com` tab; it pulls routes (`/api/route/import`) + full bookings history
  (`/api/gs/projects`) AND drains the `gs_outbox` (photo pushes) on a 10-min timer.
- **Kiosk WebView** (Android APK) does the same for the truck's route.
- Ingest endpoints are CORS-locked to `https://pro.goodshuffle.com` and gated by the
  **unset-by-default** `GS_INGEST_TOKEN` (fail-open until set).

Highest-value next write to build: **push dispatch progress → Goodshuffle stop/route
status** (button-driven, so easy to replay). Safe re: double-texting — Zoe has
Goodshuffle's stop-SMS off. Always test writes on TEST 1/2/3 first; add a confirm +
idempotency (writes mutate real data). Full read/write contract: `android/GOODSHUFFLE_ROUTE.md`.
