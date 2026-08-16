package com.dshapp.app

import android.content.res.Configuration
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.WindowInsetsController
import androidx.activity.enableEdgeToEdge

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
