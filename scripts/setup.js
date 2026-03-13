#!/usr/bin/env node
/**
 * Postinstall setup script
 * Creates user_data directory structure and default config.json
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const dirs = [
  'user_data/privatekeys',
  'user_data/proxies',
  'databases',
];

console.log('[setup] Creating project directories...');
for (const dir of dirs) {
  const fullPath = path.join(ROOT, dir);
  if (!fs.existsSync(fullPath)) {
    fs.mkdirSync(fullPath, { recursive: true });
    console.log(`[setup]   Created: ${dir}/`);
  } else {
    console.log(`[setup]   Exists:  ${dir}/`);
  }
}

// Create placeholder files in user_data
const pkFile = path.join(ROOT, 'user_data/privatekeys/privatekeys.txt');
const proxyFile = path.join(ROOT, 'user_data/proxies/proxies.txt');

if (!fs.existsSync(pkFile)) {
  fs.writeFileSync(pkFile, '# One private key per line.\n# Optional label: MyWallet:0xYOUR_PRIVATE_KEY\n# Without label: 0xYOUR_PRIVATE_KEY\n');
  console.log('[setup]   Created: user_data/privatekeys/privatekeys.txt');
}

if (!fs.existsSync(proxyFile)) {
  fs.writeFileSync(proxyFile, '# One proxy per line. Leave empty to use no proxy.\n# Format: http://login:password@ip:port\n');
  console.log('[setup]   Created: user_data/proxies/proxies.txt');
}

// Create default config.json if not exists
const configFile = path.join(ROOT, 'config.json');
if (!fs.existsSync(configFile)) {
  const defaultConfig = {
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

  fs.writeFileSync(configFile, JSON.stringify(defaultConfig, null, 2));
  console.log('[setup]   Created: config.json');
}

console.log('[setup] Setup complete!');
console.log('[setup] Next steps:');
console.log('[setup]   1. Add private keys to user_data/privatekeys/privatekeys.txt');
console.log('[setup]   2. (Optional) Add proxies to user_data/proxies/proxies.txt');
console.log('[setup]   3. Edit config.json to configure trading parameters');
console.log('[setup]   4. Run CLI: npm start  |  Run GUI: npm run gui');
