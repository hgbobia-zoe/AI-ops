# Zoe Dispatch Kiosk — ProGuard/R8 rules.

# The JavaScript bridge is called by name from JS running in the WebView. R8 must
# not rename or strip the @JavascriptInterface methods, or window.ZoeKiosk.* breaks.
-keepclassmembers class com.zoeevents.dispatch.kiosk.KioskJsBridge {
    @android.webkit.JavascriptInterface <methods>;
}

# Keep the BootReceiver — referenced from the manifest and instantiated by the OS.
-keep class com.zoeevents.dispatch.kiosk.BootReceiver { *; }

# WebView + JS interface plumbing.
-keepattributes JavascriptInterface
-keepattributes *Annotation*
