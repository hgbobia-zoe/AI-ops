# Zoe Dispatch — Kiosk Shell (Electron)

A thin desktop wrapper that runs **Zoe Dispatch** fullscreen on a truck tablet with
**Goodshuffle Pro embedded in the same split view** — not a second window.

## Why a shell at all

Goodshuffle sends `X-Frame-Options: SAMEORIGIN`, so a normal browser refuses to
render it inside our split pane. Electron is a real Chromium we control: the main
process strips that one header at the network layer (`onHeadersReceived`), and our
existing `/kiosk` split view (Goodshuffle iframe + dispatch panel) renders as one
screen. Web security stays on; login stays live; cookies persist across restarts.

The shell is deliberately tiny — all the UI is the Next.js app. It only provides:

- **In-pane embedding** — strips `X-Frame-Options` / CSP `frame-ancestors`.
- **Persistent login** — a `persist:zoe-kiosk` session partition keeps the
  Goodshuffle sign-in between shifts (driver logs in once).
- **Kiosk hardening** — fullscreen, no menu, no accidental close, screen stays awake.

## Run it (dev)

```bash
cd kiosk-shell
npm install
# Point at your running app (the Docker demo is on 8085):
APP_URL=http://localhost:8085 npm run dev      # windowed
APP_URL=http://localhost:8085 npm start        # true kiosk fullscreen
```

On Windows PowerShell:

```powershell
$env:APP_URL="http://localhost:8085"; npm start
```

First launch: sign into Goodshuffle in the left pane once. It stays logged in.

## Package for a tablet

```bash
cd kiosk-shell
npm install
npm run dist            # Windows .exe installer (nsis) in dist/
# npm run dist:mac      # macOS .dmg
# npm run dist:linux    # Linux AppImage
```

Set `APP_URL` to the **deployed** Zoe Dispatch URL (Fly.io / Railway) when building
for real trucks, e.g. via a `.env` or the machine's environment before launch.

## Config (env vars)

| Var | Default | Meaning |
|-----|---------|---------|
| `APP_URL` | `http://localhost:8085` | Zoe Dispatch base URL |
| `GSPRO_URL` | `https://pro.goodshuffle.com` | Goodshuffle origin (login persistence) |
| `KIOSK` | on | `0` = windowed for development |
| `EXIT_PIN` | `1379` | Guards the hard-quit shortcut (`Ctrl+Shift+Q`) |

The Goodshuffle URL the app frames is set on the app side via `NEXT_PUBLIC_GSPRO_URL`
(defaults to the dashboard).
