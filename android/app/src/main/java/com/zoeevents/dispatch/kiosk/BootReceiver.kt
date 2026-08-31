package com.zoeevents.dispatch.kiosk

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * Relaunch the kiosk after a reboot.
 *
 * On a device-owner tablet the truck may lose power or be restarted; we want it to
 * come straight back into the kiosk with no human tapping the icon. When the system
 * broadcasts BOOT_COMPLETED we start [KioskActivity], which re-enters lock task.
 *
 * (On a non-owner device this receiver is harmless — Android may not deliver
 * BOOT_COMPLETED to an app that has never been launched, and screen pinning cannot
 * be resumed automatically anyway. True auto-relaunch requires device owner.)
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return
        if (action == Intent.ACTION_BOOT_COMPLETED ||
            action == Intent.ACTION_LOCKED_BOOT_COMPLETED
        ) {
            Log.i(TAG, "Boot completed — relaunching kiosk")
            val launch = Intent(context, KioskActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(launch)
        }
    }

    companion object {
        private const val TAG = "ZoeKioskBoot"
    }
}
