# Branded customer tracking link (`track.zoeeventsdmv.com`)

The customer "on the way" SMS carries a live‑tracking link. By default it points at the app's own
origin (`https://zoe-dispatch.fly.dev/track/<token>`), which looks unbranded in a text and is more
likely to be carrier‑spam‑filtered. This makes the link use a **branded domain** instead.

The page is unchanged: `/track/<token>` still shows the live‑GPS ETA + map, and still **upgrades to
Zonar's live Ignition map** the moment that stop's etaLink is minted. Only the hostname changes.

## Code (done)
`createTracking()` builds the link from **`TRACK_BASE_URL`** when set, else the request /
`PUBLIC_BASE_URL` origin (so nothing breaks before the domain is wired):

```ts
const base = (process.env.TRACK_BASE_URL || baseUrl).replace(/\/$/, "");
const url = `${base}/track/${token}`;
```

## Infra (one‑time, you run these)
The branded host must resolve to this same Fly app so `/track/<token>` is served there.

1. **DNS** — at the `zoeeventsdmv.com` registrar, add a CNAME:
   `track.zoeeventsdmv.com  CNAME  zoe-dispatch.fly.dev`
   (If the DNS host can't CNAME a subdomain, use the A/AAAA records Fly prints in step 2.)

2. **Fly certificate** — issue a cert for the subdomain:
   ```bash
   flyctl certs add track.zoeeventsdmv.com -a zoe-dispatch
   flyctl certs show track.zoeeventsdmv.com -a zoe-dispatch   # wait until it shows "Ready"
   ```

3. **Point the app at it** — set the secret and deploy:
   ```bash
   flyctl secrets set TRACK_BASE_URL=https://track.zoeeventsdmv.com -a zoe-dispatch
   ```

4. **Verify** — open `https://track.zoeeventsdmv.com/track/<any-recent-token>`; it should load the
   tracking page (and redirect to the Ignition map if that stop is minted). New on‑the‑way texts will
   then carry the branded link.

## Notes
- The path stays `/track/<token>`, so the URL reads `track.zoeeventsdmv.com/track/<token>`. If you'd
  rather drop the redundant `/track` segment (e.g. `track.zoeeventsdmv.com/<token>`), that needs a small
  route alias — ask and I'll add it.
- This is cosmetic/deliverability polish. The real lever for getting the **Ignition** link into the text
  (vs this fallback) is minting the stop's link *before* the text fires — see the Ignition mint‑latency
  finding (the office session drains the mint queue in sporadic batches, so most links aren't minted in
  time). Tracked separately.
