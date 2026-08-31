package com.zoeevents.dispatch.kiosk

import android.app.Application
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageInstaller
import android.os.Build
import android.util.Log
import android.webkit.WebView

/**
 * Application entry point. Kept intentionally tiny — the kiosk is a WebView shell.
 *
 * Responsibilities:
 *   • WebView remote debugging in debug builds (chrome://inspect) — never in release.
 *   • Listen for OTA install results so the self-updater can complete. On a device-
 *     owner tablet the install is silent; when the app is NOT device owner the system
 *     asks us to show the installer confirm screen, which we launch here.
 */
class KioskApp : Application() {

    override fun onCreate() {
        super.onCreate()
        if (BuildConfig.DEBUG) {
            WebView.setWebContentsDebuggingEnabled(true)
        }
        val filter = IntentFilter(OtaUpdater.INSTALL_ACTION)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(installStatusReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            registerReceiver(installStatusReceiver, filter)
        }
    }

    private val installStatusReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            when (val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, Int.MIN_VALUE)) {
                PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                    // Not device owner → the OS needs the user to confirm. Launch its
                    // installer prompt. (On a device-owner kiosk this branch never runs
                    // because the install is auto-approved and silent.)
                    val confirm =
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                            intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
                        } else {
                            @Suppress("DEPRECATION")
                            intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)
                        }
                    confirm?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    if (confirm != null) startActivity(confirm)
                }
                PackageInstaller.STATUS_SUCCESS ->
                    Log.i(TAG, "OTA install succeeded")
                else ->
                    Log.w(
                        TAG,
                        "OTA install status=$status ${intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)}",
                    )
            }
        }
    }

    companion object {
        private const val TAG = "ZoeKioskOTA"
    }
}
