package com.zoeevents.dispatch.kiosk

import android.os.Bundle
import android.text.InputType
import android.util.Log
import android.view.WindowManager
import android.webkit.WebView
import android.widget.EditText
import android.widget.FrameLayout
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.constraintlayout.widget.ConstraintLayout
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.zoeevents.dispatch.kiosk.databinding.ActivityKioskBinding
import org.json.JSONObject

/**
 * The kiosk. Hosts three WebViews — the visible dispatch app + Goodshuffle split, and
 * a HIDDEN Ignition WebView kept alive for ETA-link generation (revealable via a
 * PIN-gated gesture) — hardens the tablet into a locked single-app appliance, and
 * bridges the dispatch page to the logged-in Goodshuffle / Ignition sessions.
 *
 * Android counterpart of kiosk-shell/main.js (Electron):
 *   • fullscreen + always-on   ↔ immersive sticky + FLAG_KEEP_SCREEN_ON.
 *   • no accidental exit        ↔ lock task mode + blocked back + PIN gate.
 *   • persistent logins         ↔ CookieManager persistence (WebViewFactory).
 */
class KioskActivity : AppCompatActivity(), KioskJsBridge.BridgeHost {

    private lateinit var binding: ActivityKioskBinding

    // Transient WebView hosting an auth popup (Sign in with Google, etc.), if any.
    private var popupWebView: WebView? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Draw edge-to-edge; we hide the system bars below.
        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        binding = ActivityKioskBinding.inflate(layoutInflater)
        setContentView(binding.root)

        configureWebViews()
        wireExitGesture()
        wireIgnitionReveal()
        wireAttention()
        wireBoardMode()
        blockBack()
        enterLockTask()

        loadContent(savedInstanceState)
        scheduleOtaChecks()
        scheduleSessionChecks()
    }

    // ── OTA self-update ────────────────────────────────────────────────────────

    private val otaHandler = android.os.Handler(android.os.Looper.getMainLooper())
    private val otaTick = object : Runnable {
        override fun run() {
            OtaUpdater.checkInBackground(this@KioskActivity)
            otaHandler.postDelayed(this, OTA_INTERVAL_MS)
        }
    }

    /** Check for a newer native shell now (a few seconds after launch) and every 6h. */
    private fun scheduleOtaChecks() {
        otaHandler.postDelayed(otaTick, 8_000)
    }

    // ── WebView wiring ─────────────────────────────────────────────────────────

    private fun configureWebViews() {
        // Dispatch app — hosts the ZoeKiosk bridge.
        WebViewFactory.configure(binding.dispatchWebView, "dispatch") { resultMsg ->
            hostPopup(resultMsg)
        }
        // Our OWN app is deployed frequently — never serve a stale cached copy (a stale
        // build silently breaks the JS bridge). Always fetch it fresh from the network.
        // (Goodshuffle / Ignition keep the default cache for their sessions + speed.)
        binding.dispatchWebView.settings.cacheMode = android.webkit.WebSettings.LOAD_NO_CACHE
        binding.dispatchWebView.addJavascriptInterface(
            KioskJsBridge(this),
            KioskJsBridge.NAME,
        )

        // Goodshuffle — real logged-in session, popups allowed for SSO.
        // Re-probe the session whenever it finishes loading so the attention banner
        // clears the instant sign-in completes (not on the next 60s tick).
        WebViewFactory.configure(
            binding.gsproWebView,
            "goodshuffle",
            onOpenPopup = { resultMsg -> hostPopup(resultMsg) },
            onPageFinished = { checkSessions() },
        )

        // Ignition — hidden but alive, holds a logged-in Zonar session for ETA links.
        WebViewFactory.configure(binding.ignitionWebView, "ignition") { resultMsg ->
            hostPopup(resultMsg)
        }
    }

    private fun loadContent(savedInstanceState: Bundle?) {
        if (savedInstanceState != null &&
            binding.dispatchWebView.restoreState(savedInstanceState) != null
        ) {
            // WebViews restored their own history across the config change.
            return
        }
        // Signal the app it's inside the kiosk shell (parity with the Electron
        // preload's __ZOE_KIOSK_EMBED__), and land on the /kiosk split surface.
        val appUrl = Config.appUrl(this) + "/kiosk?embed=1&native=android"
        binding.dispatchWebView.loadUrl(appUrl)
        binding.gsproWebView.loadUrl(Config.gsproUrl(this))
        // The hidden Ignition WebView loads immediately so its session is warm and
        // signed in whenever createEtaLink() needs it.
        binding.ignitionWebView.loadUrl(Config.ignitionUrl(this))
    }

    // ── Auth popups ────────────────────────────────────────────────────────────

    /**
     * Host a target=_blank / window.open popup (typically an OAuth window) in a modal
     * dialog with its own WebView, then tear it down when it closes. Mirrors the
     * Electron shell allowing webview popups as small child windows.
     */
    private fun hostPopup(resultMsg: android.os.Message): Boolean {
        val popup = WebView(this)
        WebViewFactory.configure(popup, "popup")
        popupWebView = popup

        val container = FrameLayout(this).apply { addView(popup) }
        val dialog = AlertDialog.Builder(this)
            .setView(container)
            .setOnDismissListener {
                popup.destroy()
                if (popupWebView === popup) popupWebView = null
            }
            .create()
        dialog.show()

        popup.webChromeClient = object : android.webkit.WebChromeClient() {
            override fun onCloseWindow(window: WebView?) {
                if (dialog.isShowing) dialog.dismiss()
            }
        }

        // Point the transport at our popup WebView so the engine drives it.
        val transport = resultMsg.obj as WebView.WebViewTransport
        transport.webView = popup
        resultMsg.sendToTarget()
        return true
    }

    // ── BridgeHost: run JS in the companion sessions, resolve back to dispatch ──

    override fun evalInGoodshuffle(requestId: String, script: String) {
        evalIn(binding.gsproWebView, requestId, script)
    }

    override fun evalInIgnition(requestId: String, script: String) {
        evalIn(binding.ignitionWebView, requestId, script)
    }

    private fun evalIn(target: WebView, requestId: String, script: String) {
        // @JavascriptInterface calls arrive off the UI thread — hop back on.
        runOnUiThread {
            target.evaluateJavascript(script) { raw ->
                // evaluateJavascript hands back a JSON-encoded value (or "null").
                resolve(requestId, raw ?: "null")
            }
        }
    }

    override fun resolve(requestId: String, resultJson: String) {
        runOnUiThread {
            // resultJson is already a JSON literal; embed it as the 2nd arg. Guard the
            // callback's existence so an early call can't throw in the page.
            val idLiteral = JSONObject.quote(requestId)
            val js = "window.__zoeKioskResolve && window.__zoeKioskResolve($idLiteral, $resultJson);"
            binding.dispatchWebView.evaluateJavascript(js, null)
        }
    }

    // ── ETA link creation (Zonar) ──────────────────────────────────────────────
    // Runs the captured `createEtaLink` mutation inside the logged-in Ignition WebView
    // (reusing its Cognito session — the auth token lives in that page's localStorage,
    // and is never exposed to us). Because the mutation is an async fetch and
    // evaluateJavascript can't await a Promise, we kick off the fetch (which stashes its
    // result on window.__zoeEta[requestId]) and then poll that global until it's ready.
    // See android/IGNITION_ETALINK.md for the full contract.

    override fun createEtaLink(requestId: String, paramsJson: String) {
        // Force the notify number to the Zoe main line — NEVER the customer (see
        // BuildConfig.ETA_NOTIFY_PHONE / IGNITION_ETALINK.md).
        val notify = normalizeE164(BuildConfig.ETA_NOTIFY_PHONE)
        val start = buildEtaStartScript(requestId, paramsJson, notify)
        runOnUiThread {
            binding.ignitionWebView.evaluateJavascript(start, null)
            pollWebResult(binding.ignitionWebView, "__zoeEta", requestId, tries = 0)
        }
    }

    override fun importGoodshuffleRoute(requestId: String, truckId: String) {
        val start = buildGoodshuffleScript(requestId, truckId)
        runOnUiThread {
            binding.gsproWebView.evaluateJavascript(start, null)
            pollWebResult(binding.gsproWebView, "__gsRoute", requestId, tries = 0)
        }
    }

    override fun checkForUpdate(requestId: String) {
        OtaUpdater.checkInBackground(this) { msg ->
            val json = JSONObject().put("ok", true).put("message", msg).toString()
            resolve(requestId, json) // resolve() hops to the UI thread + the dispatch page
        }
    }

    override fun openDispatchBoard() {
        runOnUiThread { enterBoardMode() }
    }

    override fun openAdminPanel() {
        runOnUiThread { showAdminPanel() }
    }

    // ── Admin panel (switch companion logins / open web settings) ───────────────
    // The Goodshuffle and Ignition logins live in their WebView sessions on this tablet.
    // "Switch login" signs the current account out of just that site (clears its cookies
    // + web storage) and reloads it to its sign-in, so a different account can sign in —
    // without disturbing the other site's session. Reached from the dispatch ⋯ menu
    // (admin-code gated on the web side).

    private fun showAdminPanel() {
        val items = arrayOf(
            "Open settings (templates, Ignition link…)",
            "Switch Goodshuffle login",
            "Switch Ignition login",
        )
        AlertDialog.Builder(this)
            .setTitle(R.string.admin_title)
            .setItems(items) { _, which ->
                when (which) {
                    0 -> {
                        if (boardMode) exitBoardMode()
                        binding.dispatchWebView.loadUrl(Config.appUrl(this) + "/admin")
                    }
                    1 -> switchGoodshuffleLogin()
                    2 -> switchIgnitionLogin()
                }
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    // Direct entry points (also callable from the web /admin via the bridge): each shows
    // a confirm, then signs that one site out on this tablet.
    override fun switchGoodshuffleLogin() {
        runOnUiThread { confirmSwitchLogin("Goodshuffle") { doSwitchGoodshuffleLogin() } }
    }

    override fun switchIgnitionLogin() {
        runOnUiThread { confirmSwitchLogin("Ignition") { doSwitchIgnitionLogin() } }
    }

    private fun confirmSwitchLogin(name: String, onConfirm: () -> Unit) {
        AlertDialog.Builder(this)
            .setTitle("Switch $name login")
            .setMessage("Sign the current $name account out of this tablet so a different one can sign in?")
            .setNegativeButton(R.string.cancel, null)
            .setPositiveButton("Sign out") { _, _ -> onConfirm() }
            .show()
    }

    private fun doSwitchGoodshuffleLogin() {
        if (boardMode) exitBoardMode()
        signOutWebView(binding.gsproWebView, Config.gsproUrl(this))
        // Goodshuffle is the visible pane; a fresh load lands on its sign-in.
        attentionShowing = true
        lastGsBad = true
        sessionHandler.postDelayed({ checkSessions() }, 2_000)
    }

    private fun doSwitchIgnitionLogin() {
        signOutWebView(binding.ignitionWebView, Config.ignitionUrl(this))
        // Reveal Ignition full-screen so the operator can sign the new account in.
        showIgnition()
    }

    /**
     * Sign a companion site out of its WebView: clear that origin's cookies AND web
     * storage (Ignition's Cognito token lives in localStorage, not a cookie), then
     * reload the site so it shows its login. Scoped to this one origin so the other
     * companion session is untouched.
     */
    private fun signOutWebView(webView: WebView, url: String) {
        clearCookiesFor(url)
        webView.evaluateJavascript(
            "try{localStorage.clear();sessionStorage.clear();}catch(e){}",
        ) {
            // Reload only after storage is cleared, so the new page starts signed-out.
            webView.loadUrl(url)
        }
    }

    /** Expire the visible cookies for [url]'s origin (host + dot-host). Best-effort. */
    private fun clearCookiesFor(url: String) {
        try {
            val cm = android.webkit.CookieManager.getInstance()
            val host = android.net.Uri.parse(url).host ?: return
            val existing = cm.getCookie(url) ?: ""
            for (pair in existing.split(";")) {
                val name = pair.substringBefore("=").trim()
                if (name.isEmpty()) continue
                cm.setCookie(url, "$name=; Max-Age=0; Path=/")
                cm.setCookie(url, "$name=; Max-Age=0; Path=/; Domain=$host")
                cm.setCookie(url, "$name=; Max-Age=0; Path=/; Domain=.$host")
            }
            cm.flush()
            Log.i(TAG, "cleared cookies for $host")
        } catch (t: Throwable) {
            Log.w(TAG, "clearCookiesFor failed: ${t.message}")
        }
    }

    // ── Dispatch-board mode (office display) ────────────────────────────────────
    // Full-screen board + live Ignition side-by-side. Reuses the already-alive Ignition
    // WebView (its logged-in Zonar session) rather than iframing it — Ignition blocks
    // embedding, so a native WebView is the only way to show it beside the board. Toggled
    // from the dispatch app's ⋯ menu (PIN-gated on the web side); "Driver view" returns.

    @Volatile private var boardMode = false

    private fun wireBoardMode() {
        binding.exitBoardButton.setOnClickListener { exitBoardMode() }
    }

    private fun enterBoardMode() {
        if (boardMode) return
        boardMode = true

        // Dispatch board takes the LEFT half.
        binding.dispatchWebView.loadUrl(Config.appUrl(this) + "/dispatch?embed=1&native=android")
        (binding.dispatchWebView.layoutParams as ConstraintLayout.LayoutParams).apply {
            startToStart = ConstraintLayout.LayoutParams.PARENT_ID
            startToEnd = ConstraintLayout.LayoutParams.UNSET
            endToEnd = ConstraintLayout.LayoutParams.UNSET
            endToStart = R.id.boardGuideline
            binding.dispatchWebView.layoutParams = this
        }

        // Live Ignition map fills the RIGHT half (its overlay, re-constrained + revealed).
        (binding.ignitionOverlay.layoutParams as ConstraintLayout.LayoutParams).apply {
            startToStart = R.id.boardGuideline
            endToEnd = ConstraintLayout.LayoutParams.PARENT_ID
            binding.ignitionOverlay.layoutParams = this
        }
        binding.ignitionOverlay.visibility = android.view.View.VISIBLE
        binding.hideIgnitionButton.visibility = android.view.View.GONE // "Driver view" replaces it

        binding.gsproWebView.visibility = android.view.View.GONE
        binding.attentionBanner.visibility = android.view.View.GONE

        binding.exitBoardButton.visibility = android.view.View.VISIBLE
        binding.exitBoardButton.bringToFront()
        applyImmersive()
    }

    private fun exitBoardMode() {
        if (!boardMode) return
        boardMode = false

        binding.exitBoardButton.visibility = android.view.View.GONE

        // Restore Ignition to a hidden, full-size overlay (session stays alive).
        binding.ignitionOverlay.visibility = android.view.View.INVISIBLE
        (binding.ignitionOverlay.layoutParams as ConstraintLayout.LayoutParams).apply {
            startToStart = ConstraintLayout.LayoutParams.PARENT_ID
            endToEnd = ConstraintLayout.LayoutParams.PARENT_ID
            binding.ignitionOverlay.layoutParams = this
        }
        binding.hideIgnitionButton.visibility = android.view.View.VISIBLE

        // Goodshuffle back, dispatch back to the right quarter + driver view.
        binding.gsproWebView.visibility = android.view.View.VISIBLE
        (binding.dispatchWebView.layoutParams as ConstraintLayout.LayoutParams).apply {
            startToStart = ConstraintLayout.LayoutParams.UNSET
            startToEnd = R.id.splitGuideline
            endToStart = ConstraintLayout.LayoutParams.UNSET
            endToEnd = ConstraintLayout.LayoutParams.PARENT_ID
            binding.dispatchWebView.layoutParams = this
        }
        binding.dispatchWebView.loadUrl(Config.appUrl(this) + "/kiosk?embed=1&native=android")
        applyImmersive()
        // Re-probe sessions so the attention banner returns if a login is missing.
        sessionHandler.postDelayed({ checkSessions() }, 1_000)
    }

    /**
     * Generic async-result poller. The start script stashes its result on
     * window[globalVar][requestId]; we poll that global on [webView] until it appears
     * (or we time out) and resolve it back to the dispatch page.
     */
    private fun pollWebResult(webView: WebView, globalVar: String, requestId: String, tries: Int) {
        if (tries > WEB_RESULT_MAX_TRIES) {
            resolve(requestId, """{"ok":false,"error":"timeout"}""")
            return
        }
        val idLiteral = JSONObject.quote(requestId)
        val probe = "(window.$globalVar && window.$globalVar[$idLiteral]) || null"
        webView.evaluateJavascript(probe) { raw ->
            if (raw != null && raw != "null") {
                resolve(requestId, raw) // already a JSON-encoded object
                webView.evaluateJavascript("try{delete window.$globalVar[$idLiteral]}catch(e){}", null)
            } else {
                binding.root.postDelayed(
                    { pollWebResult(webView, globalVar, requestId, tries + 1) },
                    WEB_RESULT_POLL_MS,
                )
            }
        }
    }

    /**
     * JS that mints the ETA link and stashes the result on window.__zoeEta[requestId].
     * Params from the dispatch page: {unitId:Int, address:String, latitude?, longitude?,
     * etaHours?, startISO?, endISO?, notes?}. If lat/lng are absent it geocodes the
     * address with the Ignition page's own google.maps, so the web side only needs
     * {unitId, address}.
     */
    private fun buildEtaStartScript(requestId: String, paramsJson: String, notify: String): String {
        val idLit = JSONObject.quote(requestId)
        val notifyLit = JSONObject.quote(notify)
        // paramsJson is a JSON object literal from the dispatch page; embed it directly.
        return """
        (function(){
          window.__zoeEta = window.__zoeEta || {};
          var ID = $idLit;
          function fail(m){ try { window.__zoeEta[ID] = {ok:false, error:String(m).slice(0,300)}; } catch(x){} }
          try {
            var P = $paramsJson;
            var token = null;
            try { token = localStorage.getItem("IdToken"); } catch(e){}
            if (!token) { return fail("no_ignition_session"); }
            if (P.unitId == null) { return fail("no_unit_id"); }

            function withLatLng(cb){
              if (P.latitude != null && P.longitude != null) { return cb(P.latitude, P.longitude); }
              if (window.google && google.maps && google.maps.Geocoder) {
                try {
                  new google.maps.Geocoder().geocode({ address: P.address }, function(res, status){
                    if (status === "OK" && res && res[0]) { var loc = res[0].geometry.location; cb(loc.lat(), loc.lng()); }
                    else { fail("geocode_" + status); }
                  });
                } catch(e) { fail("geocode_ex:" + e); }
              } else { fail("no_geocoder_and_no_latlng"); }
            }

            withLatLng(function(lat, lng){
              var now = Date.now();
              var vars = {
                unitId: P.unitId, entityId: P.unitId, entityName: "Unit",
                address: P.address, latitude: lat, longitude: lng,
                eta: (P.etaHours != null ? String(P.etaHours) : "0.2"),
                sharedWith: { contacts: [], emails: [], sms: [$notifyLit] },
                scheduleSnapshot: false,
                dateRange: { start: (P.startISO || new Date(now).toISOString()), end: (P.endISO || new Date(now + 8*3600*1000).toISOString()) },
                notes: (P.notes || null)
              };
              var query = "mutation createEtaLink(${'$'}unitId: Int!, ${'$'}entityId: Int!, ${'$'}entityName: String!, ${'$'}landmarkId: Int, ${'$'}address: String!, ${'$'}latitude: Float!, ${'$'}longitude: Float!, ${'$'}sharedWith: SharedWithInput!, ${'$'}eta: String, ${'$'}scheduleSnapshot: Boolean, ${'$'}dateRange: AWSDateTimeRange!, ${'$'}notes: String) { etaLink: createEtaLink(unitId: ${'$'}unitId, entityId: ${'$'}entityId, entityName: ${'$'}entityName, landmarkId: ${'$'}landmarkId, address: ${'$'}address, latitude: ${'$'}latitude, longitude: ${'$'}longitude, sharedWith: ${'$'}sharedWith, eta: ${'$'}eta, scheduleSnapshot: ${'$'}scheduleSnapshot, dateRange: ${'$'}dateRange, notes: ${'$'}notes) { id code status __typename } }";
              fetch("$ETA_GRAPHQL_URL", {
                method: "POST",
                headers: { "authorization": token, "app-id": "px-cloud", "app-version": "1.0.160", "package-name": "cloud-react", "content-type": "application/json", "accept": "*/*" },
                body: JSON.stringify({ query: query, variables: vars })
              }).then(function(r){ return r.json(); }).then(function(j){
                var code = j && j.data && j.data.etaLink && j.data.etaLink.code;
                if (code) { window.__zoeEta[ID] = {ok:true, code:code, url:"https://ignition.zonarsystems.com/etaLink/"+code}; }
                else { fail((JSON.stringify((j&&j.errors)||j)||"no_code")); }
              }).catch(function(e){ fail(e); });
            });
          } catch(e) { fail(e); }
        })();
        """.trimIndent()
    }

    /**
     * JS that reads today's route for [truckId] from Goodshuffle and stashes normalized
     * stops on window.__gsRoute[requestId]. Same-origin fetches reuse the WebView's
     * session. See android/GOODSHUFFLE_ROUTE.md for the captured contract.
     */
    private fun buildGoodshuffleScript(requestId: String, truckId: String): String {
        val idLit = JSONObject.quote(requestId)
        // Which Goodshuffle vehicle title this truck maps to.
        val match = when {
            truckId.contains("E450", true) || truckId.contains("ford", true) -> "ford"
            truckId.contains("NPR", true) || truckId.contains("isuzu", true) -> "isuzu"
            else -> truckId.lowercase()
        }
        val matchLit = JSONObject.quote(match)
        return """
        (function(){
          window.__gsRoute = window.__gsRoute || {};
          var ID = $idLit;
          function fail(m){ try { window.__gsRoute[ID] = {ok:false, error:String(m).slice(0,300)}; } catch(x){} }
          function done(stops, routes, total, matched){ window.__gsRoute[ID] = {ok:true, stops:stops, routeNames:routes, total:total, matched:matched}; }
          try {
            var MATCH = $matchLit;
            var now = new Date();
            var startLocal = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0,0,0);
            var endLocal = new Date(startLocal.getTime() + 24*3600*1000);
            var body = { from:startLocal.toISOString(), to:endLocal.toISOString(), warehouseCanonicalIDs:null, crew:null, vehicles:null, statuses:null };

            function extractStops(route){
              var wps = (route.waypoints||[]).filter(function(w){ return !w.isOriginWarehouse && !w.isDestinationWarehouse; });
              wps.sort(function(a,b){ return (a.waypointIndex||0) - (b.waypointIndex||0); });
              return wps.map(function(w){
                var tl = (w.logisticRelation && w.logisticRelation.targetLocation) || {};
                var tx = w.transaction || {};
                var line = [tl.streetAddressLine1, tl.streetAddressLine2].filter(Boolean).join(" ");
                var cityState = [tl.city, tl.state].filter(Boolean).join(", ");
                var address = [line, cityState, tl.zipCode].filter(Boolean).join(", ");
                // The customer's phone lives on the inlined renter (includeAttributes=true),
                // not the on-site location contact (usually blank). Prefer the validated
                // E.164 number, then the raw renter phone, then the on-site contact. Never
                // fall back to dispatcher/storeLocation — those are the Zoe staff/main line.
                var renter = tx.renter || {};
                var sv = renter.smsValidation || {};
                var name = tl.contactName || (tx.eventName ? String(tx.eventName).split(" - ")[0].trim() : "") || renter.name;
                var doc = tx.dayOfContact || null;
                var s = {
                  custName: name || "",
                  custFirstName: renter.firstName || undefined,
                  kind: (w.waypointType === "PICK_UP" ? "pickup" : "delivery"),
                  custPhone: sv.e164PhoneNumber || renter.phone || tl.contactPhoneNumber || "",
                  address: address,
                  plannedWindow: w.scheduledArrivalTime || undefined,
                  eta: w.scheduledArrivalTime || undefined
                };
                if (doc) { s.dayOfName = doc.name || doc.fullName || undefined; s.dayOfPhone = doc.phoneNumber || doc.phone || undefined; }
                return s;
              });
            }

            fetch("/app/routing/listRoutes", { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify(body), credentials:"include" })
              .then(function(r){ return r.json(); })
              .then(function(routes){
                var mine = (routes||[]).filter(function(rt){ return rt.vehicle && String(rt.vehicle.title||"").toLowerCase().indexOf(MATCH) >= 0; });
                mine.sort(function(a,b){ return new Date(a.startDate) - new Date(b.startDate); });
                var total = (routes||[]).length;
                if (!mine.length) { done([], [], total, 0); return; }
                return Promise.all(mine.map(function(rt){
                  return fetch("/app/routing/getRoute?routeID=" + rt.id + "&includeAttributes=true", { headers:{accept:"application/json"}, credentials:"include" })
                    .then(function(r){ return r.json(); });
                })).then(function(full){
                  var stops = []; var names = [];
                  full.forEach(function(route){ names.push(route.name); stops = stops.concat(extractStops(route)); });
                  done(stops, names, total, mine.length);
                });
              })
              .catch(function(e){ fail(e); });
          } catch(e) { fail(e); }
        })();
        """.trimIndent()
    }

    /** 10-digit US number → +1XXXXXXXXXX; already-E.164 kept as-is. */
    private fun normalizeE164(raw: String): String {
        val digits = raw.filter { it.isDigit() }
        return when {
            raw.startsWith("+") -> raw
            digits.length == 10 -> "+1$digits"
            digits.length == 11 && digits.startsWith("1") -> "+$digits"
            else -> raw
        }
    }

    override fun requestExit(pin: String): Boolean {
        val ok = pin == Config.exitPin(this)
        if (ok) runOnUiThread { leaveKiosk() }
        return ok
    }

    // ── Immersive fullscreen ───────────────────────────────────────────────────

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) applyImmersive()
    }

    private fun applyImmersive() {
        val controller = WindowInsetsControllerCompat(window, binding.root)
        controller.hide(WindowInsetsCompat.Type.systemBars())
        controller.systemBarsBehavior =
            WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
    }

    // ── Lock task / pinning ────────────────────────────────────────────────────

    private fun enterLockTask() {
        // Screen pinning only — this app is NOT a device owner (deliberately, to avoid
        // the device-admin footprint that Play Protect removes and the factory-reset
        // provisioning). The system shows a one-time "pin this app?" confirmation; after
        // that Home/Recents/Back are gated. A stronger lock (no device owner) is to also
        // set this app as the default Home app — see the HOME intent-filter in the
        // manifest and README.
        try {
            startLockTask()
            Log.i(TAG, "Started screen pinning")
        } catch (t: Throwable) {
            // On some devices/emulators lock task is unavailable; run un-pinned but
            // still fullscreen so development isn't blocked.
            Log.w(TAG, "Lock task unavailable: ${t.message}")
        }
    }

    private fun leaveKiosk() {
        try {
            stopLockTask()
        } catch (t: Throwable) {
            Log.w(TAG, "stopLockTask failed: ${t.message}")
        }
        finish()
    }

    // ── Exit gesture + PIN ─────────────────────────────────────────────────────

    private fun wireExitGesture() {
        // Long-press the invisible top-left corner to reveal the PIN prompt. Matches
        // the Electron shell's guarded quit (Ctrl+Shift+Q → PIN).
        binding.exitHotspot.setOnLongClickListener {
            showPinPrompt()
            true
        }
    }

    private fun showPinPrompt() {
        val input = EditText(this).apply {
            inputType = InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD
            hint = getString(R.string.exit_pin_hint)
        }
        AlertDialog.Builder(this)
            .setTitle(R.string.exit_dialog_title)
            .setMessage(R.string.exit_dialog_message)
            .setView(input)
            .setNegativeButton(R.string.cancel, null)
            .setPositiveButton(R.string.exit_confirm) { _, _ ->
                if (input.text.toString() == Config.exitPin(this)) {
                    leaveKiosk()
                } else {
                    AlertDialog.Builder(this)
                        .setMessage(R.string.exit_wrong_pin)
                        .setPositiveButton(android.R.string.ok, null)
                        .show()
                }
            }
            .show()
    }

    // ── Ignition reveal (PIN-gated) ────────────────────────────────────────────

    // ── Login/session health — loud, self-healing attention banner ─────────────
    // Any missing/expired login (Goodshuffle or Ignition) is surfaced immediately with a
    // one-tap fix, instead of silently degrading (Goodshuffle route import stops working;
    // Ignition ETA links fall back to the plain /track link). Re-checked on a timer and
    // on resume, so an expiry mid-shift pops the banner back up.

    private val sessionHandler = android.os.Handler(android.os.Looper.getMainLooper())
    // True while the attention banner is up. Goodshuffle signs in via an in-page (SPA)
    // transition that fires NO page-load event, so onPageFinished alone can miss it —
    // while the banner is up we poll FAST (a completed login registers in ~3s); once
    // everything's signed in we back off to the slow interval.
    @Volatile private var attentionShowing = true
    // Goodshuffle's last known signed-OUT state, so we can catch the sign-in EDGE
    // (signed-out -> signed-in) and auto-refresh the route the instant it's available.
    private var lastGsBad = true
    private val sessionTick = object : Runnable {
        override fun run() {
            checkSessions()
            sessionHandler.postDelayed(this, if (attentionShowing) SESSION_CHECK_FAST_MS else SESSION_CHECK_MS)
        }
    }

    private fun wireAttention() {
        binding.fixGoodshuffleButton.setOnClickListener {
            // Goodshuffle lives in the visible left pane — reload it so its sign-in shows.
            binding.gsproWebView.loadUrl(Config.gsproUrl(this))
            // Resume fast polling + probe shortly after, so the login registers promptly.
            attentionShowing = true
            sessionHandler.postDelayed({ checkSessions() }, 1_500)
        }
        binding.fixIgnitionButton.setOnClickListener {
            // Ignition is the hidden pane — reveal it full-screen to sign in.
            showIgnition()
        }
    }

    private fun scheduleSessionChecks() {
        // First check a few seconds after launch so the WebViews have loaded.
        sessionHandler.postDelayed(sessionTick, 6_000)
    }

    /** Probe both companion sessions and update the attention banner. */
    private fun checkSessions() {
        // Don't nag while the operator is actively signing into Ignition.
        if (isIgnitionVisible()) return

        // Goodshuffle: signed out if its WebView sits on an auth/login URL.
        binding.gsproWebView.evaluateJavascript(
            "(function(){try{var p=location.pathname.toLowerCase();" +
                "return (p.indexOf('auth')>=0||p.indexOf('login')>=0||p.indexOf('signin')>=0)?'out':'ok';}catch(e){return 'unknown';}})()",
        ) { gs ->
            val gsBad = trimJs(gs) == "out"
            // Ignition: signed out if there's no un-expired Cognito IdToken in its storage.
            binding.ignitionWebView.evaluateJavascript(
                "(function(){try{var t=localStorage.getItem('IdToken');if(!t)return 'out';" +
                    "var p=JSON.parse(atob(t.split('.')[1]));return (p.exp&&p.exp*1000>Date.now())?'ok':'expired';}catch(e){return 'out';}})()",
            ) { ig ->
                val igState = trimJs(ig)
                val igBad = igState == "out" || igState == "expired"
                updateAttentionBanner(gsBad, igBad)
            }
        }
    }

    private fun updateAttentionBanner(gsBad: Boolean, igBad: Boolean) {
        // Goodshuffle just came back (sign-in completed): tell the dispatch app to refresh
        // its route now that the pull will work, instead of making the driver tap retry.
        // The web registers window.__zoeGoodshuffleReady; a no-op if it hasn't yet.
        if (lastGsBad && !gsBad) {
            binding.dispatchWebView.evaluateJavascript(
                "window.__zoeGoodshuffleReady && window.__zoeGoodshuffleReady();",
                null,
            )
        }
        lastGsBad = gsBad
        val show = gsBad || igBad
        // Drive the poll cadence: fast while anything needs sign-in, slow when all good.
        attentionShowing = show
        binding.attentionBanner.visibility = if (show) android.view.View.VISIBLE else android.view.View.GONE
        binding.fixGoodshuffleButton.visibility = if (gsBad) android.view.View.VISIBLE else android.view.View.GONE
        binding.fixIgnitionButton.visibility = if (igBad) android.view.View.VISIBLE else android.view.View.GONE
        val msg = when {
            gsBad && igBad -> "⚠ Goodshuffle and Ignition need sign-in — route import and ETA links are off"
            gsBad -> "⚠ Goodshuffle needs sign-in — route import is off"
            igBad -> "⚠ Ignition needs sign-in — customer ETA links are off"
            else -> ""
        }
        if (show) binding.attentionText.text = msg
        if (show) binding.attentionBanner.bringToFront()
    }

    /** evaluateJavascript hands back a JSON-quoted string; unwrap it to the raw value. */
    private fun trimJs(raw: String?): String =
        (raw ?: "").trim().removeSurrounding("\"")

    private fun wireIgnitionReveal() {
        // Long-press the invisible top-RIGHT corner (distinct from the top-left exit
        // hotspot) to reveal the hidden Ignition session behind a PIN.
        binding.revealHotspot.setOnLongClickListener {
            showRevealPrompt()
            true
        }
        binding.hideIgnitionButton.setOnClickListener { hideIgnition() }
    }

    private fun showRevealPrompt() {
        val input = EditText(this).apply {
            inputType = InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD
            hint = getString(R.string.reveal_pin_hint)
        }
        AlertDialog.Builder(this)
            .setTitle(R.string.reveal_dialog_title)
            .setMessage(R.string.reveal_dialog_message)
            .setView(input)
            .setNegativeButton(R.string.cancel, null)
            .setPositiveButton(R.string.reveal_confirm) { _, _ ->
                // Wrong (or empty) code does nothing — no error, no reveal.
                if (input.text.toString() == Config.unhidePin(this)) {
                    showIgnition()
                }
            }
            .show()
    }

    /** Bring the (already alive) Ignition WebView to the front as a full overlay. */
    private fun showIgnition() {
        // Hide the attention banner so it can't cover the overlay's "Done" button.
        binding.attentionBanner.visibility = android.view.View.GONE
        binding.ignitionOverlay.visibility = android.view.View.VISIBLE
        binding.ignitionOverlay.bringToFront()
        binding.hideIgnitionButton.bringToFront()
    }

    /** Re-hide Ignition. It stays attached + logged in; only its visibility changes. */
    private fun hideIgnition() {
        binding.ignitionOverlay.visibility = android.view.View.INVISIBLE
        applyImmersive()
        // Re-check a few times so the banner clears once the sign-in token lands.
        sessionHandler.postDelayed({ checkSessions() }, 800)
        sessionHandler.postDelayed({ checkSessions() }, 2_500)
    }

    private fun isIgnitionVisible(): Boolean =
        binding.ignitionOverlay.visibility == android.view.View.VISIBLE

    private fun blockBack() {
        // Back navigates the dispatch WebView when it has history; otherwise it is
        // swallowed so the driver can never back out of the kiosk.
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                when {
                    // In board mode, Back returns to the driver view.
                    boardMode -> exitBoardMode()
                    // If the Ignition overlay is up, Back navigates it / dismisses it.
                    isIgnitionVisible() -> {
                        if (binding.ignitionWebView.canGoBack()) {
                            binding.ignitionWebView.goBack()
                        } else {
                            hideIgnition()
                        }
                    }
                    binding.dispatchWebView.canGoBack() -> binding.dispatchWebView.goBack()
                    // else: consume — do nothing.
                }
            }
        })
    }

    // ── Lifecycle: persist cookies, pause/resume WebViews ──────────────────────

    override fun onPause() {
        super.onPause()
        // Persist Goodshuffle / Ignition / app cookies so logins survive a restart —
        // parity with the Electron persistent partition.
        WebViewFactory.flush()
        binding.dispatchWebView.onPause()
        binding.gsproWebView.onPause()
        binding.ignitionWebView.onPause()
    }

    override fun onResume() {
        super.onResume()
        binding.dispatchWebView.onResume()
        binding.gsproWebView.onResume()
        binding.ignitionWebView.onResume()
        applyImmersive()
        // A session may have expired while paused — re-check shortly after resuming.
        sessionHandler.postDelayed({ checkSessions() }, 2_000)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        binding.dispatchWebView.saveState(outState)
    }

    override fun onDestroy() {
        otaHandler.removeCallbacks(otaTick)
        sessionHandler.removeCallbacks(sessionTick)
        popupWebView?.destroy()
        binding.dispatchWebView.destroy()
        binding.gsproWebView.destroy()
        binding.ignitionWebView.destroy()
        super.onDestroy()
    }

    companion object {
        private const val TAG = "ZoeKioskActivity"
        private const val OTA_INTERVAL_MS = 6L * 60 * 60 * 1000 // 6 hours
        private const val ETA_GRAPHQL_URL =
            "https://wrfalckup5gc3flo7bizcsfmiq.appsync-api.us-east-1.amazonaws.com/graphql"
        private const val WEB_RESULT_POLL_MS = 500L
        private const val WEB_RESULT_MAX_TRIES = 40 // ~20s before giving up
        private const val SESSION_CHECK_MS = 60_000L // re-check logins every minute (all good)
        private const val SESSION_CHECK_FAST_MS = 3_000L // re-check every 3s while a sign-in is pending
    }
}
