# Provisioning captures (recorded live, replayed by the Auto-Pull extension)

Each entry is a request recorded once from a signed-in admin session, so the extension can repeat it in the
requesting person's own Chrome. Login tokens are never stored here: the replay reads them from the signed-in
page at run time.

**How it runs (Auto-Pull 1.21.0+).** People → a hire → "Set up N accounts in my Chrome" (or "Run in my Chrome"
on one step). `src/lib/people/chromeJobs.ts` approves each step and hands the page one job per step with a
one-time key; the page passes them to the extension (`zoe-provision`); `extension/provision.js` opens each site
in a VISIBLE tab, waits for sign-in, runs the steps, asks for an OK on paid seats (Quo, email) and on Yelp's
owner role, then posts the outcome to `/api/provision/result`. Slack, Squarespace and Yelp replay the requests
below; Quo and WeddingPro fill their own forms (their API auth can't be read from the page). Slack and Quo
invites close when the hire actually joins (People tick); the rest close on success. Offboarding stays manual.

**Day one (Auto-Pull 1.22.0+).** For a hire whose start date is still ahead, the run is held in the extension and
fires on day one, 10 minutes after their first Connecteam shift starts (9:00 AM if none), so the Google login and
invites land that morning. Paid seats are approved in Zoe when it is scheduled, so it runs unattended; the
Chrome that scheduled it must be running then (a missed time runs when Chrome next starts). "Run now instead"
skips the hold. If People has no personal email for the Google login, it is filled from the hire's Connecteam
account, or from Gusto on the next pull.

## Slack (free plan) — join link

Recorded 2026-11-10 from the web client (Invite people → Copy Invite Link).

- `POST https://zoeeventrentals.slack.com/api/users.admin.createSharedInvite`
- Body: multipart `FormData`
  - `token`: the web client's session token, read in page from
    `JSON.parse(localStorage.localConfig_v2).teams["T09F4BKDHPH"].token`
  - `expiration`: `"30"` (days, the UI default)
  - `max_signups`: `"400"`
  - `_x_reason`: `"create-shared-invite-link"`, `_x_mode`: `"online"`, `_x_app_name`: `"client"`, `_x_sonic`: `"true"`
- Query string carries client telemetry only (`_x_id`, `_x_csid`, `slack_route`, `_x_version_ts`, …); not needed to replay.
- Response: `{ ok, code, date_expire, max_signups, url, short_url, notifications_enabled }`. `url` is the join link.
- Related read: `POST /api/users.sharedInvites.list` (same token) returns active links with `num_signups` and
  `date_expire`, so an existing unexpired link can be reused instead of making a new one.
## Slack (free plan) — invite by email (preferred: zero touch)

Recorded 2026-11-10 (Invite people → email → Send).

- `POST https://zoeeventrentals.slack.com/api/users.admin.inviteBulk`
- Body: multipart `FormData`
  - `token`: same in-page session token as above
  - `invites`: JSON string `[{"email":"<hire email>","type":"regular","mode":"manual"}]`
  - `team_id`: `"T09F4BKDHPH"`, `restricted`: `"false"`, `ultra_restricted`: `"false"`, `campaign`: `"team_menu"`
  - `_x_reason`: `"submit-invite-to-workspace-invites"`, `_x_mode`: `"online"`, `_x_app_name`: `"client"`, `_x_sonic`: `"true"`
- Response: `{ ok, invites: [{ email, ok, invite_id, expiration_ts }] }`. Invite lasts 30 days. Slack emails the hire.
- The UI first resolves the address with `POST /cache/T09F4BKDHPH/users/searchBulk` (`match_email`) to warn about
  existing members; the replay can skip it (the bot `users.lookupByEmail` check covers "already a member").

## Quo (OpenPhone) — invite a member (PAID seat, approval required)

Recorded 2026-11-10 from my.quo.com → Settings → Members → Invite your team (real invite for the Thursday hire).

- `POST https://account.openphoneapi.com/v2/org/OR9X6MA29e/invite/bulk` (XHR, JSON)
- Headers: `Authorization: <auth0 access token>`, `Content-Type: application/json`, `x-op-app: web`,
  `x-op-device: browser`, `x-op-env: production` (plus a per-request id and device id the app generates).
  The token lives in localStorage under
  `@@auth0spajs@@::<clientId>::https://*.openphoneapi.com::openid profile email offline_access` → `body.access_token`
  (confirm at build time whether the header is `Bearer <token>` or the raw token).
- Body: `{"items":[{"email":"<hire email>","role":"member","needsNewNumber":false,"phoneNumberId":"","phoneNumberIds":["PN5DuqK1Xk"]}]}`
  - `PN5DuqK1Xk` = the shared Zoe Events line (301) 291-5296. `needsNewNumber:true` makes the hire buy a new number: never.
- Response: `{ results: [{ id, orgId, email, role, status: "invited", blocked, createdAt, updatedAt }] }`
- Before sending, the UI shows a billing confirm ("$33.00/seat/month plus tax, prorated"), price read via GraphQL
  `query InviteMemberBillingConfirmationSeatPriceQuery { me { userOrganization { organization { subscription { price { amount { formatted } } recurring { frequency } } } } } }`
  on `POST https://my.quo.com/api/graphql`. The replay must show the same price and wait for the onboarder's OK.
- Done check: public API `GET https://api.openphone.com/v1/users` (Quo API key) lists the hire once they accept.
- Note: zoeeventsdmv.com is an "allowed email domain" in Quo, so a hire with a work email can also join without an invite.

## Work email — Google Workspace via Squarespace (PAID seat, approval required)

Recorded 2026-11-10 from Squarespace → Domains → zoeeventsdmv.com → Email → Manage Plan → Add Users.
The panel lives on the site's config host, not account.squarespace.com:
`https://crocodile-chimes-jm6d.squarespace.com/config/settings/gsuite-add-user/64115bb50abb701f2a9ff04f`
(`64115bb50abb701f2a9ff04f` = the Workspace subscription id). All calls are same-origin with an
`X-CSRF-Token` header the page already holds (read it from the page at run time; never stored).

Form: First Name, Last Name, Username (→ `<username>@zoeeventsdmv.com`), Administrator (off), Personal Email
(where Google sends the new login).

1. Username check: `POST /api/google-email-product/subscriptions/64115bb50abb701f2a9ff04f/users/validate`
   body `{"email":"<username>@zoeeventsdmv.com"}` → `204` when free.
2. Price preview: `PUT /api/billing/contracts/preview-quantity-change`
   body `{"contractId":"con_rDTi5p6O3pWXNr","changeType":"add","requestApiMetadata":{"productType":"google-apps","changeType":"add","newGoogleAppsUser":{"firstName","lastName","userName","asAdmin":"","email","welcomeEmailRecipient","idempotencyKey"}}}`
   → the order summary (Starter plan, prorated, 1 seat; e.g. $2.44 + $0.15 tax due today).
3. Purchase (Confirm Payment, charges the card on file): `POST /api/billing/billing-requests/quantity-change`
   with the SAME body as the preview (`contractId`, `changeType:"add"`, `requestApiMetadata.newGoogleAppsUser`
   with a fresh `idempotencyKey`) → `{ id, state: "processing", billingOperation: "quantity-change" }`.
4. Poll `GET /api/billing/billing-requests/<id>/` about once a second until `state` is `"completed"`
   (took ~13 polls). Google then emails the login to `welcomeEmailRecipient`.
   Recorded with a real $2.59 test purchase (test user deleted right after).
5. Offboarding (delete user, permanent: inbox + documents): `DELETE /api/google-email-product/subscriptions/64115bb50abb701f2a9ff04f/users/<googleUserId>` → `204`.
   The id comes from `GET /api/google-email-product/subscriptions/64115bb50abb701f2a9ff04f/users`
   (`results[].{id,email,firstName,lastName}`). Deleting does NOT drop the paid seat:
   `GET /api/google-email-product/subscriptions/64115bb50abb701f2a9ff04f` shows `usedSeats` vs `maximumSeats`.
   When `usedSeats < maximumSeats` a spare paid seat exists, so the next hire may not need a purchase.
   Prefer suspend over delete for offboarding (keeps mail); delete only on an explicit human OK.

## WeddingPro (The Knot / WeddingWire) — invite a user (free)

Recorded 2026-11-10 from weddingpro.com → account menu → Settings → Permissions → Invite user.

- `POST https://www.weddingpro.com/wpapi/employee` (XHR, JSON, same-origin) → `201`
- Headers the app adds: `Content-Type: application/json`, `x-app-partner-key: zx9A208y7A`,
  `x-app-user-agent: <navigator.userAgent>`, `x-app-vendor-session-cookie: <the signed-in vendor session>`
  (read from the page at run time; never stored).
- Body:
  `{"email":"<hire email>","login":"<hire email>","firstName","lastName","sfAccountId":"0015e00001GfpzUAAR","roles":["7546d8ed-0f2e-11f0-9849-0639c11da88d"],"access":{"74bc0587-f502-4b1c-95b2-8e3296c15e95":{"vendorUuid":"74bc0587-f502-4b1c-95b2-8e3296c15e95","storefronts":["bf784fa5-4968-49a4-95c4-04a80894b94c"]}}}`
  - role `7546d8ed-…` = **Storefront manager** (storefronts only, no permissions or billing). Use this for hires.
  - storefront `bf784fa5-…` = Zoe's storefront; vendor `74bc0587-…`; Salesforce account `0015e00001GfpzUAAR`.
- Response: the employee `{ id, status: "pending", isAdmin:false, roles, access, … }`. WeddingPro emails the invite.
- Read: `GET /wpapi/employee/list` (done check: status flips from `pending` when accepted);
  `GET /wpapi/vendor-roles/list` lists role ids; `GET /wpapi/employee/<id>` reads one.
- Offboarding: `DELETE /wpapi/employee/<employeeId>` → `204` (removes their WeddingPro login for this account).

## Yelp for Business — invite a user (free, but grants OWNER)

Recorded 2026-11-10 from biz.yelp.com → Account settings → User management → Invite user.
Yelp asks for the password again before this page ("fresh login"); the replay tab must let the onboarder do it.

- `POST https://biz.yelp.com/gql/batch` — a JSON ARRAY of persisted GraphQL operations (no query text):
  `[{"operationName":"CreateOrganizationInvite","variables":{"orgId":"tsWbUrSCJa8r8SFh1UQ5ZA","inviteeEmail":"<hire email>","inviteeRole":"OWNER","bizEncIds":["9Y2NgpH8DrDmjMljzAjfsg"]},"extensions":{"operationType":"mutation","documentId":"a060c1bd2ddb73f9d0164e807328ef3b6fed111d5c4d826506e704086434e255"}}]`
  - `OWNER` is the only role the UI sends: the invitee gets the same access as the inviter, including buying ads
    with the card on file. Treat Yelp as approval-required for that reason.
  - `9Y2NgpH8DrDmjMljzAjfsg` = Zoe Events & Party Rentals business; `tsWbUrSCJa8r8SFh1UQ5ZA` = the organization.
- The page's GraphQL client keeps its own `fetch`, so an in-page fetch/XHR hook misses it; it was captured by
  hooking `JSON.stringify`. Headers (CSRF?) were not visible: confirm at build time by replaying from the page.
- Cancel a pending invite: same endpoint, `{"operationName":"RemovePendingInvite","variables":{"inviteId":"<32 chars>"},"extensions":{"operationType":"mutation","documentId":"72b8672f7600217a8666bfc2df45f4e44438e3e3f82a71667774b5d78df5b1fb"}}`
- Reads seen: `GetUserManagementManagedUserData` (`{organizationId, after}`, documentId
  `e0c5f359163e43206faa6de1062eb563f87e6103588094db9bb3ec861614acda`) lists users (done check);
  `GetFreshLoginSessionStatus` (documentId `8cfccbf23509c6d02157dbef7d8413bd48fa36c12496b73476a5dc8c4f0099dd`)
  says whether the password re-check is needed first.
- Removing an active user (offboarding) not recorded yet: the Remove link on Managed users.

## Goodshuffle — add a teammate (PAID seat, approval required)

Recorded 2026-11-11 from Account → Subscriptions → Team Management → Invite Teammate (real invite, Full monthly).

- `POST https://pro.goodshuffle.com/app/subscriptionSeat/bulkPurchaseSeats` (XHR, JSON, same-origin, cookies)
- Headers: `Content-Type: application/json`, `Accept: application/json, text/plain, */*`, `X-Requested-With: XMLHttpRequest`
- Body: `{"seatsToPurchase":[{"invitationEmail":"<hire email>","fullUser":true,"interval":"month"}],"stripePromoCodeID":null,"addingFromAccountShare":false}`
  - `interval: "month"` = $59/month; `"year"` = $49/month paid annually. `fullUser:false` = Limited seat.
- Response: `{ fullSeats: [{ id, stripeSubscriptionID, amount, fullUser, invitationEmail, … }] }`; Goodshuffle emails the invite.
- Done check: `GET /app/subscriptionSeat/list` → `subscriptionSeats[].invitationEmail` / `employee.email`.

## Whimsical — invite to the workspace (free plan)

Recorded 2026-11-11 from the workspace menu → Invite people (real invite, Editor).

- `POST https://whimsical.com/api/workspace.invite`, `Content-Type` and `Accept`: `application/transit+json`.
  The app also sends `W-App-Version` / `W-Session-Id` / `W-Version`, but plain headers + cookies work.
- Body (Transit-JSON): `["^ ","~:emails",["~#list",["<hire email>"]],"~:editor",true,"~:team-ids",["~#set",[]],"~:workspace-id","~u799f8e9f-2153-40e0-90a9-569932f8b4d5"]`
- Response: `["^ ","~:invited",1]`.
- Pending list: `POST /api/workspace.get-pending-invitations` body `["^ ","~:workspace-id","~u<id>"]` (used to skip a repeat invite).

## Slack — done check

- Done check: the bot token already reads members (`users.lookupByEmail`), so the step closes when the hire joins.
