'use strict';
/**
 * Sleep utilities
 */

const logger = require('./logger');

/** Async sleep for `ms` milliseconds */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Async sleep for `seconds` seconds */
async function asyncSleep(seconds) {
  logger.debug(`Sleeping ${seconds}s...`);
  await sleep(seconds * 1000);
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
