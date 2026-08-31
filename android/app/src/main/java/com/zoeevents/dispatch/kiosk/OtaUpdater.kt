package com.zoeevents.dispatch.kiosk

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/**
 * Over-the-air self-update for the NATIVE shell.
 *
 * Most updates never come through here: the dispatch UI is a web app loaded from the
 * server, so features/fixes ship the moment the server is deployed — no APK change.
 * This handles the rare case where the native APK itself changes (JS bridge, kiosk
 * behavior, WebView settings).
 *
 * Flow: poll {appUrl}/api/kiosk/latest → if its versionCode is newer than the running
 * build, download the signed APK, verify its sha256, and install. As DEVICE OWNER the
 * install is SILENT (no prompt, no touch — true OTA); otherwise the system installer
 * surfaces for a one-tap confirm. The APK is always signed with the same Zoe key, so
 * Android accepts it as an in-place update.
 */
object OtaUpdater {
    private const val TAG = "ZoeKioskOTA"
    const val INSTALL_ACTION = "com.zoeevents.dispatch.kiosk.OTA_INSTALL_STATUS"

    @Volatile private var checking = false

    /**
     * Check on a background thread. Safe to call repeatedly; no-ops while one runs.
     * [onResult] (optional) is invoked once with a short human status for a manual
     * "Check for updates" menu action.
     */
    fun checkInBackground(context: Context, onResult: ((String) -> Unit)? = null) {
        if (checking) {
            onResult?.invoke("An update check is already running…")
            return
        }
        checking = true
        val app = context.applicationContext
        Thread({
            try {
                runCheck(app, onResult)
            } catch (t: Throwable) {
                Log.w(TAG, "OTA check failed: ${t.message}")
                onResult?.invoke("Update check failed: ${t.message}")
            } finally {
                checking = false
            }
        }, "zoe-ota").start()
    }

    private fun runCheck(context: Context, onResult: ((String) -> Unit)?) {
        val manifestUrl = Config.appUrl(context).trimEnd('/') + "/api/kiosk/latest"
        val conn = (URL(manifestUrl).openConnection() as HttpURLConnection).apply {
            connectTimeout = 15_000
            readTimeout = 15_000
            requestMethod = "GET"
        }
        try {
            val current = BuildConfig.VERSION_CODE
            when (val code = conn.responseCode) {
                204 -> { Log.d(TAG, "no OTA published"); onResult?.invoke("You're on the latest version."); return }
                200 -> {}
                else -> { Log.w(TAG, "manifest HTTP $code"); onResult?.invoke("Update check failed (HTTP $code)."); return }
            }
            val m = JSONObject(conn.inputStream.bufferedReader().use { it.readText() })
            val latest = m.getInt("versionCode")
            val latestName = m.optString("versionName")
            if (latest <= current) { Log.d(TAG, "up to date (v$current)"); onResult?.invoke("You're on the latest version (v$latestName)."); return }

            Log.i(TAG, "OTA available: v$current -> v$latest (${latestName})")
            onResult?.invoke("Update v$latestName found — downloading…")
            val apk = download(context, m.getString("url"))
            if (apk == null) { onResult?.invoke("Update download failed."); return }
            val want = m.getString("sha256").lowercase()
            val got = sha256(apk)
            if (!got.equals(want, ignoreCase = true)) {
                Log.e(TAG, "sha256 mismatch (want $want got $got) — aborting")
                apk.delete()
                onResult?.invoke("Update failed verification.")
                return
            }
            install(context, apk, latest)
            onResult?.invoke("Installing v$latestName — approve the prompt if asked.")
        } finally {
            conn.disconnect()
        }
    }

    private fun download(context: Context, url: String): File? {
        val out = File(context.filesDir, "update.apk")
        val conn = (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 15_000
            readTimeout = 60_000
            requestMethod = "GET"
        }
        try {
            if (conn.responseCode != 200) {
                Log.w(TAG, "download HTTP ${conn.responseCode}")
                return null
            }
            conn.inputStream.use { input -> out.outputStream().use { input.copyTo(it) } }
            return out
        } finally {
            conn.disconnect()
        }
    }

    private fun sha256(file: File): String {
        val md = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { s ->
            val buf = ByteArray(8192)
            var n = s.read(buf)
            while (n >= 0) {
                md.update(buf, 0, n)
                n = s.read(buf)
            }
        }
        return md.digest().joinToString("") { "%02x".format(it) }
    }

    private fun install(context: Context, apk: File, versionCode: Int) {
        val installer = context.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(
            PackageInstaller.SessionParams.MODE_FULL_INSTALL,
        )
        val sessionId = installer.createSession(params)
        installer.openSession(sessionId).use { session ->
            apk.inputStream().use { input ->
                session.openWrite("zoe-ota", 0, apk.length()).use { out ->
                    input.copyTo(out)
                    session.fsync(out)
                }
            }
            val intent = Intent(INSTALL_ACTION).setPackage(context.packageName)
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or
                (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0)
            val pending = PendingIntent.getBroadcast(context, sessionId, intent, flags)
            session.commit(pending.intentSender)
        }
        Log.i(TAG, "OTA install committed for v$versionCode")
    }
}
