package com.zoeevents.dispatch.kiosk

import android.util.Log
import android.webkit.JavascriptInterface

/**
 * JavaScript bridge injected into the DISPATCH WebView as `window.ZoeKiosk`.
 *
 * Purpose: the Zoe Dispatch web app runs the driver-facing UI, but the DATA it needs
 * lives inside two OTHER logged-in browser sessions on this same tablet:
 *   • Goodshuffle Pro — route/order data.
 *   • Zonar Ignition  — live truck telematics, used to mint a customer ETA-share link.
 * Both sites are behind Cloudflare + real logins, so the only reliable way to read
 * them is from a real logged-in Chromium — which is exactly what the Goodshuffle and
 * (hidden) Ignition WebViews are.
 *
 * This bridge is the PLUMBING that lets the dispatch page reach into those sessions:
 * it runs JS inside them via [BridgeHost.evalInGoodshuffle] / [BridgeHost.evalInIgnition]
 * and returns the result asynchronously to the dispatch page.
 *
 * ── Async contract (JS side) ────────────────────────────────────────────────────
 * Every call takes a `requestId`. When the native side has a result it invokes, in
 * the dispatch page:
 *
 *     window.__zoeKioskResolve(requestId, resultJsonString)
 *
 * so the web app can wrap each call in a Promise:
 *
 *     ZoeKiosk._call = (fn, ...args) => new Promise((resolve) => {
 *       const id = String(Math.random());
 *       (window.__zoeKioskPending ||= {})[id] = resolve;
 *       ZoeKiosk[fn](id, ...args);
 *     });
 *     window.__zoeKioskResolve = (id, json) => {
 *       const r = window.__zoeKioskPending?.[id];
 *       if (r) { delete window.__zoeKioskPending[id]; r(JSON.parse(json)); }
 *     };
 *
 * NOTE: @JavascriptInterface methods are invoked on a WebView binder thread, NOT the
 * UI thread. [BridgeHost] implementations MUST hop to the UI thread before touching
 * any WebView.
 */
class KioskJsBridge(private val host: BridgeHost) {

    /** What the Activity provides to the bridge. All calls may arrive off the UI thread. */
    interface BridgeHost {
        /** Run [script] inside the Goodshuffle WebView; deliver its JSON result to [requestId]. */
        fun evalInGoodshuffle(requestId: String, script: String)

        /** Run [script] inside the hidden Ignition WebView; deliver its JSON result to [requestId]. */
        fun evalInIgnition(requestId: String, script: String)

        /** Resolve a pending call back in the dispatch page via window.__zoeKioskResolve. */
        fun resolve(requestId: String, resultJson: String)

        /**
         * Mint a Zonar ETA link inside the logged-in Ignition WebView and resolve its
         * public URL to [requestId]. [paramsJson] carries what the mutation needs from
         * the dispatch side (unitId, address, lat/lng, eta, active window). The notify
         * number is forced to the Zoe main line by the host — never the customer.
         */
        fun createEtaLink(requestId: String, paramsJson: String)

        /**
         * Extract today's route for [truckId] from the logged-in Goodshuffle WebView and
         * resolve the normalized stops to [requestId] (shape ready for /api/route/import).
         */
        fun importGoodshuffleRoute(requestId: String, truckId: String)

        /** Run an on-demand OTA update check; resolve a short status message to [requestId]. */
        fun checkForUpdate(requestId: String)

        /**
         * Enter full-screen dispatch-board mode: the dispatch WebView (now showing
         * /dispatch) takes the left half, the live Ignition map fills the right half,
         * and Goodshuffle is hidden. For the office display. Fire-and-forget.
         */
        fun openDispatchBoard()

        /**
         * Open the native admin panel: switch the Goodshuffle / Ignition logins on this
         * tablet (sign out the current account so a different one can sign in), or open
         * web settings. Gated on the web side by the admin code.
         */
        fun openAdminPanel()

        /** Sign the current Goodshuffle account out of this tablet (confirm, then clear
         *  its session) so a different one can sign in. */
        fun switchGoodshuffleLogin()

        /** Sign the current Ignition account out of this tablet (confirm, then clear its
         *  session) and reveal Ignition so a different one can sign in. */
        fun switchIgnitionLogin()

        /** Attempt to leave lock-task mode; returns true if the PIN matched. */
        fun requestExit(pin: String): Boolean
    }

    // ── Simple health check ────────────────────────────────────────────────────
    @JavascriptInterface
    fun ping(): String = "zoe-kiosk-ok"

    @JavascriptInterface
    fun log(message: String) {
        Log.d(TAG, "web: $message")
    }

    // ── Generic escape hatches: run arbitrary JS in the companion sessions ──────
    // The dispatch page can use these directly for one-off extraction while the
    // higher-level helpers below are still stubbed.
    @JavascriptInterface
    fun evalInGoodshuffle(requestId: String, script: String) {
        host.evalInGoodshuffle(requestId, script)
    }

    // Runs [script] inside the HIDDEN Ignition WebView (its own logged-in Zonar
    // session) and resolves the JSON result back to the dispatch page. Mirrors
    // evalInGoodshuffle — this is how createEtaLink() will drive Ignition once built.
    @JavascriptInterface
    fun evalInIgnition(requestId: String, script: String) {
        host.evalInIgnition(requestId, script)
    }

    // ── Kiosk exit ─────────────────────────────────────────────────────────────
    @JavascriptInterface
    fun requestExit(pin: String): Boolean = host.requestExit(pin)

    // ── High-level helpers — PLUMBING ONLY, EXTRACTION LOGIC IS A STUB ──────────

    /**
     * STUB. Import the current route/orders from the logged-in Goodshuffle session.
     *
     * PLAN (not yet implemented):
     *   1. Navigate/confirm the Goodshuffle WebView is on the RMS dashboard/route view.
     *   2. evaluateJavascript() a scraper (or replay Goodshuffle's own internal
     *      GraphQL/REST call using the session cookies already in the WebView) to pull
     *      the ordered list of stops: order id, customer, address, window, items.
     *   3. Normalise to the dispatch app's Route JSON shape and resolve(requestId, json).
     *
     * Implemented against the captured contract (see android/GOODSHUFFLE_ROUTE.md):
     * lists the truck's routes for today, enriches each via getRoute, and returns the
     * ordered stops (warehouse legs dropped) as {"ok":true,"stops":[...]}.
     */
    @JavascriptInterface
    fun importGoodshuffleRoute(requestId: String, truckId: String) {
        Log.i(TAG, "importGoodshuffleRoute(truckId=$truckId) called")
        host.importGoodshuffleRoute(requestId, truckId)
    }

    /**
     * STUB. Create a shareable customer ETA link for a truck from the Ignition session.
     *
     * ⚠️ CRITICAL — the notify phone on the ETA MUST be the Zoe main line
     * (BuildConfig.ETA_NOTIFY_PHONE = 301-291-5296), NEVER the customer's number.
     * Zonar sends its OWN unbranded text to whatever number is attached to the ETA, so
     * using the customer's number would blast them an off-brand Zonar message. The
     * customer only ever gets our BRANDED Quo SMS, which carries this link — this ETA
     * is created purely to mint the URL; its own Zonar notification points at us.
     *
     * Implemented against the captured contract (see android/IGNITION_ETALINK.md).
     * [paramsJson] = {"unitId":Int,"address":String,"latitude":Float,"longitude":Float,
     * "etaHours":String?,"startISO":String?,"endISO":String?,"notes":String?}. The host
     * runs the createEtaLink mutation in the Ignition WebView (reusing its Cognito
     * session) and resolves {"ok":true,"url":"https://ignition.zonarsystems.com/etaLink/<code>","code":...}.
     */
    @JavascriptInterface
    fun createEtaLink(requestId: String, paramsJson: String) {
        Log.i(TAG, "createEtaLink() called")
        host.createEtaLink(requestId, paramsJson)
    }

    @JavascriptInterface
    fun checkForUpdate(requestId: String) {
        Log.i(TAG, "checkForUpdate() called")
        host.checkForUpdate(requestId)
    }

    /**
     * Switch the shell into full-screen dispatch-board mode (board + live Ignition
     * side-by-side, Goodshuffle hidden). Gated on the web side by a 4-digit code; the
     * native side just performs the layout change.
     */
    @JavascriptInterface
    fun openDispatchBoard() {
        Log.i(TAG, "openDispatchBoard() called")
        host.openDispatchBoard()
    }

    /** Open the native admin panel (switch Goodshuffle / Ignition logins). */
    @JavascriptInterface
    fun openAdminPanel() {
        Log.i(TAG, "openAdminPanel() called")
        host.openAdminPanel()
    }

    /** Switch the Goodshuffle login on this tablet (confirm + sign out). */
    @JavascriptInterface
    fun switchGoodshuffleLogin() {
        Log.i(TAG, "switchGoodshuffleLogin() called")
        host.switchGoodshuffleLogin()
    }

    /** Switch the Ignition login on this tablet (confirm + sign out). */
    @JavascriptInterface
    fun switchIgnitionLogin() {
        Log.i(TAG, "switchIgnitionLogin() called")
        host.switchIgnitionLogin()
    }

    companion object {
        /** The name this object is exposed under in the dispatch WebView. */
        const val NAME = "ZoeKiosk"
        private const val TAG = "ZoeKioskBridge"
    }
}
