const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('homehub', Object.freeze({
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  loadPublicSettings: () => ipcRenderer.invoke('settings:public'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  openSettings: () => ipcRenderer.invoke('window:open-settings'),
  fetchDevices: () => ipcRenderer.invoke('hub:fetch-devices'),
  discoverDevices: () => ipcRenderer.invoke('hub:discover'),
  addDiscoveredDevice: (request) => ipcRenderer.invoke('hub:add-discovered', request),
  startPairing: (request) => ipcRenderer.invoke('hub:start-pairing', request),
  confirmPairing: (request) => ipcRenderer.invoke('hub:confirm-pairing', request),
  cancelPairing: (request) => ipcRenderer.invoke('hub:cancel-pairing', request),
  sendDeviceAction: (request) => ipcRenderer.invoke('hub:device-action', request),
  onHubEvent: (callback) => {
    if (typeof callback !== 'function') throw new TypeError('Hub event callback must be a function');
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('hub:event', listener);
    return () => ipcRenderer.removeListener('hub:event', listener);
  },
}));
