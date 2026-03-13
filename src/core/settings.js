'use strict';
/**
 * Settings manager — single source of truth for all configuration.
 *
 * Priority (highest → lowest):
 *   1. Runtime overrides set via setOverride()
 *   2. config.json on disk
 *   3. Built-in defaults
 *
 * Changes are persisted automatically when save() is called.
 */

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '../../config.json');

/** Default configuration — mirrors settings.py */
const DEFAULTS = {
  general: {
    shuffleWallets: true,
    retry: 3,
    threads: 3,
  },
  tokens: {
    SOL: { prices: [100, 140], leverage: [1, 10], maxSpread: 0.01, openPrice: [0.0, 0.0] },
    ETH: { prices: [2600, 3000], leverage: [1, 10], maxSpread: 0.01, openPrice: [0.0, 0.0] },
    BTC: { prices: [80000, 900000], leverage: [1, 10], maxSpread: 0.01, openPrice: [0.0, 0.0] },
  },
  trading: {
    tradesCount: [2, 4],
    futureActions: {
      sides: { Long: true, Short: true },
      types: { open: ['limit', 'market'], close: ['limit', 'market'] },
    },
    tradeAmounts: {
      amount: [20, 45.5],
      percent: [70, 90],
      deltaDiff: [0.05, 0.15],
      cancelAllBefore: true,
    },
    futuresLimits: {
      priceDiffAmount: [0.0, 0.0],
      priceDiffPercent: [0.03, 0.045],
      toWait: 1,
      orderType: 'limit',
    },
    stopLoss: {
      enable: true,
      lossDiffAmount: [0.0, 0.0],
      lossDiffPercent: [0.03, 0.045],
    },
    sellSettings: {
      cancelOrders: true,
      closePositions: true,
    },
    pairSettings: {
      pairAmount: [2, 3],
      positionHold: [40, 120],
    },
  },
  sleep: {
    betweenOrders: [5, 10],
    betweenThreads: [2, 5],
    afterAccount: [30, 40],
    betweenOpenOrders: [2, 8],
    betweenCloseOrders: [2, 8],
    afterSellAll: [5, 10],
  },
  telegram: {
    botToken: '',
    userIds: [],
  },
  paths: {
    privatekeysFile: 'user_data/privatekeys/privatekeys.txt',
    proxiesFile: 'user_data/proxies/proxies.txt',
    databasesDir: 'databases',
  },
};

/** Deep merge: target gets overwritten by source recursively */
function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] !== null &&
      typeof source[key] === 'object' &&
      !Array.isArray(source[key]) &&
      typeof target[key] === 'object' &&
      !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(target[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

let _config = deepMerge({}, DEFAULTS);
let _overrides = {};

/** Load config from disk (called once on startup, also callable on reload) */
function load() {
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
      const fromFile = JSON.parse(raw);
      _config = deepMerge(deepMerge({}, DEFAULTS), fromFile);
    } catch (e) {
      console.error(`[settings] Failed to parse config.json: ${e.message}. Using defaults.`);
      _config = deepMerge({}, DEFAULTS);
    }
  } else {
    _config = deepMerge({}, DEFAULTS);
  }
}

/** Save current config to disk */
function save(newConfig) {
  if (newConfig) {
    _config = deepMerge(deepMerge({}, DEFAULTS), newConfig);
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(_config, null, 2));
}

/** Get merged config (file + runtime overrides) */
function get() {
  if (Object.keys(_overrides).length) {
    return deepMerge(_config, _overrides);
  }
  return _config;
}

/** Apply runtime overrides (e.g., from CLI flags or GUI) */
function setOverride(partial) {
  _overrides = deepMerge(_overrides, partial);
}

/** Return the absolute path resolved from config root */
function resolvePath(relativePath) {
  return path.resolve(path.join(__dirname, '../../'), relativePath);
}

// Load on module import
load();

module.exports = { load, save, get, setOverride, resolvePath, DEFAULTS };
