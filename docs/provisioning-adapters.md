# People Lifecycle — provisioning adapters

How each system's onboarding (provision) and offboarding (revoke) is automated, and the EXACT steps to
turn a "capture-pending" replay adapter into a working one. The governing rule is honesty: an adapter
reports `automated` **only** when a real mechanism can act right now. Otherwise it degrades to a tracked
manual task that a human completes and attests to.

Every provision/revoke — automated or not — is fronted by the Phase-1 approval card (`ai_approvals`, via
`src/lib/aiorg/approvals.ts`) and recorded in the audit log. Nothing creates or removes an account without
that gate. We never store a third-party password.

## Status by system

| System | Adapter | Mechanism | `mode()` today | How it flips to automated |
|---|---|---|---|---|
| **Zoe platform login** | `zoe_platform` | Our own DB (mint invite / deactivate login) | `automated` | Already automated — our own exported auth functions. |
| **Connecteam** | `connecteam` | **Official REST API** (`POST /users/v1/users`, `DELETE …?deletionType=archive`) | `manual` until write scope verified | Verify the `users.write` scope, then set the verified flag (below) → `automated`. |
| **Goodshuffle Pro** | `goodshuffle` | **Replay** a captured internal invite/disable request from a logged-in GSPRO session | `manual` (endpoint capture-pending) | Capture the endpoint once (below) → `automated` (drains in the office pull). |
| **Quo (OpenPhone)** | `quo` | **Replay** from a logged-in Quo admin session | `manual` (endpoint capture-pending) | Capture the endpoint once → `automated` (drains from a logged-in Quo tab). |
| **Slack** | `slack` | **Replay** from a logged-in Slack admin session | `manual` (endpoint capture-pending) | Capture the endpoint once → `automated` (drains from a logged-in Slack tab). |
| **Gusto** | `gusto` | None | `future` | No admin-provisioning mechanism exists; onboarding/termination is a human flow in Gusto. |
| **Google Workspace / SSO** | `google` | None | `future` | No identity/SSO/SCIM is implemented in the app. |

`mode()` is gated on a **real capability**, never on "a key is present":
- Connecteam = `automated` only when `connecteam.provisioningScope = "verified"` is recorded.
- Replay adapters = `automated` only when their endpoint constant in
  `src/lib/people/provisioningEndpoints.ts` is non-null.

Replay adapters never complete synchronously: on approval they enqueue a `provision_user` / `revoke_user`
op (via `enqueueProvisioningOp`) and the task sits `in_progress` until the logged-in drainer replays it.

## A) Connecteam — enable the real automation

Connecteam has an official users API, so the create/archive calls are already wired
(`createConnecteamUser` / `archiveConnecteamUser` in `src/lib/connecteam.ts`). They need the API key's
`users.write` scope. To flip the adapter honestly:

1. Confirm the key can write **without creating anyone**: call `connecteamWriteProbe()` (POSTs an empty
   array). A `403`/`401` means the scope is missing; any other status means it is present.
2. Once the probe reports the scope is present (or you have confirmed it in the Connecteam dashboard under
   the API key's permissions), record the capability flag:
   `setSecret("connecteam.provisioningScope", "verified")`.
3. `getAdapter("connecteam").mode()` now returns `automated`. New onboarding tasks for Connecteam become
   approval-gated automated tasks; approving one runs `createConnecteamUser` (no activation SMS —
   `sendActivation` defaults false), links the returned `userId` onto the employee, and audits
   `ACCESS_GRANTED`. Offboarding archives the user (reversible) and audits `ACCESS_REVOKED`.

Requirements: the employee must have a phone (E.164) on their record (the Connecteam user's primary
identifier). Without it the task is honestly `blocked` ("phone required").

## B) Replay systems — capture an endpoint once (Goodshuffle / Quo / Slack)

These have no official create-user API. The only automatable path is the CLAUDE.md pattern: replay the
system's **own internal request** from inside a logged-in admin session. The endpoint is **not invented** —
it is captured once from a real admin action. Until then the constant is `null`, the adapter reports
`manual`, and the drainer no-ops the op.

Steps to codify one (do this per system, per action):

1. Sign in to the system's admin UI as a full admin
   (Goodshuffle `https://pro.goodshuffle.com`, Quo `https://my.openphone.com`, Slack `https://app.slack.com`).
2. Open the browser DevTools **Network** tab (record, preserve log).
3. Perform the action **once by hand** on a TEST user: invite a member (provision) or disable/remove a
   member (revoke).
4. Find the XHR/fetch that performed it. Note its **method**, **same-origin path**, and **request body**
   (JSON or form-encoded).
5. Fill the matching constant in `src/lib/people/provisioningEndpoints.ts`:
   ```ts
   goodshuffle: {
     origin: "https://pro.goodshuffle.com",
     provision: { method: "POST", path: "/app/…/invite", bodyType: "form" }, // ← captured
     revoke: null,
   },
   ```
6. Shape the enqueued op's `payload.data` to match the captured body (the drainer sends `payload.data` as
   the request body). The op already carries `{ displayName, firstName, lastName, email, phone, role }`;
   adjust the drainer's body-building in `src/lib/gsPull.ts` (and the `extension/pull-injected.js` mirror
   for Goodshuffle) if the captured request needs a different field mapping.
7. Done: `mode()` returns `automated`, and the drainer replays the request from the logged-in session.

Drainer locations:
- **Goodshuffle** drains in the office auto-pull (`src/lib/gsPull.ts buildOfficePullScript`) and the
  `extension/pull-injected.js` content script — both run in the logged-in `pro.goodshuffle.com` tab
  (same origin).
- **Quo / Slack** run on their own origins. `credentials:"include"` only reaches same-origin, so these
  replay from a logged-in Quo/Slack tab (their own content script or bookmarklet reusing the same handler),
  not from the Goodshuffle pull.

## Testing

Always test replay writes on throwaway TEST accounts first (as CLAUDE.md requires for Goodshuffle). The
adapters are covered by `src/lib/people/adapters/adapters.test.ts` and the Connecteam client by
`src/lib/connecteam.provision.test.ts`.
