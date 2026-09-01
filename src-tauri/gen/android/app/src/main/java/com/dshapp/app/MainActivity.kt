package com.dshapp.app

import android.content.Intent
import android.content.res.Configuration
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.WindowInsetsController
import android.webkit.ConsoleMessage
import android.webkit.CustomViewCallback
import android.webkit.FileChooserParams
import android.webkit.GeolocationPermissions
import android.webkit.JsPromptResult
import android.webkit.JsResult
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  private val handler = Handler(Looper.getMainLooper())
  private var lastNight: Boolean? = null
  private val pollStatusBar = object : Runnable {
    override fun run() {
      val night = isNightMode()
      if (night != lastNight) {
        lastNight = night
        applyStatusBarIcons(night)
      }
      handler.postDelayed(this, 2000)
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // IME (keyboard) handling: SDK 35+ forces edge-to-edge, where
    // windowSoftInputMode="adjustResize" is ignored and the keyboard would
    // cover the WebView. Consume the ime() inset as bottom padding on the
    // content view — the WebView viewport shrinks so the page (chat input,
    // dialogs, fixed footers) stays above the keyboard. When the keyboard is
    // closed, pad by the system-bars bottom inset so the navigation-bar area
    // stays clear (same mechanism, both cases).
    val root = findViewById<View>(android.R.id.content).rootView
    ViewCompat.setOnApplyWindowInsetsListener(root) { v, windowInsets ->
      val imeVisible = windowInsets.isVisible(WindowInsetsCompat.Type.ime())
      val bottom = if (imeVisible) {
        windowInsets.getInsets(WindowInsetsCompat.Type.ime()).bottom
      } else {
        windowInsets.getInsets(WindowInsetsCompat.Type.systemBars()).bottom
      }
      v.setPadding(0, 0, 0, bottom)
      windowInsets
    }
    // Status-bar icons follow the day/night theme. uiMode callbacks go silent
    // on this device (API 36), so poll and re-apply — same fix as the
    // Capacitor client. enableEdgeToEdge only styles the bars once at create.
    lastNight = isNightMode()
    applyStatusBarIcons(lastNight == true)
    handler.postDelayed(pollStatusBar, 2000)
  }

  // target="_blank" / window.open() must open the system browser, but wry's
  // WebChromeClient never overrides onCreateWindow (so WebView drops the
  // request). wry sets its clients after onWebViewCreate, so post to the
  // main loop: by then the WebChromeClient is installed — wrap it in a single
  // layer that adds onCreateWindow and delegates every other callback to the
  // original (js dialogs, file chooser, permissions… all preserved).
  override fun onWebViewCreate(webView: WebView) {
    handler.post {
      val inner = webView.webChromeClient
      val activity = this
      webView.webChromeClient = object : WebChromeClient() {
        override fun onCreateWindow(
          view: WebView,
          isDialog: Boolean,
          isUserGesture: Boolean,
          resultMsg: android.os.Message
        ): Boolean {
          // target="_blank" / window.open(): hand the URL to the system browser.
          if (isUserGesture) {
            val url = resultMsg.data?.getString("url")
            val webViewUrl = resultMsg.obj as? WebView
            val href = url ?: webViewUrl?.url
            if (href != null && href.startsWith("http")) {
              try {
                activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(href)))
                return true
              } catch (e: Exception) {
                // no browser to handle it — fall through to the delegate
              }
            }
          }
          return inner?.onCreateWindow(view, isDialog, isUserGesture, resultMsg) ?: false
        }

        override fun onShowCustomView(view: View, callback: android.webkit.CustomViewCallback) {
          inner?.onShowCustomView(view, callback) ?: super.onShowCustomView(view, callback)
        }
        override fun onHideCustomView() {
          inner?.onHideCustomView() ?: super.onHideCustomView()
        }
        override fun onJsAlert(view: WebView, url: String, message: String, result: JsResult): Boolean =
          inner?.onJsAlert(view, url, message, result) ?: super.onJsAlert(view, url, message, result)
        override fun onJsConfirm(view: WebView, url: String, message: String, result: JsResult): Boolean =
          inner?.onJsConfirm(view, url, message, result) ?: super.onJsConfirm(view, url, message, result)
        override fun onJsPrompt(view: WebView, url: String, message: String, defaultValue: String, result: JsPromptResult): Boolean =
          inner?.onJsPrompt(view, url, message, defaultValue, result) ?: super.onJsPrompt(view, url, message, defaultValue, result)
        override fun onPermissionRequest(request: PermissionRequest) {
          inner?.onPermissionRequest(request) ?: super.onPermissionRequest(request)
        }
        override fun onGeolocationPermissionsShowPrompt(origin: String, callback: GeolocationPermissions.Callback) {
          inner?.onGeolocationPermissionsShowPrompt(origin, callback) ?: super.onGeolocationPermissionsShowPrompt(origin, callback)
        }
        override fun onShowFileChooser(webView: WebView, filePathCallback: ValueCallback<Array<Uri?>?>, fileChooserParams: FileChooserParams): Boolean =
          inner?.onShowFileChooser(webView, filePathCallback, fileChooserParams) ?: super.onShowFileChooser(webView, filePathCallback, fileChooserParams)
        override fun onConsoleMessage(consoleMessage: ConsoleMessage): Boolean =
          inner?.onConsoleMessage(consoleMessage) ?: super.onConsoleMessage(consoleMessage)
        override fun onReceivedTitle(view: WebView, title: String) {
          inner?.onReceivedTitle(view, title) ?: super.onReceivedTitle(view, title)
        }
      }
    }
  }

  override fun onDestroy() {
    handler.removeCallbacks(pollStatusBar)
    super.onDestroy()
  }

  private fun isNightMode(): Boolean =
    (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) ==
      Configuration.UI_MODE_NIGHT_YES

  private fun applyStatusBarIcons(dark: Boolean) {
    val controller = window.insetsController ?: return
    controller.setSystemBarsAppearance(
      if (dark) 0 else WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS,
      WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS,
    )
  }
}
