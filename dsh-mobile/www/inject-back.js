// Injected into the remote dsh page inside the mobile WebView. Same
// mechanism as the desktop view-preload spike: find the settings panel (stable
// aria-modal dialog), put a "回到启动页" button in its header actions seat,
// and route back to the launcher when tapped.
//
// Injected as a plain script string (no preload in mobile WebView), so it is
// self-contained: no requires, no imports — only DOM + a back callback that
// the native layer supplies as `window.__dshAppBackToLauncher` before
// injecting.

(function () {
  'use strict'

  // The native layer re-evaluates this script on every onPageFinished,
  // which can fire more than once per connect (redirect chains and WebView
  // quirks). Only the first evaluation in a document may run: otherwise
  // every copy keeps its own watcher and injects its own button, and the
  // settings panel ends up with two "回到启动页" buttons.
  if (window.__dshAppBackInjected) return
  window.__dshAppBackInjected = true

  var BACK_KEY = 'dsh-app-back-to-launcher'

  function injectStyles() {
    if (document.getElementById(BACK_KEY + '-style')) return
    var style = document.createElement('style')
    style.id = BACK_KEY + '-style'
    style.textContent =
      '.' + BACK_KEY + '{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:28px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;cursor:pointer;}' +
      '.' + BACK_KEY + ':hover{background:var(--dsw-alias-interactive-bg-hover);}'
    document.head.appendChild(style)
  }

  var backButton = null

  function ensureBackButton() {
    if (backButton && backButton.isConnected) return
    injectStyles()
    var seat = document.querySelector('[data-slot="settings.action"]')
    var host = seat ? seat.parentElement : null
    if (!seat || !host) return
    // Belt and braces: never append a second button if one is already in
    // the host (covers any path that runs this script twice in a document).
    var existing = host.querySelector('.' + BACK_KEY)
    if (existing) {
      backButton = existing
      return
    }
    var btn = document.createElement('button')
    btn.type = 'button'
    btn.className = BACK_KEY
    btn.textContent = '回到启动页'
    btn.addEventListener('click', function () {
      if (window.DshNativeBridge && window.DshNativeBridge.close) {
        window.DshNativeBridge.close()
      } else if (window.__dshAppBackToLauncher) {
        window.__dshAppBackToLauncher()
      }
    })
    host.appendChild(btn)
    backButton = btn
  }

  function watch() {
    if (document.querySelector('[role="dialog"][aria-modal="true"]')) {
      ensureBackButton()
    } else {
      backButton = null
    }
  }

  watch()
  setInterval(watch, 1000)
})()
