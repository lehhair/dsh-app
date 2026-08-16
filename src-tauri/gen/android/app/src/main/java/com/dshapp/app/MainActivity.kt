package com.dshapp.app

import android.content.res.Configuration
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.WindowInsetsController
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
