'use strict';
/**
 * Centralized logger
 * Outputs timestamped, colored log messages to console.
 * In Electron GUI mode, also emits messages via IPC to the renderer process.
 */

const chalk = require('chalk');

// Emoji-based level icons
const ICONS = {
  DEBUG:   chalk.gray('•'),
  INFO:    chalk.cyan('+'),
  SUCCESS: chalk.green('+'),
  WARNING: chalk.yellow('!'),
  ERROR:   chalk.red('-'),
};

// Ansi color for level names
const COLORS = {
  DEBUG:   (t) => chalk.gray(t),
  INFO:    (t) => chalk.white(t),
  SUCCESS: (t) => chalk.green(t),
  WARNING: (t) => chalk.yellow(t),
  ERROR:   (t) => chalk.red(t),
};

/** Convert loguru-style <tag> colors to chalk */
function renderTags(text) {
  return text
    .replace(/<white>(.*?)<\/white>/g, (_, t) => chalk.white(t))
    .replace(/<green>(.*?)<\/green>/g, (_, t) => chalk.green(t))
    .replace(/<red>(.*?)<\/red>/g, (_, t) => chalk.red(t))
    .replace(/<yellow>(.*?)<\/yellow>/g, (_, t) => chalk.yellow(t))
    .replace(/<blue>(.*?)<\/blue>/g, (_, t) => chalk.blue(t))
    .replace(/<i>(.*?)<\/i>/g, (_, t) => chalk.italic(t))
    .replace(/<b>(.*?)<\/b>/g, (_, t) => chalk.bold(t))
    .replace(/<\/?[a-zA-Z/][^>]*>/g, ''); // strip any remaining tags
}

/** Strip all tags to get plain text for Telegram/IPC */
function stripTags(text) {
  return text.replace(/<\/?[^>]+>/g, '');
}

/** Global IPC emitter — set by electron.js when running in GUI mode */
let _ipcEmitter = null;
function setIpcEmitter(emitter) {
  _ipcEmitter = emitter;
}

function timestamp() {
  const d = new Date();
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  return chalk.gray(`${h}:${m}:${s}`);
}

// Strip leading [•], [+], [-], [!] prefixes already baked into message strings
function stripLeadingIcon(msg) {
  return msg.replace(/^\[[-•+!]\]\s*/, '');
}

function log(level, message) {
  const icon = ICONS[level] || ICONS.INFO;
  const colorFn = COLORS[level] || COLORS.INFO;
  const rendered = renderTags(stripLeadingIcon(message));
  console.log(`${timestamp()} | [${icon}] ${colorFn(rendered)}`);

  // Push to GUI if IPC emitter is set
  if (_ipcEmitter) {
    _ipcEmitter.emit('log', {
      level,
      message: stripTags(message),
      time: new Date().toISOString(),
    });
  }
}

const logger = {
  debug:   (msg) => log('DEBUG', msg),
  info:    (msg) => log('INFO', msg),
  success: (msg) => log('SUCCESS', msg),
  warning: (msg) => log('WARNING', msg),
  error:   (msg) => log('ERROR', msg),
  setIpcEmitter,
};

module.exports = logger;
