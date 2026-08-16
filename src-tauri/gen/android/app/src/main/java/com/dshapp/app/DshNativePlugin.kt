package com.dshapp.app

import android.app.Activity
import android.webkit.CookieManager
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
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
}
