# Security — inbound webhooks & authentication

## Inbound webhooks (what is authenticated, how, and what happens on failure)

Any inbound endpoint that can modify Zoe's data or trigger an action authenticates itself. The server
never trusts the network; secrets live only in Fly secrets (server-side) — never in browser code.

| Endpoint | Auth method | On failure | Logged |
|---|---|---|---|
| `POST /api/openphone/webhook` (Quo calls + inbound SMS) | **HMAC-SHA256 signature** over `<timestamp>.<rawBody>` using the webhook signing key, compared in constant time (`verifyOpenphoneSignature`). | **401 "Webhook rejected — authentication failed."** — no data written. | A `WEBHOOK_REJECTED` row in `audit_logs` (actor `quo-webhook`, reason, whether a signature header was present). |
| `POST /api/gs/projects`, `/api/gs/notes`, `/api/gs/outbox`, `/api/route/import` (office pull ingest) | Shared token `GS_INGEST_TOKEN` in `x-publish-token`, plus CORS locked to `https://pro.goodshuffle.com`. | 401 `unauthorized`. | `import_log`. |
| Console + all `/api/salesos/*`, `/admin`, `/api/finance`, `/api/settings` | Signed session cookie (`APP_SESSION_TOKEN`), role-gated in `src/proxy.ts`. | 401 / redirect to `/login`. | Sales actions → `audit_logs` (per-person once login is on). |

### Quo (OpenPhone) signature verification — details
- The signing key is issued by Quo when the webhook is created; store it as the Fly secret
  `OPENPHONE_WEBHOOK_SECRET` (or the admin `openphone.signingKey`). It is read server-side only.
- **Fail-open only until the key is set:** with no key configured the endpoint accepts unsigned posts
  (setup window). The moment a key exists, every request must carry a valid `openphone-signature` or it
  is rejected with 401 and logged. This lets you stand the webhook up, confirm real events arrive, then
  lock it down by setting the secret — with zero downtime.
- To enable enforcement: create/copy the signing secret from the Quo webhook page →
  `fly secrets set OPENPHONE_WEBHOOK_SECRET="<secret>" -a zoe-dispatch`.

## Failure states (never fabricate a fallback)
- Quo unavailable → message not sent; the send returns an explicit error, nothing is logged as sent.
- Goodshuffle write-back can't run server-side (Cloudflare) → queued in `gs_outbox`, applied by a
  logged-in session; never silently dropped.
- Webhook signature invalid → 401 + `WEBHOOK_REJECTED` audit row.
- AI unavailable → deterministic fallback (heuristic/template), labelled as such; never a hallucinated result.

## Secrets
All credentials are Fly secrets, write-only from the admin UI, never returned to the client in
plaintext: `APP_SESSION_TOKEN`, `OWNER_PASSWORD`, `OPENPHONE_API_KEY`, `OPENPHONE_WEBHOOK_SECRET`,
`SLACK_WEBHOOK_URL`, `SLACK_ALERT_WEBHOOK_URL`, `GS_INGEST_TOKEN`, `ANTHROPIC_API_KEY`.
