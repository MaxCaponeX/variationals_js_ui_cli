'use strict';
/**
 * PairAccounts — Delta Neutral mode.
 *
 * Mirrors variational.py:PairAccounts.
 * Opens opposing long/short positions across a group of accounts,
 * waits for the configured hold time, then closes them all.
 */

const logger = require('../utils/logger');
const { asyncSleep, randint, uniform, choice, shuffle } = require('../utils/sleep');
const settings = require('./settings');
const { getToken } = require('./config');
const { roundCut } = require('./variational');

class PairAccounts {
  constructor({ accounts, groupData }) {
    this.accounts = accounts;              // array of Variational instances
    this.groupNumber = `Group ${groupData.group_number}`;
    this.groupIndex = groupData.group_index;
  }

  async run() {
    await Promise.all(this.accounts.map((acc) => acc.loginAccount()));
    await this.openAndClosePosition();
    return true;
  }

  // ── Main flow ────────────────────────────────────────────────────────────────

  async openAndClosePosition() {
    const cfg = settings.get();
    const orderType = cfg.trading.futuresLimits.orderType.toLowerCase();
    if (!['market', 'limit'].includes(orderType)) {
      throw new Error(`Unexpected order type "${orderType}"`);
    }

    // Cancel all existing positions if configured
    if (cfg.trading.tradeAmounts.cancelAllBefore) {
      let soldAny = false;
      for (const acc of this._randomized(this.accounts)) {
        const sold = await acc.sellAll(true);
        if (sold) soldAny = true;
      }
      if (soldAny) await asyncSleep(randint(...cfg.sleep.afterSellAll));
    }

    // Choose token and wait for price range
    const tokenName = choice(Object.keys(cfg.tokens));
    const tokenCfg = cfg.tokens[tokenName];
    let firstCheck = true;

    while (true) {
      const prices = await this.accounts[0].getTokenPrice(tokenName);
      if (prices.average >= tokenCfg.prices[0] && prices.average <= tokenCfg.prices[1]) break;
      if (firstCheck) {
        firstCheck = false;
        const tData = getToken(tokenName);
        this.log(
          `${tokenName} price ${roundCut(prices.average, tData.priceDecimals)}. ` +
          `Waiting for range ${tokenCfg.prices[0]}-${tokenCfg.prices[1]}...`
        );
      }
      await asyncSleep(5);
    }

    // Calculate delta-neutral positions
    const tokenPrices = await this.accounts[0].getTokenPrice(tokenName);
    const tradeAmounts = await this._getTradeAmounts();
    const tData = getToken(tokenName);
    const openValues = this._calculateDeltaNeutralAmounts({
      decimals: tData.sizeDecimals,
      minAmount: tradeAmounts[0] / tokenPrices.average,
      maxAmount: tradeAmounts[1] / tokenPrices.average,
      minLeverage: tokenCfg.leverage[0],
      maxLeverage: tokenCfg.leverage[1],
    });

    // Verify balances
    await Promise.all(
      this.accounts.map((acc) =>
        acc.checkForBalance(openValues[acc.wallet.address].leveraged_amount * tokenPrices.average)
      )
    );

    // Set leverage for each account
    for (const acc of this._randomized(this.accounts)) {
      await acc.changeLeverage(tokenName, openValues[acc.wallet.address].leverage);
    }

    // Determine which account will use limit order (highest leveraged amount)
    let limitAccount = null;
    let marketAccounts = [...this.accounts];

    if (orderType === 'limit') {
      const maxAddr = Object.entries(openValues).reduce(
        (best, [addr, data]) => data.leveraged_amount > (openValues[best] || { leveraged_amount: -Infinity }).leveraged_amount ? addr : best,
        Object.keys(openValues)[0]
      );
      limitAccount = this.accounts.find((a) => a.wallet.address === maxAddr) || null;
      marketAccounts = this.accounts.filter((a) => a.wallet.address !== maxAddr);
    }

    // Open positions
    let limitOpenData = null;
    if (limitAccount) {
      const av = openValues[limitAccount.wallet.address];
      limitOpenData = await limitAccount.createOrder({
        tokenName,
        orderSide: av.side === 'Long' ? 'buy' : 'sell',
        orderType: 'limit',
        tokenAmount: av.leveraged_amount,
      });
    }

    // Open market accounts in parallel with staggered delays
    const openTasks = [];
    let toSleepTotal = 0;
    for (let i = 0; i < marketAccounts.length; i++) {
      const acc = marketAccounts[i];
      const toSleep = i === 0 ? 0 : toSleepTotal + randint(...cfg.sleep.betweenOpenOrders);
      if (i > 0) toSleepTotal += randint(...cfg.sleep.betweenOpenOrders);
      const av = openValues[acc.wallet.address];
      openTasks.push(
        acc.createOrder({
          tokenName,
          orderSide: av.side === 'Long' ? 'buy' : 'sell',
          orderType: 'market',
          tokenAmount: av.leveraged_amount,
          toSleep,
        })
      );
    }

    let openedPositions;
    try {
      const marketResults = await Promise.all(openTasks);
      openedPositions = [...marketResults];
      if (limitOpenData) openedPositions.push(limitOpenData);
    } catch (err) {
      this.log(`Failed to open ${tokenName} orders: ${err.message}. Closing all...`, '-', 'ERROR');
      await this.accounts.at(-1).wallet.db.appendReport(
        this.accounts.at(-1).encodedPkey,
        `failed to open ${tokenName} order`,
        false,
      );
      for (const acc of this._randomized(this.accounts)) await acc.sellAll();
      return false;
    }

    // Hold period + liquidation watch
    const holdSec = randint(...cfg.trading.pairSettings.positionHold);
    this.log(`Sleeping ${holdSec}s before closing positions...`);
    const liquidatedAcc = await this._waitForLiquidation(tokenName, holdSec);

    if (liquidatedAcc) {
      for (const acc of this._randomized(this.accounts)) await acc.sellAll();
      await this._printBalances();
      return true;
    }

    // Build position map for close phase
    const posMap = {};
    for (let i = 0; i < marketAccounts.length; i++) {
      posMap[marketAccounts[i].wallet.address] = openedPositions[i];
    }
    if (limitAccount && limitOpenData) {
      posMap[limitAccount.wallet.address] = limitOpenData;
    }

    // Close limit account first
    let limitCloseData = null;
    if (limitAccount) {
      const av = openValues[limitAccount.wallet.address];
      const closeSide = av.side === 'Long' ? 'sell' : 'buy';
      limitCloseData = await limitAccount.createOrder({
        tokenName,
        orderSide: closeSide,
        orderType: 'limit',
        tokenAmount: posMap[limitAccount.wallet.address].qty,
        previousPos: posMap[limitAccount.wallet.address],
      });
    }

    // Close market accounts in parallel with staggered delays
    const closeTasks = [];
    const randomizedMarket = this._randomized(marketAccounts);
    toSleepTotal = 0;
    for (let i = 0; i < randomizedMarket.length; i++) {
      const acc = randomizedMarket[i];
      const toSleep = i === 0 ? 0 : toSleepTotal + randint(...cfg.sleep.betweenCloseOrders);
      if (i > 0) toSleepTotal += randint(...cfg.sleep.betweenCloseOrders);
      const av = openValues[acc.wallet.address];
      const closeSide = av.side === 'Long' ? 'sell' : 'buy';
      closeTasks.push(
        acc.createOrder({
          tokenName,
          orderSide: closeSide,
          orderType: 'market',
          tokenAmount: posMap[acc.wallet.address].qty,
          previousPos: posMap[acc.wallet.address],
          toSleep,
        })
      );
    }

    let closedPositions;
    try {
      const closeResults = await Promise.all(closeTasks);
      closedPositions = [...closeResults];
      if (limitCloseData) closedPositions.push(limitCloseData);
    } catch (err) {
      this.log(`Failed to close ${tokenName} position: ${err.message}. Closing all...`, '-', 'ERROR');
      await this.accounts.at(-1).wallet.db.appendReport(
        this.accounts.at(-1).encodedPkey,
        `failed to close ${tokenName} position`,
        false,
      );
      for (const acc of this._randomized(this.accounts)) await acc.sellAll();
      return false;
    }

    // Calculate PnL
    let totalProfit = 0;
    let totalVolume = 0;
    for (let i = 0; i < openedPositions.length; i++) {
      const op = openedPositions[i];
      const cl = closedPositions[i];
      const buyVal = parseFloat(op.qty) * parseFloat(op.price);
      const sellVal = parseFloat(cl.qty) * parseFloat(cl.price);
      const posProfit = op.side === 'sell' ? buyVal - sellVal : sellVal - buyVal;
      totalProfit += posProfit;
      totalVolume += buyVal + sellVal;
    }

    totalProfit = roundCut(totalProfit, 2);
    totalVolume = roundCut(totalVolume, 1);
    const costPer100k = roundCut(-totalProfit / totalVolume * 100000, 3);
    const profitColor = totalProfit >= 0 ? 'green' : 'red';

    this.log(
      `Profit: <${profitColor}>${totalProfit}$</${profitColor}> | ` +
      `Total Volume: ${totalVolume}$ | ` +
      `100k$ Volume Cost: <green>${costPer100k}$</green>`,
      '+', 'INFO'
    );

    await this.accounts.at(-1).wallet.db.appendReport(
      this.accounts.at(-1).encodedPkey,
      `\n💰 <b>profit ${totalProfit}$</b>\n💵 <b>volume ${totalVolume}$</b>\n💍 <b>100k$ volume cost: ${costPer100k}$</b>`,
    );

    await this._printBalances();
    return true;
  }

  // ── Liquidation watch ─────────────────────────────────────────────────────────

  async _waitForLiquidation(tokenName, toSleep, checkInterval = 10) {
    let slept = 0;
    const startedTs = Date.now();

    while (slept < toSleep * 1000) {
      const waitMs = Math.min(checkInterval * 1000, toSleep * 1000 - slept);
      await asyncSleep(waitMs / 1000);
      slept += waitMs;

      const liquidations = await Promise.all(
        this.accounts.map((acc) => acc.browser.getTrades(tokenName, {}, true))
      );

      for (let i = 0; i < this.accounts.length; i++) {
        const liq = liquidations[i];
        if (liq) {
          const liqTs = new Date(liq.created_at).getTime();
          if (liqTs > startedTs) {
            this.accounts[i].log(`${tokenName} position liquidated! Closing all...`, '!', 'ERROR');
            await this.accounts.at(-1).wallet.db.appendReport(
              this.accounts.at(-1).encodedPkey,
              `${this.accounts[i].prefix}account liquidated!`,
              false,
            );
            return this.accounts[i];
          }
        }
      }
    }
    return null;
  }

  // ── Trade amount calculator ───────────────────────────────────────────────────

  async _getTradeAmounts() {
    const cfg = settings.get();
    const balances = await Promise.all(this.accounts.map((acc) => acc.browser.getBalance()));
    const minBalance = Math.min(...balances);
    const amounts = cfg.trading.tradeAmounts.amount;

    if (amounts[0] !== 0 || amounts[1] !== 0) {
      if (amounts[0] > minBalance) {
        throw new Error(`Not enough balance, need ${amounts[0]}$, have ${roundCut(minBalance, 2)}$`);
      }
      return [amounts[0], Math.min(amounts[1], minBalance)];
    }

    const pct = cfg.trading.tradeAmounts.percent;
    return [minBalance * pct[0] / 100, minBalance * pct[1] / 100];
  }

  // ── Delta neutral position calculator ────────────────────────────────────────

  _calculateDeltaNeutralAmounts({ decimals, minAmount, maxAmount, minLeverage, maxLeverage }) {
    const cfg = settings.get();
    const multiplier = Math.pow(10, decimals);
    const minAmountInt = Math.floor(minAmount * multiplier);
    const maxAmountInt = Math.floor(maxAmount * multiplier);

    // Adjust for odd number of accounts
    let adjMinAmount = minAmount;
    if (this.accounts.length % 2 !== 0) {
      const leveragedDiff = (maxAmount * maxLeverage) / (minAmount * minLeverage);
      if (this.accounts.length === 3) {
        if (leveragedDiff < 2.2) {
          adjMinAmount = (maxAmount * maxLeverage) / (minLeverage * 2.2);
        }
      } else {
        if (leveragedDiff < 2) {
          adjMinAmount = (maxAmount * maxLeverage) / (minLeverage * 2);
        }
      }
    }

    for (let attempt = 0; attempt < 1000; attempt++) {
      const result = this._tryGeneratePositions(
        Math.floor(adjMinAmount * multiplier), maxAmountInt, multiplier,
        minLeverage, maxLeverage, cfg
      );
      if (result) return result;
    }
    throw new Error('Failed to calculate delta neutral positions after 1000 attempts');
  }

  _tryGeneratePositions(minAmountInt, maxAmountInt, multiplier, minLeverage, maxLeverage, cfg) {
    const addresses = this._randomized(this.accounts).map((a) => a.wallet.address);
    const n = addresses.length;
    if (n < 2) return null;

    const numLongs = randint(1, n - 1);
    const numShorts = n - numLongs;
    const [sourceNum, sourceSide, targetNum, targetSide] =
      numLongs <= numShorts
        ? [numLongs, 'Long', numShorts, 'Short']
        : [numShorts, 'Short', numLongs, 'Long'];

    const sourcePositions = [];
    let targetNotionalInt = 0;

    for (let i = 0; i < sourceNum; i++) {
      const amt = randint(minAmountInt, maxAmountInt);
      const lev = randint(minLeverage, maxLeverage);
      sourcePositions.push({
        side: sourceSide,
        amount: amt / multiplier,
        leverage: lev,
        leveraged_amount: (amt / multiplier) * lev,
      });
      targetNotionalInt += amt * lev;
    }

    const minNotionalPerPos = minAmountInt * minLeverage;
    const maxNotionalPerPos = maxAmountInt * maxLeverage;
    const notionalParts = this._distributeIntSum(
      targetNotionalInt, targetNum, minNotionalPerPos, maxNotionalPerPos
    );
    if (!notionalParts) return null;

    const targetPositions = [];
    for (const part of notionalParts) {
      const pair = this._findFactors(part, minAmountInt, maxAmountInt, minLeverage, maxLeverage);
      if (!pair) return null;
      const [amt, lev] = pair;
      targetPositions.push({
        side: targetSide,
        amount: amt / multiplier,
        leverage: lev,
        leveraged_amount: (amt / multiplier) * lev,
      });
    }

    const allPositions = [...targetPositions, ...sourcePositions];

    // Apply delta_diff randomization
    const { deltaDiff } = cfg.trading.tradeAmounts;
    if (deltaDiff[0] !== 0 || deltaDiff[1] !== 0) {
      for (const pos of allPositions) {
        const rawPct = uniform(...deltaDiff) / 100;
        const sign = Math.random() < 0.5 ? -1 : 1;
        const pct = 1 + sign * rawPct;
        pos.amount *= pct;
        pos.leveraged_amount *= pct;
      }
    }

    const result = {};
    for (let i = 0; i < addresses.length; i++) {
      result[addresses[i]] = allPositions[i];
    }
    return result;
  }

  _findFactors(targetNotionalInt, minAmountInt, maxAmountInt, minLeverage, maxLeverage) {
    const valid = [];
    for (let lev = minLeverage; lev <= maxLeverage; lev++) {
      if (targetNotionalInt % lev === 0) {
        const amt = targetNotionalInt / lev;
        if (amt >= minAmountInt && amt <= maxAmountInt) valid.push([amt, lev]);
      }
    }
    return valid.length ? valid[Math.floor(Math.random() * valid.length)] : null;
  }

  _distributeIntSum(total, numParts, minVal, maxVal) {
    if (numParts === 0) return [];
    const parts = [];
    let remaining = total;

    for (let i = 0; i < numParts - 1; i++) {
      const upper = Math.min(maxVal, remaining - (numParts - 1 - i) * minVal);
      const lower = Math.max(minVal, remaining - (numParts - 1 - i) * maxVal);
      if (lower > upper) return null;
      const part = randint(lower, upper);
      parts.push(part);
      remaining -= part;
    }

    if (remaining < minVal || remaining > maxVal) return null;
    parts.push(remaining);
    shuffle(parts);
    return parts;
  }

  // ── Utility ───────────────────────────────────────────────────────────────────

  async _printBalances() {
    const balances = await Promise.all(this.accounts.map((acc) => acc.browser.getBalance()));
    const lines = this.accounts.map((acc, i) => `  ${acc.label}: ${roundCut(balances[i], 2)}$`);
    this.log('Account balances:\n' + lines.join('\n'), '+', 'SUCCESS');
  }

  _randomized(list) {
    const copy = [...list];
    shuffle(copy);
    return copy;
  }

  log(text, smile = '•', level = 'DEBUG') {
    logger[level.toLowerCase()](`[${smile}] <white>${this.groupNumber}</white> | ${text}`);
  }
}

module.exports = PairAccounts;
