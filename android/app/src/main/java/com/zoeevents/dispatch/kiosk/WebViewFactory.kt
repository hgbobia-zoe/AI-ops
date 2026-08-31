package com.zoeevents.dispatch.kiosk

import android.annotation.SuppressLint
import android.net.Uri
import android.os.Message
import android.util.Log
import android.view.View
import android.webkit.ConsoleMessage
import android.webkit.CookieManager
import android.webkit.GeolocationPermissions
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient

/**
 * Builds and configures the WebViews used across the kiosk.
 *
 * The settings here are what make real logins and Cloudflare bot checks work:
 *   • JS + DOM storage + database on, cache on.
 *   • Cookies (incl. third-party) accepted and persisted — this is why the driver
 *     signs into Goodshuffle / Ignition ONCE and stays logged in across restarts.
 *   • The WebView's DEFAULT user-agent is left untouched. Spoofing a desktop UA is
 *     exactly what trips Cloudflare / bot detection, so we don't.
 *   • Multiple windows + popups allowed so "Sign in with Google" style auth popups
 *     open instead of being silently dropped.
 *
 * This mirrors the Electron shell's persistent `persist:zoe-kiosk` partition and its
 * webview popup handling.
 */
object WebViewFactory {

    private const val TAG = "ZoeKioskWebView"

    /**
     * @param onOpenPopup called when the page requests a new window (target=_blank /
     *   window.open / auth popup). The host provides a transient WebView to host it.
     * @param onPageFinished called after each main-frame navigation completes. Used to
     *   re-probe login state the instant a companion app finishes loading (e.g. when
     *   Goodshuffle lands on its dashboard after sign-in), so the attention banner
     *   clears immediately instead of waiting for the periodic session check.
     */
    @SuppressLint("SetJavaScriptEnabled")
    fun configure(
        webView: WebView,
        label: String,
        // onPageFinished before onOpenPopup so existing trailing-lambda call sites
        // (configure(view, label) { resultMsg -> ... }) still bind to onOpenPopup.
        onPageFinished: ((url: String) -> Unit)? = null,
        onOpenPopup: ((resultMsg: Message) -> Boolean)? = null,
    ): WebView {
        // Accept cookies globally, including third-party — required for cross-domain
        // auth (SSO) and for Cloudflare's clearance cookie.
        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(webView, true)
        }

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            @Suppress("DEPRECATION")
            databaseEnabled = true
            javaScriptCanOpenWindowsAutomatically = true
            setSupportMultipleWindows(true)

            // Media (any embedded video / audio) may autoplay without a gesture.
            mediaPlaybackRequiresUserGesture = false

            cacheMode = WebSettings.LOAD_DEFAULT

            // Google refuses OAuth sign-in in WebViews that advertise the "; wv" token
            // in their user-agent ("disallowed_useragent" → blank/blocked login). The
            // drivers sign into Goodshuffle and Ignition with Google SSO, so strip just
            // that token — the UA otherwise stays the device's normal mobile-Chrome
            // string (so Cloudflare is still fine; we are NOT spoofing a desktop UA).
            userAgentString = userAgentString?.replace("; wv", "") ?: userAgentString

            loadWithOverviewMode = true
            useWideViewPort = true
            builtInZoomControls = true
            displayZoomControls = false
            setGeolocationEnabled(true)

            // Both apps are HTTPS; keep mixed content blocked for safety.
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        }

        webView.webViewClient = KioskWebViewClient(label, onPageFinished)
        webView.webChromeClient = KioskWebChromeClient(label, onOpenPopup)
        webView.setBackgroundColor(0xFF000000.toInt())
        return webView
    }

    /** Persist cookies + flush WebView storage. Call from the Activity's onPause. */
    fun flush() {
        CookieManager.getInstance().flush()
    }

    private class KioskWebViewClient(
        private val label: String,
        private val onPageFinished: ((url: String) -> Unit)? = null,
    ) : WebViewClient() {
        // Keep ALL navigation inside the WebView (do not hand off to an external
        // browser) so logins that bounce across SSO domains stay in-app and the
        // kiosk is never left. Returning false = let the WebView load the URL.
        override fun shouldOverrideUrlLoading(
            view: WebView,
            request: WebResourceRequest,
        ): Boolean {
            val scheme = request.url.scheme?.lowercase()
            // Only http/https load in-place; anything exotic (tel:, mailto:, intent:)
            // is simply ignored in a kiosk.
            return scheme != null && scheme != "http" && scheme != "https"
        }

        override fun onPageFinished(view: WebView, url: String) {
            onPageFinished?.invoke(url)
        }

        override fun onReceivedError(
            view: WebView,
            request: WebResourceRequest,
            error: android.webkit.WebResourceError,
        ) {
            if (request.isForMainFrame) {
                Log.w(TAG, "[$label] load error ${error.errorCode}: ${error.description}")
            }
        }
    }

    private class KioskWebChromeClient(
        private val label: String,
        private val onOpenPopup: ((Message) -> Boolean)?,
    ) : WebChromeClient() {

        // Grant geolocation (Goodshuffle may ask). Kiosk is trusted.
        override fun onGeolocationPermissionsShowPrompt(
            origin: String,
            callback: GeolocationPermissions.Callback,
        ) {
            callback.invoke(origin, true, true)
        }

        // Grant media/other web permissions requested by the trusted operational apps.
        override fun onPermissionRequest(request: PermissionRequest) {
            request.grant(request.resources)
        }

        override fun onCreateWindow(
            view: WebView,
            isDialog: Boolean,
            isUserGesture: Boolean,
            resultMsg: Message,
        ): Boolean {
            // Hand the popup up to the host so it can host the auth window and then
            // dismiss it. If the host can't, fall back to loading it in-place.
            return onOpenPopup?.invoke(resultMsg) ?: false
        }

        override fun onConsoleMessage(msg: ConsoleMessage): Boolean {
            if (BuildConfig.DEBUG) {
                Log.d(
                    TAG,
                    "[$label] ${msg.sourceId()}:${msg.lineNumber()} ${msg.message()}",
                )
            }
            return true
        }
    }
}
