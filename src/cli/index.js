#!/usr/bin/env node
'use strict';
/**
 * CLI entry point
 *
 * Interactive menu using inquirer.
 * Delegates execution to the shared core runner.
 */

const inquirer = require('inquirer');
const chalk = require('chalk');
const logger = require('../utils/logger');
const settings = require('../core/settings');
const DataBase = require('../core/database');
const { runner } = require('../core/runner');

// ── Banner ────────────────────────────────────────────────────────────────────

function printBanner() {
  console.log(chalk.cyan('\n╔══════════════════════════════════════════╗'));
  console.log(chalk.cyan('║') + chalk.white('         VARIATIONAL TRADING BOT          ') + chalk.cyan('║'));
  console.log(chalk.cyan('║') + chalk.gray('      omni.variational.io perpetuals      ') + chalk.cyan('║'));
  console.log(chalk.cyan('╚══════════════════════════════════════════╝\n'));
}

// ── Mode selection ────────────────────────────────────────────────────────────

async function chooseMode(db) {
  const cfg = settings.get();
  const sell = cfg.trading.sellSettings;

  const sellParts = [];
  if (sell.closePositions) sellParts.push('Sell All Positions');
  if (sell.cancelOrders) sellParts.push('Close Orders');
  const sellLabel = sellParts.length ? sellParts.join(' & ') : 'Sell Nothing';

  const { modeId } = await inquirer.prompt([{
    type: 'list',
    name: 'modeId',
    message: chalk.bold('🚀 Choose mode:'),
    choices: [
      { name: chalk.gray('  (Re)Create Database'), value: 0 },
      { name: `  1. Single Mode`, value: 1 },
      { name: `  2. Delta Neutral Mode`, value: 2 },
      { name: `  3. ${sellLabel}`, value: 3 },
      { name: `  4. Parse (account statistics)`, value: 5 },
      new inquirer.Separator(),
      { name: chalk.red('  Exit'), value: -1 },
    ],
  }]);

  if (modeId === -1) return null;

  if (modeId === 0) {
    // Database sub-menu
    const { dbMode } = await inquirer.prompt([{
      type: 'list',
      name: 'dbMode',
      message: '💾 Create new database:',
      choices: [
        { name: '  ← Back', value: -1 },
        { name: '  Create Single mode database', value: 101 },
        { name: '  Create Delta Neutral (groups) database', value: 102 },
      ],
    }]);

    if (dbMode === -1) return chooseMode(db);
    return { type: 'database', softId: dbMode };
  }

  return { type: 'module', softId: modeId };
}

// ── Main loop ─────────────────────────────────────────────────────────────────

async function main() {
  printBanner();
  logger.info('[•] Starting Variational Bot (CLI mode)');
  logger.info(`[•] Config: ${require('path').resolve(__dirname, '../../config.json')}`);

  let db;
  try {
    db = new DataBase();
  } catch (err) {
    logger.error(`[-] Database init error: ${err.message}`);
    process.exit(1);
  }

  while (true) {
    try {
      const mode = await chooseMode(db);
      if (!mode) {
        logger.info('[•] Exiting...');
        break;
      }

      if (mode.type === 'database') {
        logger.info(`[•] Creating database (mode ${mode.softId})...`);
        await db.createModules(mode.softId);

      } else if (mode.type === 'module') {
        await db.getPassword();
        const result = await runner({ mode: mode.softId, db });
        if (result === 'Ended') {
          console.log('');
          // Stay in loop to allow running again or choosing another mode
        }
      }

    } catch (err) {
      if (err.isTtyError || err.message?.includes('force closed') || err.constructor?.name === 'ExitPromptError') {
        logger.info('\n[•] Interrupted by user.');
        break;
      }
      logger.error(`[-] Error: ${err.message}`);
      if (process.env.DEBUG) console.error(err.stack);
    }
  }

  logger.info('[•] Bot stopped.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
