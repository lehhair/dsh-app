package com.dshapp.app

import android.content.Intent
import android.content.res.Configuration
import android.graphics.Bitmap
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.WindowInsetsController
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
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

  // wry creates the WebViewClient (and calls setWebView) before the Rust
  // side sets the real client, so `onWebViewCreate` runs with webViewClient
  // still null. Post to the main loop: by then Tauri's client is installed,
  // and we wrap it to hand target="_blank" / window.open() links to the
  // system browser instead of dropping them (a WebView has no tab bar).
  override fun onWebViewCreate(webView: WebView) {
    handler.post {
      val original = webView.webViewClient
      val activity = this
      webView.webViewClient = object : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
          return original?.let { it.shouldOverrideUrlLoading(view, request) } != false
        }

        override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
          original?.onPageStarted(view, url, favicon)
        }

        override fun onPageFinished(view: WebView, url: String?) {
          original?.onPageFinished(view, url)
        }

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
                startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(href)))
                return true
              } catch (e: Exception) {
                // fall through to default (returns true but no new window)
              }
            }
          }
          return super.onCreateWindow(view, isDialog, isUserGesture, resultMsg)
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
