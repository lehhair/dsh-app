// Bridge over the Tauri IPC — the dshShell equivalent for the bundled
// frontend. Every call maps 1:1 to a Rust `#[tauri::command]`.

import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'

async function on(channel, callback) {
  return listen(channel, (event) => callback(event.payload))
}

export const bridge = {
  // platform info from Rust (mobile hides the desktop-only chrome)
  appInfo: () => invoke('app_info'),
  // status-bar inset in CSS px (mobile)
  statusBarHeight: () => invoke('status_bar_height'),

  // embedded local instance
  startLocal: () => invoke('local_start'),
  stopLocal: () => invoke('local_stop'),
  status: () => invoke('local_status'),
  logs: () => invoke('local_logs').then((text) => (text ? text.split('\n') : [])),

  // embedded dsh self-update / on-demand install
  dshVersion: () => invoke('dsh_version'),
  diagnose: () => invoke('dsh_diagnose'),
  checkUpdate: () => invoke('dsh_check_update'),
  update: (target) => invoke('dsh_update', { target }),
  install: () => invoke('dsh_install'),
  onUpdateLog: (callback) => on('dsh:update-log', callback),
  // launcher self-update (GitHub Releases)
  checkLauncherUpdate: () => invoke('check_launcher_update'),
  launcherUpdate: (url) => invoke('launcher_update', { url }),
  onExited: (callback) => on('local:exited', callback),
  onBacked: (callback) => on('shell:backed', callback),

  // view switching (launcher <-> connected dsh web)
  connect: (url) => invoke('shell_connect', { url }),
  back: () => invoke('shell_back'),
  newWindow: () => invoke('shell_new_window'),
  shellReady: () => invoke('shell_ready'),
  reload: () => invoke('view_reload'),
  openDevTools: () => invoke('open_devtools'),
  onConnectionChanged: (callback) => on('connection:changed', callback),

  // remote node registry
  remote: {
    connect: (id) => invoke('remote_connect', { id }),
    disconnect: () => invoke('remote_disconnect'),
    list: () => invoke('remote_list'),
    save: (input) => invoke('remote_save', { input }),
    remove: (id) => invoke('remote_remove', { id }),
    health: (id) => invoke('remote_health', { id }),
  },

  // settings dialog + shell behavior
  settings: {
    open: () => invoke('settings_open'),
    close: () => invoke('settings_close'),
    current: () => invoke('settings_current'),
    getLoginItem: () => invoke('settings_get_login_item'),
    setLoginItem: (enabled) => invoke('settings_set_login_item', { enabled }),
    getRestore: () => invoke('settings_get_restore'),
    setRestore: (enabled) => invoke('settings_set_restore', { enabled }),
    getAutoLocal: () => invoke('settings_get_auto_local'),
    setAutoLocal: (enabled) => invoke('settings_set_auto_local', { enabled }),
  },
  // emitted when the (cached) settings overlay becomes visible — re-read state
  onSettingsRefresh: (callback) => on('settings:refresh', callback),

  // live theme sync from the connected dsh page
  onThemeSync: (callback) => on('theme:sync', callback),

  // custom title bar window controls
  window: {
    minimize: () => getCurrentWindow().minimize(),
    toggleMaximize: async () => {
      const win = getCurrentWindow()
      if (await win.isMaximized()) await win.unmaximize()
      else await win.maximize()
    },
    close: () => getCurrentWindow().close(),
    isMaximized: () => getCurrentWindow().isMaximized(),
    onMaximizedChanged: (callback) => {
      const win = getCurrentWindow()
      const update = async () => callback(await win.isMaximized())
      const unlisten = win.onResized(update)
      // also catch programmatic maximize/minimize without a resize
      update()
      return unlisten
    },
  },
}
