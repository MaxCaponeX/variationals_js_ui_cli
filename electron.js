'use strict';
/**
 * Electron main process
 *
 * Manages the app window, IPC communication with the renderer,
 * and delegates trading operations to the shared core.
 */

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const EventEmitter = require('events');

const logger = require('./src/utils/logger');
const settings = require('./src/core/settings');
const DataBase = require('./src/core/database');
const { runner } = require('./src/core/runner');
const stopSignal = require('./src/utils/stopSignal');

// ── Log IPC bridge ─────────────────────────────────────────────────────────────

const logEmitter = new EventEmitter();
logger.setIpcEmitter(logEmitter);

let mainWindow = null;

logEmitter.on('log', (entry) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('log', entry);
  }
});

// ── Window creation ────────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 900,
    minHeight: 600,
    title: 'Variational Bot',
    webPreferences: {
      preload: path.join(__dirname, 'src/gui/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'src/gui/index.html'));
  mainWindow.setMenuBarVisibility(false);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ── State ─────────────────────────────────────────────────────────────────────

let db = null;
let isRunning = false;

function getOrCreateDb() {
  if (!db) db = new DataBase();
  return db;
}

// ── IPC handlers ──────────────────────────────────────────────────────────────

/** Get current settings */
ipcMain.handle('get-settings', () => {
  return settings.get();
});

/** Save settings from GUI */
ipcMain.handle('save-settings', (event, newSettings) => {
  try {
    settings.save(newSettings);
    logger.success('[+] Settings saved successfully');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/** Reload settings from disk */
ipcMain.handle('reload-settings', () => {
  settings.load();
  return settings.get();
});

/** Get database status */
ipcMain.handle('get-db-status', () => {
  try {
    const d = getOrCreateDb();
    const modules = d._readDb(d.modulesDbPath);
    const keys = Object.keys(modules);
    if (!keys.length) return { type: 'empty', count: 0 };
    const isGroups = d._isGroupDb(modules);
    const count = keys.length;
    const pending = keys.filter((k) =>
      (modules[k].modules || []).some((m) => m.status === 'to_run')
    ).length;
    return { type: isGroups ? 'groups' : 'single', count, pending };
  } catch (err) {
    return { type: 'error', error: err.message };
  }
});

/** Create database */
ipcMain.handle('create-database', async (event, mode, password) => {
  try {
    db = new DataBase();
    await db.setPassword(password !== undefined ? password : null);
    await db.createModules(mode);
    return { ok: true };
  } catch (err) {
    logger.error(`[-] Create DB error: ${err.message}`);
    return { ok: false, error: err.message };
  }
});

/** Start trading */
ipcMain.handle('start-trading', async (event, mode, password) => {
  if (isRunning) return { ok: false, error: 'Already running' };
  isRunning = true;
  stopSignal.reset();

  try {
    const d = new DataBase();
    await d.setPassword(password !== undefined ? password : null);

    // Run in background (don't await — send progress events)
    runner({ mode, db: d }).then((result) => {
      isRunning = false;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('trading-done', { result });
      }
    }).catch((err) => {
      isRunning = false;
      if (err.name !== 'StopError') {
        logger.error(`[-] Runner error: ${err.message}`);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('trading-error', { error: err.message });
        }
      }
    });

    return { ok: true };
  } catch (err) {
    isRunning = false;
    return { ok: false, error: err.message };
  }
});

/** Stop trading — immediate */
ipcMain.handle('stop-trading', () => {
  stopSignal.request();
  isRunning = false;
  logger.warning('Остановка — прерывание всех операций...');
  return { ok: true };
});

/** Open file picker */
ipcMain.handle('open-file', async (event, options) => {
  const result = await dialog.showOpenDialog(mainWindow, options);
  return result;
});

/** Show message dialog */
ipcMain.handle('show-dialog', async (event, options) => {
  return await dialog.showMessageBox(mainWindow, options);
});

/** Read lines from a file (private keys / proxies) */
ipcMain.handle('read-lines-file', (_event, filePath) => {
  try {
    const abs = settings.resolvePath(filePath);
    if (!fs.existsSync(abs)) return { ok: true, lines: [] };
    const lines = fs.readFileSync(abs, 'utf-8')
      .split('\n').map((l) => l.trim()).filter(Boolean);
    return { ok: true, lines };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/** Save lines to a file (private keys / proxies) */
ipcMain.handle('save-lines-file', (_event, filePath, lines) => {
  try {
    const abs = settings.resolvePath(filePath);
    const dir = path.dirname(abs);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(abs, lines.filter((l) => l.trim()).join('\n') + '\n');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
