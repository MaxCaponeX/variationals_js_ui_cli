'use strict';
/**
 * Sleep utilities
 */

const logger = require('./logger');
const stopSignal = require('./stopSignal');

/** Async sleep for `ms` milliseconds, interruptible by stopSignal */
function sleep(ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    // Poll stop flag every 200ms during sleep
    const poll = setInterval(() => {
      if (stopSignal.isSet()) {
        clearTimeout(timer);
        clearInterval(poll);
        reject(new stopSignal.StopError());
      }
    }, 200);
    // Clean up poll when sleep resolves normally
    const orig = resolve;
    setTimeout(() => clearInterval(poll), ms + 50);
  });
}

/** Async sleep for `seconds` seconds, with a countdown log every 30s */
async function asyncSleep(seconds, label = null) {
  stopSignal.check();
  const prefix = label ? `${label} | ` : '';

  // Skip log for short sleeps (polling, retries)
  if (seconds >= 5) {
    logger.debug(`${prefix}Sleeping ${seconds}s...`);
  }

  const interval = 30;
  let remaining = seconds;

  while (remaining > interval) {
    await sleep(interval * 1000);
    remaining -= interval;
    logger.debug(`${prefix}Ещё ${remaining}s...`);
  }

  if (remaining > 0) await sleep(remaining * 1000);
}

/** Return a random integer in [min, max] inclusive */
function randint(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** Return a random float in [min, max) */
function uniform(min, max) {
  return Math.random() * (max - min) + min;
}

/** Pick a random element from an array */
function choice(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** Shuffle array in place (Fisher-Yates) */
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

module.exports = { sleep, asyncSleep, randint, uniform, choice, shuffle };
