// Launcher bridge: exposed only on the local file:// launcher page. The
// remote dsh web page never sees these (origin gate below), so a malicious
// extension UI cannot reach process controls.
const { contextBridge, ipcRenderer } = require('electron')

const isLauncher = window.location.href.startsWith('file:')

if (isLauncher) {
  contextBridge.exposeInMainWorld('dshShell', {
    startLocal: () => ipcRenderer.invoke('local:start'),
    stopLocal: () => ipcRenderer.invoke('local:stop'),
    status: () => ipcRenderer.invoke('local:status'),
    logs: () => ipcRenderer.invoke('local:logs'),
    connect: (url) => ipcRenderer.invoke('shell:connect', url),
    onExited: (callback) => {
      const listener = (_event, detail) => callback(detail)
      ipcRenderer.on('local:exited', listener)
      return () => ipcRenderer.removeListener('local:exited', listener)
    },
  })
}
