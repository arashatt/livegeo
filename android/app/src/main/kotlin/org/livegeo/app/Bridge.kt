package org.livegeo.app

import android.webkit.JavascriptInterface

/**
 * What the map page may ask of the app, as `window.LivegeoApp`
 * (public/lib/app-bridge.js is the page's side). Only the map may: the web
 * view loads nothing else, and every call is also checked against the page
 * actually on screen. Calls arrive on a web view thread, so anything that
 * touches the screen is handed to the main one.
 */
class Bridge(private val activity: MainActivity) {
    @JavascriptInterface
    fun version(): String = BuildConfig.VERSION_NAME

    /** {"on":…, "until":…, "paired":…}: the Go live button's state. */
    @JavascriptInterface
    fun sharing(): String = if (activity.trusted()) activity.sharingJson() else "{}"

    @JavascriptInterface
    fun toggleSharing() {
        if (activity.trusted()) activity.runOnUiThread { activity.toggleSharing() }
    }

    @JavascriptInterface
    fun buzz(kind: String?) {
        if (activity.trusted()) activity.runOnUiThread { Sfx.play(activity, kind.orEmpty()) }
    }

    /** A file the page made (a day's GPX), saved where the person chooses. */
    @JavascriptInterface
    fun saveFile(name: String?, mime: String?, base64: String?) {
        if (!activity.trusted() || base64 == null) return
        activity.runOnUiThread { activity.saveFile(name.orEmpty().ifBlank { "livegeo" }, mime.orEmpty(), base64) }
    }

    /** navigator.share, which a web view does not have: text, a link, or a file. */
    @JavascriptInterface
    fun share(json: String?) {
        if (!activity.trusted() || json == null) return
        activity.runOnUiThread { activity.share(json) }
    }
}
