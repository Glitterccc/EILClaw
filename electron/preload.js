const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('launcherAPI', {
  bootstrap: {
    getState: () => ipcRenderer.invoke('bootstrap:getState'),
    onWindowContext: (callback) => {
      ipcRenderer.on('launcher:window-context', (_, payload) => callback(payload))
    }
  },
  config: {
    loadCurrent: () => ipcRenderer.invoke('config:loadCurrent'),
    validateAndSave: (payload) => ipcRenderer.invoke('config:validateAndSave', payload)
  },
  runtime: {
    start: () => ipcRenderer.invoke('runtime:start'),
    stop: () => ipcRenderer.invoke('runtime:stop'),
    restart: () => ipcRenderer.invoke('runtime:restart'),
    openChat: () => ipcRenderer.invoke('runtime:openChat'),
    getStatus: () => ipcRenderer.invoke('runtime:getStatus')
  },
  app: {
    uninstall: () => ipcRenderer.invoke('app:uninstall')
  },
  weixin: {
    start: () => ipcRenderer.invoke('weixin:start'),
    cancel: () => ipcRenderer.invoke('weixin:cancel'),
    getState: () => ipcRenderer.invoke('weixin:getState'),
    openScanUrl: () => ipcRenderer.invoke('weixin:openScanUrl'),
    onUpdate: (callback) => {
      ipcRenderer.on('weixin:update', (_, payload) => callback(payload))
    }
  },
  removeAllListeners: () => {
    ipcRenderer.removeAllListeners('launcher:window-context')
    ipcRenderer.removeAllListeners('weixin:update')
  }
})
