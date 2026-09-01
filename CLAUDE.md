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
- **Create a project:** `GET /app/project/createNewProject` makes a blank draft and
  redirects to `/app/project/detail?id=<newId>`. (Empty drafts don't show in
  `searchProjects` until populated, but exist and are readable.)
- **Update a field (rename):** `POST /app/vendorTransaction/…` form body
  `transactionID` + `eventName`.
- **Add a client contact:** works — assigns an existing contact via the app's
  autocomplete.

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

Highest-value next write to build: **push dispatch progress → Goodshuffle stop/route
status** (button-driven, so easy to replay). Safe re: double-texting — Zoe has
Goodshuffle's stop-SMS off. Always test writes on TEST 1/2/3 first; add a confirm +
idempotency (writes mutate real data). Full read/write contract: `android/GOODSHUFFLE_ROUTE.md`.
