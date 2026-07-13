const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('feige', {
  invoke: (channel, payload) => ipcRenderer.invoke(channel, payload),
  setUiLanguage: locale => ipcRenderer.invoke('set-ui-language', locale),
  onProgress: callback => ipcRenderer.on('task-progress', (_, data) => callback(data))
});
