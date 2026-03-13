'use strict';
/**
 * Electron preload script — exposes a safe IPC bridge to the renderer.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (cfg) => ipcRenderer.invoke('save-settings', cfg),
  reloadSettings: () => ipcRenderer.invoke('reload-settings'),

  // Database
  getDbStatus: () => ipcRenderer.invoke('get-db-status'),
  createDatabase: (mode, password) => ipcRenderer.invoke('create-database', mode, password),

  // Trading
  startTrading: (mode) => ipcRenderer.invoke('start-trading', mode),
  stopTrading: () => ipcRenderer.invoke('stop-trading'),

  // Dialogs
  openFile: (options) => ipcRenderer.invoke('open-file', options),
  showDialog: (options) => ipcRenderer.invoke('show-dialog', options),

  // Account files (private keys / proxies)
  readLinesFile: (filePath) => ipcRenderer.invoke('read-lines-file', filePath),
  saveLinesFile: (filePath, lines) => ipcRenderer.invoke('save-lines-file', filePath, lines),

  // Events from main process
  onLog: (callback) => ipcRenderer.on('log', (event, data) => callback(data)),
  onTradingDone: (callback) => ipcRenderer.on('trading-done', (event, data) => callback(data)),
  onTradingError: (callback) => ipcRenderer.on('trading-error', (event, data) => callback(data)),
});
