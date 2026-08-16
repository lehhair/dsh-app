//! Initialization script injected into dsh webviews (desktop node views and
//! the mobile main webview). Two jobs, both inert on non-dsh pages:
//!
//! 1. Theme sampler — reads the tokens the dsh page ACTUALLY renders with
//!    (aliases resolve through whatever theme the page or a theme extension
//!    applied) and reports them to Rust, which forwards them to the shell
//!    UI so the title bar stays visually fused with the page. Covers initial
//!    load, `data-ds-dark-theme` flips, :root/body style rewrites, and
//!    injected <style> token overrides (polled, since those don't mutate
//!    attributes).
//! 2. Back button — a single "回到启动页" button in dsh's own settings
//!    panel header (the stable `[data-slot="settings.action"]` seat), styled
//!    with dsw tokens only. Click routes back to the launcher via the
//!    `shell_back` command.
//!
//! The script only talks through `window.__TAURI_INTERNALS__.invoke` — the
//! same bridge the bundled frontend uses; it exposes nothing to the page.

pub const NODE_VIEW_SCRIPT: &str = r#"
(() => {
  const TOKENS = [
    '--dsw-alias-bg-base',
    '--dsw-alias-bg-layer-1',
    '--dsw-alias-bg-layer-2',
    '--dsw-alias-label-primary',
    '--dsw-alias-label-primary-foreground',
    '--dsw-alias-label-secondary',
    '--dsw-alias-label-tertiary',
    '--dsw-alias-border-l2',
    '--dsw-alias-interactive-bg-hover',
    '--dsw-alias-interactive-bg-active',
    '--dsw-alias-button-primary-fill',
    '--dsw-alias-button-primary-hover',
    '--dsw-alias-button-ghost-active-fill',
    '--dsw-alias-button-ghost-active-border',
    '--dsw-alias-scrollbar-bg-l1',
    '--dsw-alias-scrollbar-hover-l1',
    '--dsw-alias-state-error-primary',
    '--dsw-alias-state-success-primary',
  ];

  const isDshPage = () =>
    !!getComputedStyle(document.body).getPropertyValue('--dsw-alias-bg-base').trim();

  function sampleTokens() {
    const style = getComputedStyle(document.body);
    const out = {};
    for (const name of TOKENS) {
      const value = style.getPropertyValue(name).trim();
      if (value) out[name] = value;
    }
    return out;
  }

  function publish() {
    if (!isDshPage()) return;
    try {
      window.__TAURI_INTERNALS__.invoke('theme_changed', { tokens: sampleTokens() });
    } catch (_e) {}
    syncStatusBarIcons();
  }

  // ---- back button (dsh settings panel header) ----
  const BACK_KEY = 'dsh-app-back-to-launcher';
  const BACK_STYLE_ID = 'dsh-app-back-style';
  const BACK_STYLES = `
    .${BACK_KEY} {
      box-sizing: border-box;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      height: 28px;
      padding: 0 10px;
      border: 1px solid var(--dsw-alias-border-l2);
      border-radius: 14px;
      background: transparent;
      color: var(--dsw-alias-label-primary);
      font: inherit;
      font-size: 12px;
      line-height: 18px;
      cursor: pointer;
    }
    .${BACK_KEY}:hover { background: var(--dsw-alias-interactive-bg-hover); }
  `;

  let backButton = null;

  function ensureBackButton() {
    if (backButton && backButton.isConnected) return;
    injectBackStyles();
    const seat = document.querySelector('[data-slot="settings.action"]');
    const host = seat && seat.parentElement;
    if (!seat || !host) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = BACK_KEY;
    btn.textContent = '回到启动页';
    btn.addEventListener('click', () => {
      try {
        window.__TAURI_INTERNALS__.invoke('shell_back');
      } catch (_e) {}
    });
    host.appendChild(btn);
    backButton = btn;
  }

  function injectBackStyles() {
    if (document.getElementById(BACK_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = BACK_STYLE_ID;
    style.textContent = BACK_STYLES;
    document.head.appendChild(style);
  }

  function watchSettingsPanel() {
    if (document.querySelector('[role="dialog"][aria-modal="true"]')) {
      ensureBackButton();
    } else {
      backButton = null;
    }
  }

  // Mobile only: WebView < 140 reports wrong env(safe-area-inset-*) under
  // edge-to-edge, so pad the dsh page below the real status-bar inset
  // (read natively). Same mechanics as the Capacitor fix: body padding inside
  // a border-box keeps the fixed-height SPA inside the viewport. The dialog
  // rule offsets dsh's modal settings panel (a fixed/relative overlay that
  // body padding does not reach) below the bar.
  function applySafeArea() {
    if (!/Android/i.test(navigator.userAgent)) return;
    try {
      window.__TAURI_INTERNALS__.invoke('status_bar_height').then((height) => {
        if (height && height > 0 && !document.getElementById('dsh-app-safe-area')) {
          const style = document.createElement('style');
          style.id = 'dsh-app-safe-area';
          style.textContent =
            'body{padding-top:' + height + 'px;box-sizing:border-box}' +
            '#root{height:100%}' +
            '[role="dialog"][aria-modal="true"]{margin-top:' + height + 'px!important;max-height:calc(100% - ' + height + 'px)!important}';
          document.head.appendChild(style);
        }
      }).catch(() => {});
    } catch (_e) {}
  }

  // Status-bar icon appearance follows the page's ACTUAL theme (dsh can be
  // dark while the system is light): sample the bg-base token luminance and
  // tell the native side which icon color to use.
  let lastStatusBarDark = null;
  function syncStatusBarIcons() {
    if (!/Android/i.test(navigator.userAgent)) return;
    const bg = getComputedStyle(document.body).getPropertyValue('--dsw-alias-bg-base').trim();
    const m = bg.match(/rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/);
    if (!m) return;
    const luminance = 0.2126 * +m[1] + 0.7152 * +m[2] + 0.0722 * +m[3];
    const dark = luminance < 128;
    if (dark !== lastStatusBarDark) {
      lastStatusBarDark = dark;
      try {
        window.__TAURI_INTERNALS__.invoke('status_bar_appearance', { dark });
      } catch (_e) {}
    }
  }

  function init() {
    applySafeArea();
    const observer = new MutationObserver(publish);
    for (const target of [document.documentElement, document.body]) {
      observer.observe(target, {
        attributes: true,
        attributeFilter: ['style', 'class', 'data-ds-dark-theme'],
      });
    }
    setInterval(publish, 2000);
    publish();
    setInterval(watchSettingsPanel, 1000);
  }

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
"#;
