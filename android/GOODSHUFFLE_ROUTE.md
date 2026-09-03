# Goodshuffle Pro — route extraction contract (captured from the live app)

How the kiosk's Goodshuffle WebView pulls the day's route for its truck and hands it to
`/api/route/import`. Captured 2026-08-31 from the logged-in dispatch session
(pro.goodshuffle.com, company Zoe Events). All calls are same-origin and reuse the
WebView's session cookies (`credentials: "include"`) — no token to manage.

## Vehicles (truck matching — CRITICAL)
Routes are per-truck; two can start at the same time going opposite directions, so we
MUST match on the assigned vehicle. Goodshuffle has 2 vehicles:

| vehicleID    | title            | app truckId |
|--------------|------------------|-------------|
| `1088382913` | "1 - Isuzu NPR"  | NPR-1 / NPR-2 |
| `963316763`  | "2 - Ford E450"  | E450        |

(Match by title containing "Isuzu"/"Ford", or the map above.)

## Step 1 — list the truck's routes for today
`POST /app/routing/listRoutes`  (JSON body)
```json
{ "from":"<todayStartUTC>", "to":"<nextDayStartUTC>",
  "warehouseCanonicalIDs":null, "crew":null, "vehicles":[<vehicleID>], "statuses":null }
```
- `from`/`to` bound the day; midnight **Eastern** expressed in UTC (ET is -04:00/-05:00).
- Returns an array of route objects. Each has: `id`, `name`, `status`, **`vehicleID`**,
  `startDate`, `endDate`, `driver`, `waypoints`, `vehicle{ id, title }`.
- A truck may have >1 route in a day (e.g. a morning delivery + an afternoon pickup).
  `listRoutes` waypoints are NOT fully enriched (location = null) — use step 2.

## Step 2 — enrich each route
`GET /app/routing/getRoute?routeID=<id>&includeAttributes=true`
Returns the route with **fully-populated waypoints**. Each waypoint:
- `waypointIndex` — order (sort by this)
- `isOriginWarehouse` / `isDestinationWarehouse` — **skip these** (the depot legs)
- `waypointType` — `DROP_OFF` (delivery) | `PICK_UP` (pickup)
- `latLng { latitude, longitude }`
- `scheduledArrivalTime` — the arrival window / ETA (ISO w/ offset)
- `transactionID`, `name` (e.g. "Drop-Off (#231778646) - Standard Delivery")
- `logisticRelation.targetLocation` — **the destination**:
  `streetAddressLine1`, `streetAddressLine2`, `city`, `state`, `zipCode`, `country`,
  `latitude`, `longitude`, `venueName`, `roomNumber`,
  **`contactName`**, **`contactPhoneNumber`**, `contactEmail` (on-site delivery contact)
- `transaction` — the project: `eventName` (customer identity, e.g. "Dave - 4218 Brookfield Dr…"),
  **`dayOfContact`** (the day-of coordinator — maps to our dayOfName/dayOfPhone), `renterID`,
  `businessContactID`, `eventStartDate`/`eventEndDate`.
- `transaction.renter` — **inlined with `includeAttributes=true`** (does NOT need a separate
  contacts API): `name`, `firstName`/`lastName`, `email`, `phone` (e.g. "(301) 640-0251"),
  and `smsValidation.e164PhoneNumber` (e.g. "+13016400251") + `hasPhoneNumber`/`isValidPhoneFormat`.
  This is the customer's real phone — the SMS recipient.

## Mapping to our Stop
| our field       | Goodshuffle source |
|-----------------|--------------------|
| sequence        | `waypointIndex` (after dropping warehouse legs) |
| custName        | `targetLocation.contactName` else `transaction.eventName` (first segment before " - ") else `transaction.renter.name` |
| custPhone       | `transaction.renter.smsValidation.e164PhoneNumber` else `transaction.renter.phone` else `targetLocation.contactPhoneNumber` (never dispatcher/storeLocation — those are the Zoe main line) |
| address         | `targetLocation.streetAddressLine1` + Line2 + `, city, state zipCode` |
| lat/lng         | `targetLocation.latitude/longitude` (or waypoint.latLng) |
| dayOfName/Phone | `transaction.dayOfContact` (when set) |
| plannedWindow/eta | `scheduledArrivalTime` |
| (kind)          | `waypointType` — DROP_OFF vs PICK_UP |

## Line items per stop (crew rules + quote review)
Each waypoint carries its **`transactionID`** (the "open the project" link). Its line items
come in TWO steps (both same-origin, session cookies):
1. `GET /app/vendorTransaction/initContractView?transactionID=<txID>` →
   `.lineItemGroupsToLoad` = `[{ id, groupName, ... }]` (e.g. "Rental Items", "Logistics").
2. `GET /app/lineItemGroup/loadContractLineItemGroup?lineItemGroupID=<groupID>&transactionID=<txID>`
   → the group's items. **name = `itemTitle`, quantity = `quantityBooked`.**
Both params are REQUIRED on step 2 (missing `transactionID` → 400). The extractors attach
`items:[{name,quantity}]` per stop (parallel per stop + per group; best-effort, never
blocks the pull). Feeds `crewRules.ts` (tent → 2, 40x60 → 3) and `quoteReview.ts`.
Verified live 2026-09-02.

## Known gaps / notes
- `contactPhoneNumber` (on-site contact) is often blank. RESOLVED: the customer's real
  phone is the **inlined `transaction.renter`** (`smsValidation.e164PhoneNumber` / `phone`) —
  no separate contacts API needed, `includeAttributes=true` already returns it. The extractor
  prefers renter → on-site contact. (Earlier belief that this needed `/app/contact/{id}` was
  wrong.)
- `dayOfContact` was unset on all sampled upcoming routes; confirm its object shape when
  a route that has one is available (expected: name + phone).
- Cloudflare blocks server-side scraping, which is why this runs INSIDE the logged-in
  WebView — same reason as the Ignition ETA link.

## Writing BACK to Goodshuffle — PROVEN (2026-09-02, not yet wired into the app)

Writes work the same way as reads: replay Goodshuffle's own internal POSTs from inside a
logged-in session. Demonstrated live on the Zoe sandbox projects TEST 1/2/3 (account
`hello@zoeeventsdmv.com` — full user, contract edit + delete):

- **Create a project:** `GET /app/project/createNewProject` → creates a blank draft and
  redirects to `/app/project/detail?id=<newId>`.
- **Rename / update a field:** `POST /app/vendorTransaction/…` (form-encoded)
  `transactionID=<id>&eventName=<value>`.
- **Add a client contact:** assigns an existing contact via the app's md-autocomplete.

Mechanics + gotchas:
- **CSRF is auto-handled** by the logged-in same-origin session (no token to send). It's
  also in the `POST /app/project/initProjectSearch` response (`csrfToken`) if ever needed.
- Prod app **disables AngularJS debug info** → `angular.element(el).scope()` is null; you
  can't call controllers. Fire button-driven writes by `.click()`-ing the `[ng-click]`
  element, or replay the captured HTTP request.
- **Picker fields (contact/venue) use md-autocomplete that ignores synthetic events.**
  Capture their exact request from ONE real user interaction, and use **browser-level**
  network capture — the contact panel reloads the page, wiping any in-page fetch/XHR hook.

### Two-way stop removal (Dispatch → Goodshuffle) — FULLY WIRED (endpoint captured 2026-09-02)
Dispatch can "Pull" a stop off a route (`RemoveStopButton` → `POST /api/route/stop/remove`).
That removes it from OUR board immediately and, when the stop carries its Goodshuffle ids,
queues a write-back in the **`gs_outbox`** table (`op: "remove_waypoint"`, with the stop's
`transactionID` + the route's `gsRouteID`). Our server can't call Goodshuffle, so a
logged-in session drains the queue:
- `GET  /api/gs/outbox`            → pending ops (CORS-open to pro.goodshuffle.com)
- `POST /api/gs/outbox {id, ok}`   → ack one done/failed
- `scratchpad/sync-goodshuffle-removals.js` — the drain bookmarklet.

**The remove endpoint (captured live from route #55821, drag-a-stop-to-Unscheduled):**
```
POST /app/routing/unscheduleWaypoint      (JSON, same-origin session cookies)
body: { "waypointID": <waypoint.id> }
```
Key gotchas: (1) the key is the waypoint's own **`id`** (e.g. 4408112) — NOT its
`transactionID`; match the waypoint by `transactionID` then pass its `.id`. (2) Route-planner
mutations go through the app's **Angular service worker (ngsw)**, so they do NOT appear in a
CDP/page network monitor — capture them with an in-page `fetch`/XHR hook or the Performance
resource timeline. (3) Removing = "unschedule" (the stop moves back to Unscheduled, it is
NOT deleted), so it's reversible: re-add with `POST /app/routing/scheduleWaypoint`
`{ vehicleID, routeID, routeColor, waypointID, logisticID, arrivalTime, departureTime }`.

For write-back to work the pull must persist the ids: `Stop.txId` (waypoint transactionID)
and `Route.gsRouteId` — all three extractors now emit them (bookmarklet, kioskBridge
web-eval, native `buildGoodshuffleScript`; APK v1.0.20). Routes pulled before v1.0.20 have
no ids, so their stops remove locally only (the API reports `gsSkippedReason`).

### Other next write: sync stop/route status BACK
Goodshuffle models progress: `route.status` (`SCHEDULED` → `IN_PROGRESS` → …) and each
waypoint's `status`. Our transitions (EnRoute / Arrived / Completed) can drive those,
keeping Goodshuffle in sync with the tablet. This is **button-driven** (not autocomplete),
so it's the easy bucket to capture + replay. SAFE re: double-texting — Zoe has
Goodshuffle's stop-SMS option OFF, so status updates won't text customers (our branded
Quo SMS stays the only one they get).
To build: capture the `Start Route` / `mark stop` `POST /app/routing/…` mutation on a
throwaway/test route, then call it from the kiosk bridge on ARRIVED / HEADING_NEXT /
COMPLETE, matching waypoint by `transactionID`. Always test on TEST 1/2/3 first; add a
confirm + idempotency (writes mutate real data).

## Revenue + customer identity — CAPTURED & PROVEN (2026-09-03)

Both keyed by the **same `transactionID`** we already store as `stops.tx_id` — no id-guessing.

### Revenue (contract $) — the FI source
`GET /app/vendorPayment/loadPaymentHistoryAndContractTotals?transactionID=<tx>` (same-origin,
logged-in). Returns 200 JSON. **All amounts are in CENTS** (verified by arithmetic: across
projects paid + remaining = total; deposit ≈ 50% of grand). Fields we use:
- `grandTotal` / `contractTotal` — signed contract value (cents). e.g. 43949 = **$439.49**.
- Subtotals: `contractProductRentalsSubTotal`, `contractServiceSubTotal`,
  `contractLogisticsSubTotal` (delivery), `contractDiscountSubTotal`, `contractTaxableSubTotal`.
- `paymentHistory.totalContractApplicablePaid` — collected (cents).
- `paymentHistory.calculatedDepositAmount` — deposit (cents).
- `paymentHistory.transactionID` — **equals our tx_id** (join proof).

**Bulk alternative:** `GET /app/project/searchProjects` → `projectSearch.results[]`
(30/page; `totalResultCount`/`page`/`totalPages`), each with `id`, `contract_total`,
`grand_total`, `amount_paid`, `remaining_balance`, `amount_due` (cents) + `client_name/email/phone`,
`signed`, `statusLabel`, `logistics_start_date`. Good for a bulk sweep; per-event endpoint above
is the unambiguous per-tx join.

### Customer identity (for MVP6, replaces name-based matching)
From `GET /app/vendorTransaction/initContractView?transactionID=<tx>` (200 JSON):
- `contactID` — stable **person** id (e.g. 1178477906).
- `business:{id,name,email,addressLabel}` — **company** id.
(searchProjects also gives `client_email` — a decent stable-ish key.)

### Wiring status
- **Server ingest DONE + deployed:** `POST /api/finance/revenue` (guarded by `x-publish-token`
  = KIOSK_PUBLISH_TOKEN; body `{items:[{transactionId, grandTotalCents, paidCents?}]}`; converts
  cents→dollars, derives date/label from our stops via `getEventStub`, saves via `saveEventRevenue`,
  status SIGNED/COLLECTED). **Proven live** (backfilled tx 231505509 → /finance shows $439).
- **TODO — automate per-pull capture:** the pull extractors (web + bookmarklet + native APK)
  already fetch per-event via `initContractView`; add a `loadPaymentHistoryAndContractTotals`
  fetch there and POST `{transactionId, grandTotalCents, paidCents}` (and capture `contactID`)
  so every pull populates revenue + identity. Native path needs an APK build+OTA.
