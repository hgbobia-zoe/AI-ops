#!/usr/bin/env bash
# Publish the built release APK as an OTA update.
#
# Every tablet checks in on launch and every 6h; within that window they download,
# verify, and (as device owner) SILENTLY install the new build. Nothing to touch on
# the tablets.
#
# Prereqs:
#   1. Build the release APK first:  (see android/README or DEPLOY.md)
#        gradle assembleRelease         → app/build/outputs/apk/release/app-release.apk
#   2. Bump versionCode in app/build.gradle.kts BEFORE building, or tablets won't see
#      it as newer.
#   3. Set the publish token (a Fly secret you also set on the server):
#        export KIOSK_PUBLISH_TOKEN=...   # must match Fly secret KIOSK_PUBLISH_TOKEN
#
# Usage:   ./publish-ota.sh "optional release notes"
set -euo pipefail
cd "$(dirname "$0")"

APK="app/build/outputs/apk/release/app-release.apk"
[ -f "$APK" ] || { echo "APK not found at $APK — build it with 'gradle assembleRelease' first"; exit 1; }

VC="$(grep -oE 'versionCode[[:space:]]*=[[:space:]]*[0-9]+' app/build.gradle.kts | grep -oE '[0-9]+' | head -1)"
VN="$(grep -oE 'versionName[[:space:]]*=[[:space:]]*"[^"]+"' app/build.gradle.kts | sed -E 's/.*"([^"]+)".*/\1/' | head -1)"
: "${KIOSK_PUBLISH_TOKEN:?set KIOSK_PUBLISH_TOKEN (must match the Fly secret)}"
BASE="${BASE:-https://zoe-dispatch.fly.dev}"
NOTES="${1:-}"

echo "Publishing v$VC ($VN) to $BASE ..."
curl -fSs -X POST "$BASE/api/kiosk/publish" \
  -H "x-publish-token: $KIOSK_PUBLISH_TOKEN" \
  -F "apk=@$APK" \
  -F "versionCode=$VC" \
  -F "versionName=$VN" \
  -F "notes=$NOTES"
echo
echo "Done. Tablets will update within ~6h (or on next launch)."
