package com.zoeevents.dispatch.kiosk

import android.content.Context
import android.content.SharedPreferences

/**
 * Runtime configuration for the kiosk.
 *
 * Defaults come from [BuildConfig] (set at build time from `kiosk.properties` / env,
 * see app/build.gradle.kts). On top of that, each value may be OVERRIDDEN at runtime
 * without rebuilding — handy for pointing a single APK at a staging URL, or rotating
 * the exit PIN on a deployed tablet. Overrides are written to SharedPreferences and
 * can be pushed over adb, e.g.:
 *
 *   adb shell am broadcast -a com.zoeevents.dispatch.kiosk.SET_CONFIG \
 *       --es app_url https://staging.zoe-dispatch.fly.dev
 *
 * (See [BootReceiver] for where such a config broadcast could be wired; the plumbing
 * here is the single source of truth the Activity reads.)
 *
 * Mirrors the Electron shell's env-var config (APP_URL / GSPRO_URL / EXIT_PIN, plus
 * IGNITION_URL for the hidden ETA-link session and UNHIDE_PIN to reveal it).
 */
object Config {
    private const val PREFS = "zoe_kiosk_config"

    const val KEY_APP_URL = "app_url"
    const val KEY_GSPRO_URL = "gspro_url"
    const val KEY_IGNITION_URL = "ignition_url"
    const val KEY_EXIT_PIN = "exit_pin"
    const val KEY_UNHIDE_PIN = "unhide_pin"

    private fun prefs(ctx: Context): SharedPreferences =
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /** Zoe Dispatch web app (the Next.js PWA) loaded in the primary WebView. */
    fun appUrl(ctx: Context): String =
        prefs(ctx).getString(KEY_APP_URL, null)?.trimEnd('/') ?: BuildConfig.APP_URL.trimEnd('/')

    /** Goodshuffle Pro — the operational site shown side-by-side. */
    fun gsproUrl(ctx: Context): String =
        prefs(ctx).getString(KEY_GSPRO_URL, null) ?: BuildConfig.GSPRO_URL

    /** Zonar Ignition — loaded in the HIDDEN WebView to hold a logged-in session for
     *  ETA-link generation. */
    fun ignitionUrl(ctx: Context): String =
        prefs(ctx).getString(KEY_IGNITION_URL, null) ?: BuildConfig.IGNITION_URL

    /** PIN that releases lock-task mode (mirrors the Electron EXIT_PIN, default 1379). */
    fun exitPin(ctx: Context): String =
        prefs(ctx).getString(KEY_EXIT_PIN, null) ?: BuildConfig.EXIT_PIN

    /** PIN that reveals the hidden Ignition WebView for sign-in / troubleshooting
     *  (default 1379). */
    fun unhidePin(ctx: Context): String =
        prefs(ctx).getString(KEY_UNHIDE_PIN, null) ?: BuildConfig.UNHIDE_PIN

    /** Persist a runtime override for one of the KEY_* values above. */
    fun set(ctx: Context, key: String, value: String) {
        prefs(ctx).edit().putString(key, value).apply()
    }
}
