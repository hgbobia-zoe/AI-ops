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

### Highest-value next write: sync stop/route status BACK
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
