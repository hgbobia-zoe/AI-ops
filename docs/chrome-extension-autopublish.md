# Auto-publishing the Auto-Pull extension to the Chrome Web Store

Merge a version bump to `main` and the new extension build goes to the Chrome Web Store automatically; every
installed browser (yours, Lisa's, the office machine) then auto-updates within a few hours. No dashboard
upload, no manual reload.

The workflow is [`.github/workflows/publish-extension.yml`](../.github/workflows/publish-extension.yml). It is
**inert until the four secrets below are set** — it logs "secrets not set, skipping" and does nothing.

## How it works

- **Trigger:** a push to `main` that touches `extension/**` or `scripts/build-extension.mjs`.
- **Version gate:** it reads `extension/manifest.json` version. If a git tag `ext-v<version>` already exists,
  it skips (nothing to publish). After a successful publish it creates that tag, so a given version publishes
  exactly once.
- **Keyless store build:** it runs `node scripts/build-extension.mjs --store`, which strips the manifest
  `key`. The committed key resolves to the retired *unpacked* id (`mpneeiibe…`); the Web Store owns the
  published id (`amjncl…`) and rejects an upload that carries a mismatched key.
- **Publish:** `chrome-webstore-upload-cli upload --auto-publish` to the store item. Unlisted stays unlisted.
- **PR guard:** on a PR that changes the extension without bumping the manifest version, CI fails with a clear
  message — so a forgotten bump is caught before merge (a same-version upload would be skipped and the store
  rejects it anyway).

The released version is therefore controlled by two deliberate human acts: **bump `manifest.json` version**
in the PR, and **merge the PR**. Nothing publishes on its own.

## One-time setup (≈15 min, do once)

You need a Google account that is a developer/owner on the extension's Web Store listing.

1. **Google Cloud project + API**
   - Go to <https://console.cloud.google.com/>, create a project (any name).
   - APIs & Services → Library → enable **Chrome Web Store API**.
2. **OAuth consent screen**
   - APIs & Services → OAuth consent screen → User type **External** → fill the required app name/email →
     save. Add your Google account under **Test users**.
3. **OAuth client**
   - APIs & Services → Credentials → Create credentials → **OAuth client ID** → application type
     **Desktop app**. Copy the **Client ID** and **Client secret**.
4. **Get a refresh token** (one-time, from your own machine):
   - In a browser, open this URL with your client id substituted, approve access, and copy the `code=` value
     from the redirect:
     ```
     https://accounts.google.com/o/oauth2/auth?response_type=code&scope=https://www.googleapis.com/auth/chromewebstore&access_type=offline&redirect_uri=urn:ietf:wg:oauth:2.0:oob&client_id=YOUR_CLIENT_ID
     ```
     (If Google shows the "oob" flow as unavailable, use `redirect_uri=http://localhost` and copy the `code`
     query param from the localhost URL it bounces to.)
   - Exchange the code for a refresh token:
     ```bash
     curl -s "https://oauth2.googleapis.com/token" \
       -d "client_id=YOUR_CLIENT_ID" \
       -d "client_secret=YOUR_CLIENT_SECRET" \
       -d "code=THE_CODE" \
       -d "grant_type=authorization_code" \
       -d "redirect_uri=urn:ietf:wg:oauth:2.0:oob"
     ```
     Copy the `refresh_token` from the JSON response.
5. **Add four repo secrets** (GitHub → repo → Settings → Secrets and variables → Actions → New repository
   secret):
   | Secret | Value |
   |---|---|
   | `CWS_CLIENT_ID` | the OAuth client id |
   | `CWS_CLIENT_SECRET` | the OAuth client secret |
   | `CWS_REFRESH_TOKEN` | the refresh token from step 4 |
   | `CWS_EXTENSION_ID` | `amjnclgiidnijgedjhhfbcflofnmicbj` (the store item id) |

That's it. The next version bump merged to `main` publishes automatically.

## Everyday use

- Change the extension, **bump `extension/manifest.json` version**, open a PR, merge it. Done.
- Watch it under the repo's **Actions → Publish extension**.
- **Re-publish the same version** (rare): Actions → Publish extension → Run workflow → `force: true`.
- **Manual fallback** (if secrets are ever unset): `node scripts/build-extension.mjs --store --out store.zip`
  and upload `store.zip` on the Web Store dashboard. The old `C:\Git\zoe-autopull-extension` unpacked drop is
  no longer the live path post-cutover (its key maps to the retired id); the store build is what ships.

## Notes

- The Web Store reviews updates before they go live; unlisted minor updates are usually fast. The workflow
  submits for publishing; the store controls the actual rollout timing.
- Credentials never touch the app or the office machine — they live only in GitHub Actions secrets.
