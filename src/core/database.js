'use strict';
/**
 * Database manager
 *
 * Manages three JSON databases:
 *   - modules.json  — queue of accounts/modules to run
 *   - report.json   — per-account run reports
 *   - stats.json    — module completion counters
 *
 * Private keys are encrypted with AES-256-CBC before storage.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { ethers } = require('ethers');

const logger = require('../utils/logger');
const { randint, shuffle } = require('../utils/sleep');
const settings = require('./settings');

// ─── Crypto helpers ────────────────────────────────────────────────────────────

const CIPHER = 'aes-256-cbc';
const KEY_LEN = 32; // 256-bit

function deriveKey(password) {
  return crypto.createHash('md5').update(password).digest();
  // MD5 gives 16 bytes; extend to 32 bytes by repeating
  // (matches original Fernet MD5-based key derivation approach)
}

function extendKey(md5key) {
  // Simple extension: repeat MD5 hash to fill 32 bytes
  return Buffer.concat([md5key, md5key]).slice(0, KEY_LEN);
}

function encryptPk(pk, key) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(CIPHER, key, iv);
  const encrypted = Buffer.concat([cipher.update(pk, 'utf8'), cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decryptPk(encoded, key) {
  const [ivHex, encHex] = encoded.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const encBuf = Buffer.from(encHex, 'hex');
  const decipher = crypto.createDecipheriv(CIPHER, key, iv);
  return Buffer.concat([decipher.update(encBuf), decipher.final()]).toString('utf8');
}

// ─── Address helper ────────────────────────────────────────────────────────────

function getAddress(privateKey) {
  const wallet = new ethers.Wallet(privateKey.startsWith('0x') ? privateKey : '0x' + privateKey);
  return wallet.address;
}

// ─── Async input helper ────────────────────────────────────────────────────────

function promptPassword(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

// ─── Window/progress tracker ────────────────────────────────────────────────────

class ProgressTracker {
  constructor(accsAmount) {
    this.accsAmount = accsAmount;
    this.accsDone = 0;
    this.modulesAmount = 0;
    this.modulesDone = 0;
  }
  addAcc() { this.accsDone++; }
  addModule() { this.modulesDone++; }
  setModules(n) { this.modulesAmount = n; this.modulesDone = 0; }
  status() {
    return `[${this.accsDone}/${this.accsAmount}] modules: ${this.modulesDone}/${this.modulesAmount}`;
  }
}

// ─── DataBase class ────────────────────────────────────────────────────────────

class DataBase {
  constructor() {
    const cfg = settings.get();
    const dbDir = settings.resolvePath(cfg.paths.databasesDir);
    this.modulesDbPath = path.join(dbDir, 'modules.json');
    this.reportDbPath  = path.join(dbDir, 'report.json');
    this.statsDbPath   = path.join(dbDir, 'stats.json');

    this._key = null;
    this._writeLock = false;
    this._writeQueue = Promise.resolve();
    this.progress = null;

    // Ensure directories exist
    if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

    // Initialise JSON files if missing
    for (const [dbPath, def] of [
      [this.modulesDbPath, '{}'],
      [this.reportDbPath,  '{}'],
      [this.statsDbPath,   '{}'],
    ]) {
      if (!fs.existsSync(dbPath)) fs.writeFileSync(dbPath, def);
    }

    // Load proxies
    const proxyFile = settings.resolvePath(cfg.paths.proxiesFile);
    this.proxies = [];
    if (fs.existsSync(proxyFile)) {
      const raw = fs.readFileSync(proxyFile, 'utf-8').split('\n').map((l) => l.trim());
      this.proxies = raw.filter((p) => {
        return p && !p.startsWith('#') && !['https://log:pass@ip:port', 'http://log:pass@ip:port', 'log:pass@ip:port'].includes(p);
      }).map((p) => {
        if (!p.startsWith('http://') && !p.startsWith('https://')) return 'http://' + p;
        return p.replace(/^https:\/\//, 'http://');
      });
    }

    const amounts = this._getAmounts();
    if (amounts.groupsAmount !== undefined && amounts.groupsAmount > 0) {
      logger.info(`Loaded ${amounts.groupsAmount} groups`);
    } else if (amounts.modulesAmount !== undefined && amounts.modulesAmount > 0) {
      logger.info(`Loaded ${amounts.modulesAmount} modules for ${amounts.accsAmount} accounts`);
    }
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  _readDb(dbPath) {
    return JSON.parse(fs.readFileSync(dbPath, 'utf-8'));
  }

  _writeDb(dbPath, data) {
    fs.writeFileSync(dbPath, JSON.stringify(data, null, 2));
  }

  /** Serialise writes to prevent race conditions */
  _enqueue(fn) {
    this._writeQueue = this._writeQueue.then(fn).catch((err) => {
      logger.error(`DB write error: ${err.message}`);
    });
    return this._writeQueue;
  }

  _isGroupDb(modulesDb) {
    const first = Object.values(modulesDb)[0];
    return first && first.group_number !== undefined;
  }

  _getAmounts() {
    const db = this._readDb(this.modulesDbPath);
    const totalModules = Object.values(db).reduce((sum, v) => sum + (v.modules || []).length, 0);
    const accsAmount = Object.keys(db).length;

    if (db && this._isGroupDb(db)) {
      if (this.progress === null) this.progress = new ProgressTracker(accsAmount);
      else this.progress.accsAmount = accsAmount;
      this.progress.setModules(totalModules);
      return { groupsAmount: accsAmount, modulesAmount: totalModules };
    } else {
      if (this.progress === null) this.progress = new ProgressTracker(accsAmount);
      else this.progress.accsAmount = accsAmount;
      this.progress.setModules(totalModules);
      return { accsAmount, modulesAmount: totalModules };
    }
  }

  // ── Encryption / password ────────────────────────────────────────────────────

  async setPassword(directPassword = null) {
    if (this._key !== null) return;

    let password;
    if (directPassword !== null) {
      password = directPassword || 'capONE';
      if (!directPassword) logger.success('[+] Using default encryption password');
    } else {
      const raw = await promptPassword('\n[DB] Enter password to encrypt private keys (press Enter for default): ');
      password = raw || 'capONE';
      if (!raw) logger.success('[+] Using default encryption password');
    }

    const md5 = crypto.createHash('md5').update(password).digest();
    this._key = extendKey(md5);
  }

  async getPassword() {
    if (this._key !== null) return;

    const db = this._readDb(this.modulesDbPath);
    if (!Object.keys(db).length) return;

    // Try default password first
    const defaultMd5 = crypto.createHash('md5').update('capONE').digest();
    const defaultKey = extendKey(defaultMd5);

    let testKey;
    if (this._isGroupDb(db)) {
      testKey = Object.values(db)[0].wallets_data[0].encoded_privatekey;
    } else {
      testKey = Object.keys(db)[0];
    }
    if (!testKey) return;

    try {
      decryptPk(testKey, defaultKey);
      this._key = defaultKey;
      return;
    } catch (_) { /* wrong password, ask user */ }

    while (true) {
      try {
        const raw = await promptPassword('\n[DB] Enter password to decrypt private keys: ');
        const md5 = crypto.createHash('md5').update(raw).digest();
        const key = extendKey(md5);
        decryptPk(testKey, key);
        this._key = key;
        logger.success('[+] Access granted!');
        return;
      } catch (_) {
        logger.error('[-] Invalid password. Try again.');
      }
    }
  }

  encodePk(pk) {
    return encryptPk(pk, this._key);
  }

  decodePk(encoded) {
    return decryptPk(encoded, this._key);
  }

  // ── Create database ──────────────────────────────────────────────────────────

  async createModules(mode) {
    await this.setPassword();

    const cfg = settings.get();
    const pkFile = settings.resolvePath(cfg.paths.privatekeysFile);
    const proxyFile = settings.resolvePath(cfg.paths.proxiesFile);

    const rawKeys = fs.readFileSync(pkFile, 'utf-8').split('\n').map((l) => l.trim()).filter(Boolean);
    let rawProxies = fs.existsSync(proxyFile)
      ? fs.readFileSync(proxyFile, 'utf-8').split('\n').map((l) => l.trim()).filter(Boolean)
      : [];

    const privatekeys = [];
    const labels = [];

    for (const raw of rawKeys) {
      if (raw.startsWith('#')) continue;
      const parts = raw.split(':');
      if (parts.length === 2) {
        labels.push(parts[0]);
        privatekeys.push(parts[1]);
      } else if (parts.length === 1) {
        const address = getAddress(parts[0]);
        labels.push(`${address.slice(0, 6)}...${address.slice(-4)}`);
        privatekeys.push(parts[0]);
      } else {
        throw new Error(`Unexpected private key format: ${raw}`);
      }
    }

    if (!privatekeys.length) throw new Error('No private keys found in input file');

    // Normalise proxies
    let proxies;
    const badProxies = ['http://login:password@ip:port', '#'];
    rawProxies = rawProxies.filter((p) => p && !badProxies.some((b) => p.startsWith(b)));
    if (!rawProxies.length) {
      logger.warning('No proxies found — running without proxy');
      proxies = new Array(privatekeys.length).fill(null);
    } else {
      proxies = Array.from({ length: privatekeys.length }, (_, i) => rawProxies[i % rawProxies.length]);
    }

    // Clear report DB
    this._writeDb(this.reportDbPath, {});

    let newModules;
    if (mode === 102) {
      newModules = this._createPairTrades(privatekeys, proxies, labels);
    } else {
      newModules = this._createSingleTrades(privatekeys, proxies, labels);
    }

    this._writeDb(this.modulesDbPath, newModules);

    const amounts = this._getAmounts();
    if (mode === 102) {
      logger.success(`[+] Created database with ${amounts.groupsAmount} groups!`);
    } else {
      this._setAccountsModulesDone(newModules);
      logger.success(`[+] Created database for ${amounts.accsAmount} accounts with ${amounts.modulesAmount} modules!`);
    }
  }

  _createSingleTrades(privatekeys, proxies, labels) {
    const cfg = settings.get();
    const [minTrades, maxTrades] = cfg.trading.tradesCount;
    const result = {};
    for (let i = 0; i < privatekeys.length; i++) {
      const pk = privatekeys[i];
      const encodedPk = this.encodePk(pk);
      const address = getAddress(pk);
      const count = randint(minTrades, maxTrades);
      result[encodedPk] = {
        address,
        modules: Array.from({ length: count }, () => ({ module_name: 'vari', status: 'to_run' })),
        proxy: proxies[i] || null,
        label: labels[i],
      };
    }
    return result;
  }

  _createPairTrades(privatekeys, proxies, labels) {
    const cfg = settings.get();
    const [minPair, maxPair] = cfg.trading.pairSettings.pairAmount;
    const minPairSize = Math.max(2, Math.min(minPair, maxPair));

    if (privatekeys.length < minPairSize) {
      throw new Error(`Not enough accounts loaded, need at least ${minPairSize}`);
    }

    const [minTrades, maxTrades] = cfg.trading.tradesCount;
    const encodedKeys = privatekeys.map((pk) => this.encodePk(pk));
    const addresses = privatekeys.map((pk) => getAddress(pk));

    let allModules = [];
    for (let i = 0; i < privatekeys.length; i++) {
      const count = randint(minTrades, maxTrades);
      for (let j = 0; j < count; j++) {
        allModules.push({
          encoded_privatekey: encodedKeys[i],
          address: addresses[i],
          proxy: proxies[i] || null,
          label: labels[i],
        });
      }
    }

    const pairsList = [];
    while (true) {
      const pairSize = Math.max(2, randint(minPair, maxPair));
      // Unique wallets remaining
      const seen = new Set();
      const uniqueLeft = allModules.filter((m) => {
        if (seen.has(m.address)) return false;
        seen.add(m.address);
        return true;
      });

      if (uniqueLeft.length < minPairSize) break;
      const actualSize = uniqueLeft.length < pairSize ? minPairSize : pairSize;
      const pair = [];

      for (let k = 0; k < actualSize; k++) {
        const idx = Math.floor(Math.random() * uniqueLeft.length);
        const chosen = uniqueLeft.splice(idx, 1)[0];
        allModules.splice(allModules.findIndex((m) => m === chosen), 1);
        pair.push(chosen);
      }
      pairsList.push(pair);
    }

    const now = Date.now();
    const result = {};
    pairsList.forEach((pair, idx) => {
      const key = `${idx + 1}_${now}`;
      result[key] = {
        group_number: idx + 1,
        modules: [{ module_name: 'vari', status: 'to_run' }],
        wallets_data: pair,
      };
    });
    return result;
  }

  // ── Read modules/groups ──────────────────────────────────────────────────────

  /** Load all wallets directly from privatekeys + proxies files (no DB needed) */
  getWalletsFromFile() {
    const cfg = settings.get();
    const pkFile = settings.resolvePath(cfg.paths.privatekeysFile);
    const proxyFile = settings.resolvePath(cfg.paths.proxiesFile);

    const rawKeys = fs.readFileSync(pkFile, 'utf-8').split('\n').map((l) => l.trim()).filter(Boolean);
    let rawProxies = fs.existsSync(proxyFile)
      ? fs.readFileSync(proxyFile, 'utf-8').split('\n').map((l) => l.trim()).filter(Boolean)
      : [];

    const badProxies = ['http://login:password@ip:port', '#'];
    rawProxies = rawProxies.filter((p) => p && !badProxies.some((b) => p.startsWith(b)));

    const result = [];
    let pkIndex = 0;

    for (const raw of rawKeys) {
      if (raw.startsWith('#')) continue;
      const parts = raw.split(':');
      let pk, label;
      if (parts.length === 2) {
        label = parts[0];
        pk = parts[1];
      } else {
        pk = parts[0];
        const address = getAddress(pk);
        label = `${address.slice(0, 6)}...${address.slice(-4)}`;
      }

      const address = getAddress(pk);
      const proxy = rawProxies.length ? rawProxies[pkIndex % rawProxies.length] : null;
      const encoded = this.encodePk(pk);

      result.push({
        privatekey: pk,
        encoded_privatekey: encoded,
        proxy,
        address,
        label,
        module_info: { status: 'to_run' },
      });
      pkIndex++;
    }

    return result.length ? result : 'No more accounts left';
  }

  getAllModules(uniqueWallets = false) {
    const db = this._readDb(this.modulesDbPath);

    if (!Object.keys(db).length) return 'No more accounts left';
    if (this._isGroupDb(db)) throw new Error('Database is in group mode — use getAllGroups() instead');

    const cfg = settings.get();
    let result = [];

    for (const [encodedPk, walletData] of Object.entries(db)) {
      walletData.modules.forEach((moduleInfo, moduleIndex) => {
        if (moduleInfo.status !== 'to_run') return;
        const isLast = moduleIndex + 1 === walletData.modules.length;
        if (uniqueWallets && !isLast) return;

        result.push({
          privatekey: this.decodePk(encodedPk),
          encoded_privatekey: encodedPk,
          proxy: walletData.proxy || null,
          address: walletData.address,
          label: walletData.label,
          module_info: moduleInfo,
          last: isLast,
        });
      });
    }

    if (cfg.general.shuffleWallets) shuffle(result);
    return result;
  }

  getAllGroups() {
    const db = this._readDb(this.modulesDbPath);

    if (!Object.keys(db).length) return 'No more accounts left';
    if (!this._isGroupDb(db)) throw new Error('Database is in single mode — use getAllModules() instead');

    const result = [];
    for (const [groupIndex, groupData] of Object.entries(db)) {
      if (groupData.modules[0].status !== 'to_run') continue;
      result.push({
        group_index: groupIndex,
        group_number: groupData.group_number,
        module_info: groupData.modules[0],
        wallets_data: groupData.wallets_data.map((w) => ({
          encoded_privatekey: w.encoded_privatekey,
          privatekey: this.decodePk(w.encoded_privatekey),
          address: w.address,
          proxy: w.proxy || null,
          label: w.label,
        })),
      });
    }
    return result;
  }

  // ── Remove / mark done ───────────────────────────────────────────────────────

  async removeAccount(moduleData) {
    return this._enqueue(async () => {
      const db = this._readDb(this.modulesDbPath);
      this.progress.addAcc();

      if ([true, 'completed'].includes(moduleData.module_info.status)) {
        delete db[moduleData.encoded_privatekey];
      } else {
        db[moduleData.encoded_privatekey].modules = db[moduleData.encoded_privatekey].modules.map(
          (m) => ({ ...m, status: 'failed' })
        );
      }
      this._writeDb(this.modulesDbPath, db);
      return true;
    });
  }

  async removeModule(moduleData) {
    return this._enqueue(async () => {
      const db = this._readDb(this.modulesDbPath);
      const key = moduleData.encoded_privatekey;
      const modules = db[key].modules;
      let lastModule = false;

      const idx = modules.findIndex(
        (m) => m.module_name === moduleData.module_info.module_name && m.status === 'to_run'
      );

      if (idx !== -1) {
        this.progress.addModule();
        if ([true, 'completed'].includes(moduleData.module_info.status)) {
          modules.splice(idx, 1);
        } else {
          modules[idx].status = 'failed';
        }
      }

      const pendingCount = modules.filter((m) => m.status === 'to_run').length;
      if (pendingCount === 0) {
        this.progress.addAcc();
        lastModule = true;
      }

      if (!modules.length) delete db[key];
      this._writeDb(this.modulesDbPath, db);
      return lastModule;
    });
  }

  async removeGroup(groupData) {
    return this._enqueue(async () => {
      const db = this._readDb(this.modulesDbPath);
      this.progress.addAcc();

      if ([true, 'completed'].includes(groupData.module_info.status)) {
        delete db[groupData.group_index];
      } else {
        db[groupData.group_index].modules = [{
          module_name: groupData.module_info.module_name,
          status: 'failed',
        }];
      }
      this._writeDb(this.modulesDbPath, db);
      return true;
    });
  }

  // ── Reports ──────────────────────────────────────────────────────────────────

  async appendReport(encodedPk, text, success = null) {
    return this._enqueue(async () => {
      const db = this._readDb(this.reportDbPath);
      const statusEmoji = { true: '✅ ', false: '❌ ', null: '' };

      if (!db[encodedPk]) db[encodedPk] = { texts: [], success_rate: [0, 0] };
      db[encodedPk].texts.push(statusEmoji[String(success)] + text);

      if (success !== null) {
        db[encodedPk].success_rate[1]++;
        if (success === true) db[encodedPk].success_rate[0]++;
      }
      this._writeDb(this.reportDbPath, db);
    });
  }

  async getAccountReports({ key, label, lastModule, mode, address = null }) {
    return this._enqueue(async () => {
      const db = this._readDb(this.reportDbPath);

      let header = '';
      if (lastModule) header += `[${this.progress.accsDone}/${this.progress.accsAmount}] `;
      header += `<b>${label}</b>`;

      if (mode === 1) {
        const stats = this._getModulesDone(address);
        if (stats) header += `\n📌 [Trade ${stats[0]}/${stats[1]}]`;
      }

      if (header) header += '\n\n';

      if (db[key]) {
        const report = db[key];
        delete db[key];
        this._writeDb(this.reportDbPath, db);

        const logsText = report.texts.join('\n');
        let text = `${header}${logsText}`;
        if (report.success_rate[1]) {
          text += `\n\nSuccess rate ${report.success_rate[0]}/${report.success_rate[1]}`;
        }
        return text;
      }

      return header ? `${header}No actions` : null;
    });
  }

  // ── Stats helpers ────────────────────────────────────────────────────────────

  _setAccountsModulesDone(newModules) {
    const stats = this._readDb(this.statsDbPath);
    stats.modules_done = {};
    for (const [, v] of Object.entries(newModules)) {
      stats.modules_done[v.address] = [0, v.modules.length];
    }
    this._writeDb(this.statsDbPath, stats);
  }

  _getModulesDone(address) {
    const stats = this._readDb(this.statsDbPath);
    const done = stats.modules_done && stats.modules_done[address];
    if (!done) return null;
    done[0]++;
    if (done[0] >= done[1]) {
      delete stats.modules_done[address];
    } else {
      stats.modules_done[address] = done;
    }
    this._writeDb(this.statsDbPath, stats);
    return done;
  }
}

module.exports = DataBase;
