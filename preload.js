// Launcher bridge: exposed only on the local file:// shell page. The
// remote dsh web page never sees these (origin gate below), so a malicious
// extension UI cannot reach process or window controls.
const { contextBridge, ipcRenderer } = require('electron')

const isLauncher = window.location.href.startsWith('file:')

if (isLauncher) {
  contextBridge.exposeInMainWorld('dshShell', {
    // embedded local instance
    startLocal: () => ipcRenderer.invoke('local:start'),
    stopLocal: () => ipcRenderer.invoke('local:stop'),
    status: () => ipcRenderer.invoke('local:status'),
    logs: () => ipcRenderer.invoke('local:logs'),
    onExited: (callback) => {
      const listener = (_event, detail) => callback(detail)
      ipcRenderer.on('local:exited', listener)
      return () => ipcRenderer.removeListener('local:exited', listener)
    },
    onBacked: (callback) => {
      const listener = () => callback()
      ipcRenderer.on('shell:backed', listener)
      return () => ipcRenderer.removeListener('shell:backed', listener)
    },
    // view switching (launcher <-> connected dsh web)
    connect: (url) => ipcRenderer.invoke('shell:connect', url),
    back: () => ipcRenderer.invoke('shell:back'),
    reload: () => ipcRenderer.invoke('view:reload'),
    onConnectionChanged: (callback) => {
      const listener = (_event, detail) => callback(detail)
      ipcRenderer.on('connection:changed', listener)
      return () => ipcRenderer.removeListener('connection:changed', listener)
    },
    // remote node registry (multi-instance: add / save / switch)
    remote: {
      connect: (id) => ipcRenderer.invoke('remote:connect', id),
      disconnect: () => ipcRenderer.invoke('remote:disconnect'),
      list: () => ipcRenderer.invoke('remote:list'),
      save: (input) => ipcRenderer.invoke('remote:save', input),
      remove: (id) => ipcRenderer.invoke('remote:remove', id),
      setDefault: (id) => ipcRenderer.invoke('remote:set-default', id),
      health: (id) => ipcRenderer.invoke('remote:health', id),
    },
    // settings dialog window + shell behavior
    settings: {
      open: () => ipcRenderer.invoke('settings:open'),
      close: () => ipcRenderer.invoke('settings:close'),
      current: () => ipcRenderer.invoke('settings:current'),
      getLoginItem: () => ipcRenderer.invoke('settings:get-login-item'),
      setLoginItem: (enabled) => ipcRenderer.invoke('settings:set-login-item', enabled),
      getRestore: () => ipcRenderer.invoke('settings:get-restore'),
      setRestore: (enabled) => ipcRenderer.invoke('settings:set-restore', enabled),
    },
    // live theme sync from the connected dsh page (title-bar fusion)
    onThemeSync: (callback) => {
      const listener = (_event, tokens) => callback(tokens)
      ipcRenderer.on('theme:sync', listener)
      return () => ipcRenderer.removeListener('theme:sync', listener)
    },
    // custom title bar window controls
    window: {
      minimize: () => ipcRenderer.invoke('win:minimize'),
      toggleMaximize: () => ipcRenderer.invoke('win:toggle-maximize'),
      close: () => ipcRenderer.invoke('win:close'),
      isMaximized: () => ipcRenderer.invoke('win:is-maximized'),
      onMaximizedChanged: (callback) => {
        const listener = (_event, maximized) => callback(maximized)
        ipcRenderer.on('win:maximized-changed', listener)
        return () => ipcRenderer.removeListener('win:maximized-changed', listener)
      },
    },
  })
}
