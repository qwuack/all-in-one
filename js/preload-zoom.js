const { contextBridge, ipcRenderer, webFrame } = require('electron');

contextBridge.exposeInMainWorld('zoomAPI', {
  zoomIn: () => ipcRenderer.send('zoom-page-in'),
  zoomOut: () => ipcRenderer.send('zoom-page-out'),
  zoomReset: () => ipcRenderer.send('zoom-page-reset'),
  getZoomFactor: () => webFrame.getZoomFactor(),
  onZoomChanged: (callback) => {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('page-zoom-changed', (event, factor) => callback(factor));
  }
});
