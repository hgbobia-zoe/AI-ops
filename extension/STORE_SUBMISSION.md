# Chrome Web Store submission — Zoe Auto-Pull (unlisted)

Goal: publish the extension **unlisted** so it **auto-updates** on the office machine. After this, every
code change I ship reaches the office browser silently within a few hours. The only time Chrome still
prompts is when a new *host permission* is added (rare) — a one-time "accept" then.

## What's already prepped (in `extension/`)
- `icon-16.png`, `icon-48.png`, `icon-128.png` (rendered from `public/icon.svg`) and wired into `manifest.json`.
- Manifest at **v1.6.0** (the store rejects an upload whose version isn't higher than the live one, so each
  resubmission must bump `version`).
- A store-ready zip is at `public/zoe-autopull-extension.zip` (same file the `/admin/pull` download serves).
  You can upload exactly that.

## One-time setup
1. Go to the **Chrome Web Store Developer Dashboard** (`chrome.google.com/webstore/devconsole`), sign in
   with the Google account you want to own this, and pay the **one-time $5** registration fee.
2. You also need a **public privacy-policy URL** (the store requires one for an extension that reads data).
   Simplest: host the text in the "Privacy policy" section below at a stable URL (e.g. a page on the Zoe
   site, or a public gist). Paste that URL into the listing.

## Upload + listing
1. **New item** → upload `public/zoe-autopull-extension.zip`.
2. **Visibility: Unlisted** (only people with the link can install; not searchable).
3. Listing fields:
   - **Name:** Zoe Auto-Pull + Opportunity Radar
   - **Summary (132 char max):** Syncs a rental business's own Goodshuffle routes and Instawork shifts into its Zoe Ops dashboard.
   - **Category:** Workflow & Planning (or Productivity)
   - **Detailed description:** (paste)
     > Zoe Auto-Pull keeps a rental company's Zoe Ops dashboard in sync with its own Goodshuffle and
     > Instawork accounts. Running in a browser already signed into those tools, it reads the company's
     > routes, bookings and temp-labor shifts on a schedule and sends them to the company's own Zoe Ops
     > instance, so dispatch, scheduling, risk and finance stay current with no manual exports. Office
     > machine only. It reads only the signed-in operator's own business data and sends it only to that
     > company's Zoe Ops app.
   - **Single purpose:** Sync the operator's own Goodshuffle and Instawork business data into their Zoe Ops dashboard.
4. **Privacy practices** — declare data use honestly:
   - Reads **website content** of pro.goodshuffle.com, app.instawork.com and ignition.zonarsystems.com (the business's own operational data).
   - Does **not** collect personal browsing history, does **not** sell or share data, sends data **only** to the business's own Zoe Ops instance.
   - **Permission justifications** (paste each):
     - `scripting` — injects the read-only sync into the already-signed-in Goodshuffle/Instawork tab.
     - `tabs` — opens and manages a background tab to run the scheduled sync without the operator babysitting one.
     - `storage` — stores the sync settings (which Zoe Ops URL, interval) and the last-sync status for the badge.
     - `activeTab` — acts on the current tab when the operator clicks the toolbar button to sync now.
     - `alarms` — schedules the periodic sync.
     - Host `pro.goodshuffle.com` — read the company's own routes and bookings to sync.
     - Host `app.instawork.com` — read the company's own temp-labor shifts to sync.
     - Host `ignition.zonarsystems.com` — using the operator's own signed-in Zonar Ignition session, create Zonar's own live-tracking ETA links for the company's deliveries (so the customer gets a real live map), reading the session's own auth token from that page only.
     - Host `wrfalckup5gc3flo7bizcsfmiq.appsync-api.us-east-1.amazonaws.com` — Zonar Ignition's own GraphQL API endpoint, called exactly as the Ignition web app does to create those ETA links.
     - Host `zoe-dispatch.fly.dev` — send the synced data (and minted ETA links) to the company's own Zoe Ops app.
5. Submit for review. Unlisted review is usually a few days.

## After it's approved — one coordination step
Publishing to the store **may assign a new extension ID** (different from the current unpacked
`mpneeiibeccfhenemglnfenogbgmkiep`). The app targets the extension by ID in two places, so once it's live:
1. Copy the **Item ID** from the dashboard.
2. Send it to me — I update `EXTENSION_ID` in `src/lib/extensionId.ts` and redeploy, so the Dispatch
   "Pull routes" / "Re-sync" buttons keep reaching the extension.
3. On the office machine, **install the store version** (from the unlisted link) and **remove the unpacked
   one**, so there's one extension going forward and it auto-updates from then on.

## Privacy policy (host this text at a public URL)
> **Zoe Auto-Pull privacy policy.** Zoe Auto-Pull runs in the browser of an authorized operator at a
> rental company that uses Zoe Ops. Using the operator's own signed-in sessions, it reads that company's
> operational data from Goodshuffle (routes, bookings) and Instawork (temp-labor shifts) and transmits it
> only to that company's own Zoe Ops instance to keep its dispatch, scheduling and finance views current.
> It does not collect personal browsing history, does not track individuals, and does not sell or share
> any data with third parties. Data handling within Zoe Ops is governed by Zoe Ops' own agreement with the
> company. Questions: <add a contact email>.

## Note for selling this later
This listing is **unlisted and Zoe-specific** (name, the `zoe-dispatch.fly.dev` default endpoint, and the
Goodshuffle vehicle-name mappings in `pull-injected.js` / `gsPull.ts` are hardcoded to Zoe). Productizing
for other rental companies needs a **separate, rebranded, multi-tenant** version: a configurable Zoe Ops
endpoint (already read from `chrome.storage`, so partly there), tenant-configurable truck mappings, and a
public (not unlisted) store listing. Tracked in the backlog — do not block the Zoe rollout on it.
