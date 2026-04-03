const { ipcRenderer } = require('electron');

// Listen for ctrl+scroll globally in the BrowserView to trigger zoom
window.addEventListener('wheel', (e) => {
  if (e.ctrlKey) {
    // If we want to prevent default we could make passive: false,
    // but the web page might want to know about the scroll.
    // In Chromium, Ctrl+wheel native zoom can be caught here.
    if (e.deltaY < 0) {
      ipcRenderer.send('zoom-view-in');
    } else if (e.deltaY > 0) {
      ipcRenderer.send('zoom-view-out');
    }
  }
}, { capture: true, passive: true });
