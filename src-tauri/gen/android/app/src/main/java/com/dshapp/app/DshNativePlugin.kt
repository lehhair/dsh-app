package com.dshapp.app

import android.app.Activity
import android.os.Build
import android.view.WindowInsets
import android.webkit.CookieManager
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class SetCookieArgs {
  var origin: String? = null
  var cookie: String? = null
}

/**
 * Native bits the wry WebView cannot do itself:
 * - setCookie: wry's `set_cookie` is a no-op on Android; the app-global
 *   WebView CookieManager accepts the gateway session cookie before the
 *   remote dsh page loads.
 * - getStatusBarHeight: WebView < 140 reports wrong env(safe-area-inset-*)
 *   values under edge-to-edge, so the launcher/dsh pages read the real
 *   status-bar inset natively (CSS px) and pad themselves.
 */
@TauriPlugin
class DshNativePlugin(private val activity: Activity) : Plugin(activity) {

  @Command
  fun setCookie(invoke: Invoke) {
    val args = invoke.parseArgs(SetCookieArgs::class.java)
    val origin = args.origin ?: ""
    val cookie = args.cookie ?: ""
    val cookieManager = CookieManager.getInstance()
    cookieManager.setCookie(origin, cookie, null)
    cookieManager.flush()
    invoke.resolve()
  }

  @Command
  fun getStatusBarHeight(invoke: Invoke) {
    var px = 0
    if (Build.VERSION.SDK_INT >= 30) {
      val insets = activity.window.decorView.rootWindowInsets
      px = insets?.getInsets(WindowInsets.Type.statusBars())?.top ?: 0
    }
    if (px == 0) {
      val resourceId = activity.resources.getIdentifier("status_bar_height", "dimen", "android")
      if (resourceId > 0) px = activity.resources.getDimensionPixelSize(resourceId)
    }
    val density = activity.resources.displayMetrics.density
    val ret = JSObject()
    ret.put("height", if (density > 0f) px / density else px.toDouble())
    invoke.resolve(ret)
  }
}
