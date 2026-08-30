'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const listen = (channel) => (handler) => {
  const wrapped = (_e, payload) => handler(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
};

contextBridge.exposeInMainWorld('lanchat', {
  /* Ayarlar */
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),

  /* Uygulama bilgisi */
  appInfo: () => ipcRenderer.invoke('app:info'),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),

  /* Ekran paylasimi */
  getScreenSources: () => ipcRenderer.invoke('screen:sources'),
  selectScreenSource: (id, opts) => ipcRenderer.invoke('screen:select', id, opts || {}),
  screenPermission: () => ipcRenderer.invoke('screen:permission'),
  micPermission: () => ipcRenderer.invoke('mic:permission'),
  openSystemPrefs: (panel) => ipcRenderer.invoke('system:openPrefs', panel),

  /* RNNoise WASM ikilisi (file:// uzerinde fetch calismaz) */
  loadRnnoiseWasm: () => ipcRenderer.invoke('rnnoise:wasm'),

  /* Ag kesfi */
  scanServers: (opts) => ipcRenderer.invoke('discovery:scan', opts || {}),

  /* Gomulu sunucu */
  startServer: (opts) => ipcRenderer.invoke('server:start', opts),
  stopServer: () => ipcRenderer.invoke('server:stop'),
  serverStatus: () => ipcRenderer.invoke('server:status'),
  onServerLog: listen('server:log'),

  /* Guncelleme */
  updateState: () => ipcRenderer.invoke('update:state'),
  checkUpdate: (opts) => ipcRenderer.invoke('update:check', opts || {}),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  openReleases: () => ipcRenderer.invoke('update:openReleases'),
  onUpdateState: listen('update:state'),

  /* Push to talk */
  registerPtt: (accelerator) => ipcRenderer.invoke('ptt:register', accelerator),
  unregisterPtt: () => ipcRenderer.invoke('ptt:unregister'),
  onPttChange: listen('ptt:change'),

  /* Pencere */
  minimize: () => ipcRenderer.send('win:minimize'),
  maximize: () => ipcRenderer.send('win:maximize'),
  close: () => ipcRenderer.send('win:close'),
  flash: () => ipcRenderer.send('win:flash'),
  setAlwaysOnTop: (v) => ipcRenderer.send('win:setAlwaysOnTop', v),
  onWindowState: listen('win:state'),

  /* Tepsi */
  updateTray: (state) => ipcRenderer.send('tray:update', state),
  setBadge: (n) => ipcRenderer.send('badge:set', n),
  onTrayAction: listen('tray:action'),

  platform: process.platform
});
