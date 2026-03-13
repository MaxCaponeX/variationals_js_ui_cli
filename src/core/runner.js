'use strict';
/**
 * Runner — orchestrates threads, semaphores, and per-address locking.
 *
 * Mirrors main.py: runner(), run_modules(), run_pair().
 */

const { Mutex } = require('async-mutex');
const logger = require('../utils/logger');
const { asyncSleep, randint } = require('../utils/sleep');
const settings = require('./settings');
const DataBase = require('./database');
const Browser = require('./browser');
const Wallet = require('./wallet');
const { Variational } = require('./variational');
const PairAccounts = require('./pairAccounts');
const TgReport = require('../utils/tgReport');

// ── Concurrency helpers ────────────────────────────────────────────────────────

class Semaphore {
  constructor(count) {
    this._count = count;
    this._queue = [];
  }

  async acquire() {
    if (this._count > 0) {
      this._count--;
      return;
    }
    await new Promise((resolve) => this._queue.push(resolve));
    this._count--;
  }

  release() {
    this._count++;
    if (this._queue.length) {
      this._count--;
      const next = this._queue.shift();
      next();
    }
  }

  async run(fn) {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

/** MultiLock: acquire locks for all addresses in sorted order to avoid deadlocks */
class MultiLock {
  constructor(addressLocks, addresses) {
    this.locks = [...addresses].sort().map((addr) => {
      if (!addressLocks.has(addr)) addressLocks.set(addr, new Mutex());
      return addressLocks.get(addr);
    });
    this._releases = [];
  }

  async acquire() {
    for (const lock of this.locks) {
      const release = await lock.acquire();
      this._releases.push(release);
    }
  }

  release() {
    for (const rel of this._releases.reverse()) rel();
    this._releases = [];
  }

  async run(fn) {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

// ── Module runner ──────────────────────────────────────────────────────────────

function initializeAccount(moduleData, db, groupData = null) {
  const browser = new Browser({
    proxy: moduleData.proxy,
    address: moduleData.address,
    db,
  });
  const wallet = new Wallet({
    privatekey: moduleData.privatekey,
    encodedPk: moduleData.encoded_privatekey,
    label: moduleData.label,
    db,
  });
  const variational = new Variational({ wallet, browser, label: moduleData.label, groupData });

  if (browser.proxy) {
    variational.log(`Got proxy <white>${browser.proxy}</white>`);
  } else {
    variational.log(`<yellow>Running without proxy</yellow>`);
  }

  return variational;
}

async function threadSleep(label, sleepHistory, threads, betweenThreads) {
  if (sleepHistory.length < threads) {
    if (sleepHistory.length === 0) {
      sleepHistory.push(0);
    } else {
      sleepHistory.push(randint(...betweenThreads));
    }
    const toSleep = sleepHistory[sleepHistory.length - 1];
    if (toSleep) {
      logger.debug(`[•] ${label} | Sleep ${toSleep}s before start...`);
      await asyncSleep(toSleep, label);
    }
  }
}

async function runModules({ mode, moduleData, sem, sleepHistory, addressLocks, db }) {
  const cfg = settings.get();
  const addrLock = addressLocks.get(moduleData.address) || (() => {
    const m = new Mutex();
    addressLocks.set(moduleData.address, m);
    return m;
  })();

  const release = await addrLock.acquire();
  try {
    await sem.run(async () => {
      await threadSleep(moduleData.label, sleepHistory, cfg.general.threads, cfg.sleep.betweenThreads);

      let variational = null;
      try {
        variational = initializeAccount(moduleData, db);
        moduleData.module_info.status = await variational.run(mode);

      } catch (err) {
        logger.error(`[-] Soft | ${moduleData.address} | Global error: ${err.message}`);
        await db.appendReport(moduleData.encoded_privatekey, String(err.message), false);

      } finally {
        let lastModule;
        if (variational) {
          // no explicit session close needed with axios
        }

        if (mode === 1) {
          lastModule = await db.removeModule(moduleData);
        } else {
          lastModule = await db.removeAccount(moduleData);
        }

        const reports = await db.getAccountReports({
          key: moduleData.encoded_privatekey,
          address: moduleData.address,
          label: moduleData.label,
          lastModule,
          mode,
        });
        if (reports) await new TgReport().sendLog(reports);
        await asyncSleep(randint(...cfg.sleep.afterAccount));
      }
    });
  } finally {
    release();
  }
}

async function runPair({ mode, groupData, sem, sleepHistory, db }) {
  const cfg = settings.get();
  const addresses = groupData.wallets_data.map((w) => w.address);
  const multiLock = new MultiLock(new Map(), addresses);

  await multiLock.run(async () => {
    await sem.run(async () => {
      await threadSleep(
        `Group ${groupData.group_number}`, sleepHistory,
        cfg.general.threads, cfg.sleep.betweenThreads
      );

      let variationalAccounts = [];
      try {
        variationalAccounts = groupData.wallets_data.map((wd) =>
          initializeAccount(wd, db, groupData)
        );
        groupData.module_info.status = await new PairAccounts({
          accounts: variationalAccounts,
          groupData,
        }).run();

      } catch (err) {
        logger.error(`[-] Group ${groupData.group_number} | Global error: ${err.message}`);
        await db.appendReport(groupData.group_index, String(err.message), false);

      } finally {
        await db.removeGroup(groupData);

        const reports = await db.getAccountReports({
          key: groupData.group_index,
          label: `Group ${groupData.group_number}`,
          lastModule: false,
          mode,
        });
        if (reports) await new TgReport().sendLog(reports);

        if (groupData.module_info.status === true) {
          await asyncSleep(randint(...cfg.sleep.afterAccount));
        } else {
          await asyncSleep(10);
        }
      }
    });
  });
}

// ── Main runner ───────────────────────────────────────────────────────────────

async function runner({ mode, db, onProgress = null }) {
  const cfg = settings.get();
  const sem = new Semaphore(cfg.general.threads);
  const addressLocks = new Map();
  const sleepHistory = [];

  logger.info(`[•] Runner started | Mode ${mode} | Threads: ${cfg.general.threads}`);

  if (mode === 2) {
    // Delta neutral mode — grouped accounts
    const allGroups = db.getAllGroups();
    if (allGroups === 'No more accounts left') {
      logger.warning('[!] No groups in database. Create database first.');
      return 'Ended';
    }

    logger.info(`[•] Running ${allGroups.length} group(s) in delta neutral mode`);
    await Promise.all(
      allGroups.map((groupData) =>
        runPair({ mode, groupData, sem, sleepHistory, db })
      )
    );

  } else {
    // Single / sell / parse modes
    const uniqueWallets = [3, 4, 5].includes(mode);
    const allModules = db.getAllModules(uniqueWallets);

    if (allModules === 'No more accounts left') {
      logger.warning('[!] No modules in database. Create database first.');
      return 'Ended';
    }

    logger.info(`[•] Running ${allModules.length} module(s)`);
    await Promise.all(
      allModules.map((moduleData) =>
        runModules({ mode, moduleData, sem, sleepHistory, addressLocks, db })
      )
    );
  }

  logger.success('[+] All accounts done.');
  return 'Ended';
}

module.exports = { runner };
