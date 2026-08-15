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
    // view switching (launcher <-> connected dsh web)
    connect: (url) => ipcRenderer.invoke('shell:connect', url),
    back: () => ipcRenderer.invoke('shell:back'),
    // dsh-view navigation (title-bar back/forward)
    nav: {
      back: () => ipcRenderer.invoke('view:go-back'),
      forward: () => ipcRenderer.invoke('view:go-forward'),
      state: () => ipcRenderer.invoke('view:nav-state'),
      onChanged: (callback) => {
        const listener = (_event, state) => callback(state)
        ipcRenderer.on('nav:changed', listener)
        return () => ipcRenderer.removeListener('nav:changed', listener)
      },
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
