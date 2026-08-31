# Zonar Ignition — `createEtaLink` contract (captured from the live app)

This is the exact request the Ignition web app makes when you create an ETA link
(Maps → Map Utilities → ETA → **+**). The kiosk's hidden, logged-in Ignition WebView
replays it via `evalInIgnition` so a per-stop customer ETA link can be minted
automatically. Captured 2026-08-30 from a real session (company **ZOE EVENTS**).

## Endpoint & auth
- **POST** `https://wrfalckup5gc3flo7bizcsfmiq.appsync-api.us-east-1.amazonaws.com/graphql`
- Headers:
  - `authorization: <token>` — **equals `localStorage.getItem("IdToken")`** (Cognito
    JWT, Google-federated). The logged-in WebView already holds this, so an in-page
    script just reads it from localStorage. Do NOT try to mint/refresh it ourselves.
  - `app-id: px-cloud`
  - `app-version: 1.0.160`
  - `package-name: cloud-react`
  - `content-type: application/json`
  - `accept: */*`

## Mutation
```graphql
mutation createEtaLink(
  $unitId: Int!, $entityId: Int!, $entityName: String!, $landmarkId: Int,
  $address: String!, $latitude: Float!, $longitude: Float!,
  $sharedWith: SharedWithInput!, $eta: String, $scheduleSnapshot: Boolean,
  $dateRange: AWSDateTimeRange!, $notes: String
) {
  etaLink: createEtaLink(
    unitId: $unitId, entityId: $entityId, entityName: $entityName,
    landmarkId: $landmarkId, address: $address, latitude: $latitude,
    longitude: $longitude, sharedWith: $sharedWith, eta: $eta,
    scheduleSnapshot: $scheduleSnapshot, dateRange: $dateRange, notes: $notes
  ) { id code status __typename }
}
```

## Variables (real example)
```json
{
  "unitId": 200149627,            // Ignition unit id (Ford E450). NOT the GPS TrackIt id.
  "entityId": 200149627,          // = unitId
  "entityName": "Unit",
  "address": "111 Rockville Pike Rockville, MD 20850 United States",
  "latitude": 39.085986,
  "longitude": -77.1494791,
  "eta": "0.2",                   // initial estimate, hours (string). Link recomputes live.
  "sharedWith": { "contacts": [], "emails": [], "sms": ["+13012915296"] },
  "scheduleSnapshot": false,
  "dateRange": { "start": "2026-08-31T03:50:00.859Z", "end": "2026-08-31T11:50:59.859Z" },
  "notes": null
}
```

### ⚠️ The notify-line rule (why sharedWith matters)
`sharedWith.sms` is who **Zonar** texts its own unbranded link to. It MUST be the Zoe
main line **+13012915296** (`BuildConfig.ETA_NOTIFY_PHONE`), never the customer. The
customer only gets Zoe's branded Quo SMS, which embeds the link we build below.

## Response → link URL
```json
{ "data": { "etaLink": { "id": 15477, "code": "11e38c7d61", "status": "Active" } } }
```
Public link = **`https://ignition.zonarsystems.com/etaLink/<code>`**
(e.g. `.../etaLink/11e38c7d61`) — matches the Quo template's link.

## Data model (from `searchEtaLinks`, for reference)
EtaLink { id, companyId, **code**, eta, unitId, address, unit{ id,label,timeZone },
status, latitude, longitude, expirationDate, sharedWith{ contacts,emails,sms }, isKph,
startDate, scheduleSnapshot, notes }

## Resolving the unit id — `searchUnits` (captured working)
The company has only 3 units. Query them (same endpoint/headers/auth):
```graphql
query ($limit: Int, $offset: Int) {
  result: searchUnits(limit: $limit, offset: $offset) { items { id label } total }
}
```
Result (2026-08-30):
| label            | unitId      | app truckId (likely) |
|------------------|-------------|----------------------|
| Ford E450        | `200149627` | E450                 |
| ISUZU NPR        | `200149626` | NPR-1                |
| 88X161060205     | `200214102` | NPR-2 (unlabeled device — confirm) |

So the kiosk can resolve unitId by matching the truck name against `searchUnits` at
runtime (no hardcoded map), or use the table above.

## Still needed to fully wire the kiosk (web side)
The Android bridge method `createEtaLink(requestId, paramsJson)` is implemented
(KioskActivity) and takes `{unitId, address, latitude, longitude, etaHours?, startISO?,
endISO?, notes?}`. Remaining, and needs on-tablet testing:
- **The dispatch web app must call it.** On departure to a stop (LEAVING_WAREHOUSE /
  HEADING_NEXT), if `window.ZoeKiosk` exists, call `createEtaLink`, await the URL, and
  put it on the action `payload.etaLink` — `fanout.ts` already prefers that.
- **unitId** from the table above (or a `searchUnits` lookup by label).
- **lat/lng** for the stop address. Our server geocodes (`src/lib/eta/geo.ts`); pass
  them in, OR geocode in-page (the Ignition page has `google.maps` loaded, so
  `new google.maps.Geocoder().geocode({address})` works there too).
- `eta` a rough number (our computed minutes/60); the link recomputes live.
- `dateRange`: start = now, end = now + shift window (~8h).
