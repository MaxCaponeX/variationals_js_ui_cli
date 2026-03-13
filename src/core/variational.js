'use strict';
/**
 * Variational — core trading logic for single-account mode.
 *
 * Mirrors variational.py:Variational exactly, minus the referral-code check
 * that was present in the original load_tokens_data() method.
 */

const logger = require('../utils/logger');
const { asyncSleep, randint, uniform, choice } = require('../utils/sleep');
const settings = require('./settings');
const { getAllTokens, addRuntimeToken, hasToken, getToken } = require('./config');
const TgReport = require('../utils/tgReport');

// ── Errors ────────────────────────────────────────────────────────────────────

class CustomError extends Error {}
class OnetimeError extends Error {}

// ── Math helpers ──────────────────────────────────────────────────────────────

/** Round a float down to `digits` decimal places (no rounding up) */
function roundCut(value, digits) {
  const num = parseFloat(value);
  if (digits === 0) return Math.trunc(num);
  const factor = Math.pow(10, digits);
  return Math.trunc(num * factor) / factor;
}

/** Count significant decimal digits in a number string */
function countDigits(numStr, anyDigit = false) {
  if (anyDigit) {
    const idx = numStr.indexOf('.');
    return idx === -1 ? 0 : numStr.length - idx - 1;
  }
  if (numStr.startsWith('0.')) {
    const after = numStr.slice(2);
    const firstOne = after.indexOf('1');
    return firstOne === -1 ? 0 : firstOne + 1;
  }
  return 0;
}

// ── Global parse state (shared across all Variational instances) ───────────────

let PARSED_FLAG = false;
let _parseLockPromise = null;

// ── Variational class ─────────────────────────────────────────────────────────

class Variational {
  constructor({ wallet, browser, label, groupData = null }) {
    this.wallet = wallet;
    this.browser = browser;
    this.encodedPkey = wallet.encodedPk;
    this.label = label;

    if (groupData) {
      this.groupNumber = groupData.group_number;
      this.encodedPkey = groupData.group_index;
      this.prefix = `[${label}] `;
    } else {
      this.groupNumber = null;
      this.prefix = '';
    }
  }

  // ── Entry points ────────────────────────────────────────────────────────────

  async run(mode) {
    await this.loginAccount();

    if (mode === 1) return await this.buySellPosition();
    if (mode === 3) { await this.sellAll(); return true; }
    if (mode === 5) return await this.parse();
    return null;
  }

  // ── Auth ─────────────────────────────────────────────────────────────────────

  async loginAccount() {
    const cfg = settings.get();
    const maxRetries = cfg.general.retry;
    let attempt = 0;

    while (attempt < maxRetries) {
      try {
        const registered = await this.browser.isAccountRegistered();
        if (!registered) {
          throw new CustomError('Account is not registered on omni.variational.io');
        }

        const signData = await this.browser.getSignData();
        const signature = this.wallet.signMessage(signData);
        this.log(`Signing in...`);

        while (true) {
          const result = await this.browser.authLogin(signature);
          if (result.success) {
            this.log(`Logged in successfully`, '+', 'SUCCESS');
            break;
          }
          this.log(`Login pending: ${result.log}`, '!', 'WARNING');
          await asyncSleep(result.toSleep || 5);
        }

        await this.loadTokensData();
        return;

      } catch (err) {
        if (err instanceof CustomError || err.name === 'StopError') throw err;
        attempt++;
        this.log(`Login attempt ${attempt}/${maxRetries} failed: ${err.message}`, '-', 'ERROR');
        if (attempt >= maxRetries) throw err;
        await asyncSleep(2);
      }
    }
  }

  async loadTokensData() {
    // Parse all supported assets from the API (done only once globally)
    if (!_parseLockPromise) {
      _parseLockPromise = this._doParse();
    }
    await _parseLockPromise;
  }

  async _doParse() {
    if (PARSED_FLAG) return;

    const cfg = settings.get();
    const configTokens = Object.keys(cfg.tokens);
    this.log(`Loading ${configTokens.length} token configuration(s)...`);

    const supported = await this.browser.getSupportedAssets();

    for (const asset of configTokens) {
      if (hasToken(asset)) continue;

      const assetData = supported[asset];
      if (!assetData) {
        this.log(`Token ${asset} not found in supported assets`, '!', 'WARNING');
        continue;
      }
      if (assetData[0].is_close_only_mode || !assetData[0].has_perp) {
        this.log(`Token ${asset} is not tradeable on this platform`, '!', 'WARNING');
        continue;
      }

      try {
        const indicative = await this.browser.getIndicative(asset, { price: assetData[0].price });
        const minSizeTick = indicative.qty_limits.bid.min_qty_tick;
        const minSize = parseFloat(indicative.qty_limits.bid.min_qty);
        addRuntimeToken(asset, {
          minSize,
          sizeDecimals: countDigits(minSizeTick),
          priceDecimals: Math.max(
            countDigits(indicative.ask, true),
            countDigits(indicative.bid, true),
          ),
        });
      } catch (e) {
        if (e.name === 'StopError') throw e;
        this.log(`Could not load token data for ${asset}: ${e.message}`, '!', 'WARNING');
      }
    }

    PARSED_FLAG = true;
    this.log(`Loaded ${configTokens.length} token(s): ${configTokens.join(', ')}`, '+', 'SUCCESS');
  }

  // ── Price helpers ─────────────────────────────────────────────────────────────

  async getTokenPrice(tokenName, tokenAmount = null) {
    const tokenData = getToken(tokenName);
    const amount = tokenAmount || tokenData.minSize;
    const indicative = await this.browser.getIndicative(tokenName, { amount: String(amount) });
    const ask = parseFloat(indicative.ask);
    const bid = parseFloat(indicative.bid);
    return {
      sell: ask,
      buy: bid,
      average: (ask + bid) / 2,
      spread: (1 - bid / ask) * 100,
      quote_id: indicative.quote_id,
    };
  }

  // ── Single mode ──────────────────────────────────────────────────────────────

  async buySellPosition() {
    const cfg = settings.get();

    if (cfg.trading.tradeAmounts.cancelAllBefore) {
      const soldAny = await this.sellAll(true);
      if (soldAny) await asyncSleep(randint(...cfg.sleep.afterSellAll));
    }

    const possibleSides = Object.entries(cfg.trading.futureActions.sides)
      .filter(([, enabled]) => enabled)
      .map(([side]) => side);

    if (!possibleSides.length) throw new CustomError('You must enable Long or Short in settings!');

    const futuresAction = choice(possibleSides); // 'Long' or 'Short'
    const tokenName = choice(Object.keys(cfg.tokens));
    const tokenCfg = cfg.tokens[tokenName];

    this.log(`Selected token: <white>${tokenName}</white>, direction: <white>${futuresAction}</white>`);

    // Wait for price to be in configured range
    let firstCheck = true;
    while (true) {
      const prices = await this.getTokenPrice(tokenName);
      if (prices.average >= tokenCfg.prices[0] && prices.average <= tokenCfg.prices[1]) break;
      if (firstCheck) {
        firstCheck = false;
        const tokenData = getToken(tokenName);
        this.log(
          `${tokenName} price ${roundCut(prices.average, tokenData.priceDecimals)}. ` +
          `Waiting for range ${tokenCfg.prices[0]}-${tokenCfg.prices[1]}...`
        );
      }
      await asyncSleep(5);
    }

    const { usdAmount, leverage } = await this.calculateUsdAmountForOrder(tokenName);
    await this.changeLeverage(tokenName, leverage);

    const orderSide = futuresAction === 'Long' ? 'buy' : 'sell';
    const openTypes = cfg.trading.futureActions.types.open;
    const closeTypes = cfg.trading.futureActions.types.close;

    let profit, volume;

    if (cfg.trading.stopLoss.enable && closeTypes.length === 1 && closeTypes[0] === 'limit') {
      // Open with take-profit and stop-loss in one order
      const orderData = await this.createOrder({
        tokenName, orderSide, orderType: choice(openTypes), usdAmount, stopLoss: true,
      });
      profit = orderData.total_profit;
      volume = orderData.total_volume;

    } else {
      // Open position
      const buyOrderData = await this.createOrder({
        tokenName, orderSide, orderType: choice(openTypes), usdAmount,
      });
      await asyncSleep(randint(...cfg.sleep.betweenOrders));

      // Close position
      const closeOrderType = choice(closeTypes);
      const closeSide = orderSide === 'buy' ? 'sell' : 'buy';
      let customPrice = null;
      if (closeOrderType === 'limit') {
        customPrice = this._calculateLimitOrderPrice(parseFloat(buyOrderData.price), orderSide);
      }

      const sellOrderData = await this.createOrder({
        tokenName,
        orderSide: closeSide,
        orderType: closeOrderType,
        tokenAmount: buyOrderData.qty,
        customPrice,
        previousPos: buyOrderData,
      });

      const tokenData = getToken(tokenName);
      const buyValue = parseFloat(buyOrderData.qty) * parseFloat(buyOrderData.price);
      const sellValue = parseFloat(sellOrderData.qty) * parseFloat(sellOrderData.price);
      profit = roundCut(
        orderSide === 'buy' ? sellValue - buyValue : buyValue - sellValue, 2
      );
      volume = roundCut(buyValue + sellValue, 1);
    }

    const profitColor = profit >= 0 ? 'green' : 'red';
    this.log(`Volume ${volume}$ | Profit: <${profitColor}>${profit}$</${profitColor}>`, '+', 'INFO');
    await this.wallet.db.appendReport(
      this.encodedPkey,
      `\n🎰 <b>Profit ${profit}$\n📌 Volume ${volume}$</b>`,
    );

    return true;
  }

  // ── Sell all ──────────────────────────────────────────────────────────────────

  async sellAll(silent = false) {
    const cfg = settings.get();
    let soldAny = false;

    if (cfg.trading.sellSettings.cancelOrders) {
      const openOrders = await this.browser.getOrders(null, { status: 'pending' });
      for (const order of openOrders) {
        await this.browser.cancelOrder(order.rfq_id);
        soldAny = true;
        const tName = order.instrument.underlying;
        const side = order.side === 'buy' ? 'Long' : 'Short';
        this.log(`Cancelled <white>${side} ${order.qty} ${tName}</white> order`);
        await this.wallet.db.appendReport(
          this.encodedPkey,
          `${this.prefix}cancel ${side} ${order.qty} ${tName} order`,
          true,
        );
      }
    }

    if (cfg.trading.sellSettings.closePositions) {
      const positions = await this.browser.getPositions();
      const sorted = [...positions].sort(
        (a, b) =>
          Math.abs(parseFloat(b.position_info.qty)) * parseFloat(b.position_info.avg_entry_price) -
          Math.abs(parseFloat(a.position_info.qty)) * parseFloat(a.position_info.avg_entry_price)
      );

      for (let i = 0; i < sorted.length; i++) {
        const pos = sorted[i];
        const tName = pos.position_info.instrument.underlying;
        const qty = parseFloat(pos.position_info.qty);
        const closeSide = qty > 0 ? 'sell' : 'buy';
        if (i > 0) await asyncSleep(randint(...cfg.sleep.betweenCloseOrders));
        await this.createOrder({
          tokenName: tName,
          orderSide: closeSide,
          orderType: 'market',
          tokenAmount: Math.abs(qty),
          previousPos: pos,
        });
        soldAny = true;
      }
    }

    if (!soldAny && !silent) {
      this.log('No positions found to sell', '•', 'INFO');
      await this.wallet.db.appendReport(
        this.encodedPkey,
        `${this.prefix}no positions found to sell`,
        true,
      );
    }
    return soldAny;
  }

  // ── Create order ──────────────────────────────────────────────────────────────

  async createOrder({
    tokenName, orderSide, orderType, usdAmount = null, tokenAmount = null,
    customPrice = null, previousPos = null, stopLoss = false, toSleep = 0,
  }) {
    const cfg = settings.get();
    const tokenData = getToken(tokenName);
    const maxRetries = cfg.general.retry;
    let attempt = 0;

    while (true) {
      try {
        return await this._createOrderOnce({
          tokenName, orderSide, orderType, usdAmount, tokenAmount,
          customPrice, previousPos, stopLoss, toSleep, tokenData,
        });
      } catch (err) {
        if (err instanceof CustomError || err instanceof OnetimeError) throw err;
        if (err.name === 'StopError') throw err;
        attempt++;
        this.log(`Order error attempt ${attempt}/${maxRetries}: ${err.message}`, '-', 'ERROR');
        if (attempt >= maxRetries) throw err;
        await asyncSleep(2);
      }
    }
  }

  async _createOrderOnce({
    tokenName, orderSide, orderType, usdAmount, tokenAmount,
    customPrice, previousPos, stopLoss, toSleep, tokenData,
  }) {
    const cfg = settings.get();

    const actionName = previousPos
      ? `Sell ${orderSide === 'sell' ? 'Long' : 'Short'}`
      : (orderSide === 'buy' ? 'Long' : 'Short');

    if (previousPos) {
      const currentPos = await this.browser.getPositions(tokenName);
      if (!currentPos) throw new CustomError(`No ${tokenName} position found to sell`);
      const currentSize = Math.abs(parseFloat(currentPos.position_info.qty));
      if (tokenAmount && currentSize !== parseFloat(tokenAmount)) {
        this.log(
          `${tokenName} position size mismatch (expected ${tokenAmount}, got ${currentSize}), using actual`,
          '!', 'WARNING'
        );
      }
      tokenAmount = currentSize;
    }

    if (toSleep) {
      this.log(`Sleep ${toSleep}s before ${orderSide}`);
      await asyncSleep(toSleep);
    }

    // Get prices
    let pricesInitial;
    if (orderType === 'limit') {
      pricesInitial = await this._waitForSpread(tokenName);
    } else {
      pricesInitial = await this.getTokenPrice(tokenName);
    }

    const initialPrice = roundCut(pricesInitial[orderSide], tokenData.priceDecimals);

    // Calculate token amount
    let qty;
    if (usdAmount !== null) {
      qty = roundCut(usdAmount / initialPrice, tokenData.sizeDecimals);
    } else if (tokenAmount !== null) {
      qty = roundCut(tokenAmount, tokenData.sizeDecimals);
    } else {
      throw new CustomError('Either usdAmount or tokenAmount must be provided');
    }

    if (qty < tokenData.minSize) {
      throw new CustomError(
        `Minimum size is ${tokenData.minSize} ${tokenName} but got ${qty} ${tokenName}`
      );
    }

    const finalPrices = await this.getTokenPrice(tokenName, qty);
    const finalPrice = roundCut(finalPrices[orderSide], tokenData.priceDecimals);

    // Calculate order price
    let orderPrice;
    if (customPrice !== null) {
      orderPrice = roundCut(customPrice, tokenData.priceDecimals);
    } else if (orderType === 'market') {
      orderPrice = orderSide === 'buy'
        ? roundCut(finalPrice * 1.01, tokenData.priceDecimals)
        : roundCut(finalPrice / 1.01, tokenData.priceDecimals);
    } else {
      orderPrice = this._calculateFirstLimitPrice(tokenName, finalPrice, orderSide);
    }

    const dependPrice = roundCut(
      customPrice ?? (orderType === 'limit' ? orderPrice : finalPrice),
      tokenData.priceDecimals
    );
    const usdcAmount = roundCut(qty * dependPrice, 2);

    // Build payload
    let payload;
    if (orderType === 'limit') {
      payload = {
        order_type: 'limit',
        limit_price: String(orderPrice),
        side: orderSide,
        instrument: {
          underlying: tokenName,
          instrument_type: 'perpetual_future',
          settlement_asset: 'USDC',
          funding_interval_s: 3600,
        },
        qty: String(qty),
        is_auto_resize: false,
        use_mark_price: false,
        is_reduce_only: false,
      };
    } else {
      payload = {
        quote_id: finalPrices.quote_id,
        side: orderSide,
        max_slippage: 0.005,
        is_reduce_only: false,
      };
    }

    let triggerStr = '';
    if (stopLoss) {
      const slPrice = roundCut(
        this._calculateTriggerPrice(orderSide, dependPrice), tokenData.priceDecimals
      );
      const tpPrice = roundCut(
        this._calculateLimitOrderPrice(dependPrice, orderSide), tokenData.priceDecimals
      );
      Object.assign(payload, {
        take_profit: String(tpPrice),
        tp_is_auto_resize: true,
        tp_use_mark_price: true,
        stop_loss: String(slPrice),
        sl_is_auto_resize: true,
        sl_use_mark_price: true,
      });
      triggerStr = ` (Take-Profit <green>${tpPrice}</green> Stop-Loss <red>${slPrice}</red>)`;
      await this.wallet.db.appendReport(
        this.encodedPkey,
        `${this.prefix}${orderType} ${actionName.toLowerCase()} ${qty} ${tokenName} (${usdcAmount}$) ` +
        `at ${dependPrice} | SL ${slPrice} | TP ${tpPrice}`,
        true,
      );
    }

    this.log(
      `${orderType.charAt(0).toUpperCase() + orderType.slice(1)} ${actionName} ` +
      `${qty} ${tokenName} (<green>${usdcAmount}$</green>) at ${dependPrice}${triggerStr}`,
      '+', 'INFO'
    );

    const orderResp = await this.browser.createOrder(payload);

    // Wait for fill
    const orderIdsToWatch = stopLoss
      ? [orderResp.stop_loss_rfq_id, orderResp.take_profit_rfq_id]
      : [orderResp.rfq_id];

    const { result: fillResult, params: fillParams } = await this._waitForLimitFilled({
      orderIds: orderIdsToWatch,
      tokenName, qty: dependPrice, price: dependPrice, orderSide,
      isClose: !!previousPos, triggerStr, customPrice,
    });

    if (fillResult === 'reopen') {
      if (fillParams && fillParams.toCancel) {
        await this.browser.cancelOrder(orderResp.rfq_id);
        this.log(`Cancelled <white>${qty} ${tokenName}</white> order`);
      }
      return this._createOrderOnce({
        tokenName, orderSide, orderType, usdAmount: null, tokenAmount: qty,
        customPrice, previousPos, stopLoss, toSleep: 0, tokenData,
      });
    }

    if (stopLoss) {
      const tpslResult = fillResult;
      const mainOrder = await this.browser.getOrders(orderResp.rfq_id);
      const triggerName = tpslResult.order_type === 'stop_loss' ? 'Stop-Loss' : 'Take-Profit';
      const triggerColor = tpslResult.order_type === 'stop_loss' ? 'red' : 'green';
      const bv = parseFloat(mainOrder.qty) * parseFloat(mainOrder.price);
      const sv = parseFloat(tpslResult.qty) * parseFloat(tpslResult.price);
      mainOrder.total_volume = roundCut(bv + sv, 1);
      mainOrder.total_profit = roundCut(orderSide === 'buy' ? sv - bv : bv - sv, 2);

      this.log(
        `<${triggerColor}>${triggerName}</${triggerColor}> ${qty} ${tokenName} ` +
        `(${roundCut(sv, 2)}$) at <${triggerColor}>${tpslResult.price}</${triggerColor}>`,
        '+', 'INFO'
      );
      await this.wallet.db.appendReport(
        this.encodedPkey,
        `${this.prefix}${triggerName.toLowerCase()} ${qty} ${tokenName} at ${tpslResult.price} (${roundCut(sv, 2)}$)`,
        true,
      );
      return mainOrder;
    }

    const filledPrice = parseFloat(fillResult.price);
    const filledUsd = roundCut(qty * filledPrice, 2);
    this.log(`${orderType.charAt(0).toUpperCase() + orderType.slice(1)} order filled`, '+', 'SUCCESS');
    await this.wallet.db.appendReport(
      this.encodedPkey,
      `${this.prefix}${orderType} ${actionName.toLowerCase()} ${qty} ${tokenName} (${filledUsd}$) at ${filledPrice}`,
      true,
    );

    return fillResult;
  }

  // ── Parse / stats ────────────────────────────────────────────────────────────

  async parse() {
    const cfg = settings.get();
    const maxRetries = cfg.general.retry;
    let attempt = 0;

    while (true) {
      try {
        const [rawBalance, rawVolume, rawPnl, rawPoints, orders, positions] = await Promise.all([
          this.browser.getBalanceDetailed(),
          this.browser.getVolume(),
          this.browser.getPnl(),
          this.browser.getPoints(),
          this.browser.getOrders(null, { status: 'pending' }),
          this.browser.getPositions(),
        ]);

        const volume = rawVolume.trade_volume
          ? roundCut(rawVolume.trade_volume.current, 1)
          : roundCut(rawVolume.own_volume.total, 1);

        const pnl = rawPnl ? roundCut(rawPnl.pnl, 1) : 0;
        const balance = roundCut(rawBalance.max_withdrawable_amount, 2);
        const netWorth = roundCut(rawBalance.balance, 2);
        const totalPoints = rawPoints ? roundCut(rawPoints.total_points, 2) : 0;
        const rank = rawPoints ? rawPoints.rank : 0;
        const totalPositions = orders.length + positions.length;

        this.log(
          `Account stats:\n` +
          `  Points:    ${totalPoints}\n` +
          `  Rank:      ${rank}\n` +
          `  Volume:    ${volume}$\n` +
          `  Positions: ${totalPositions}\n` +
          `  Balance:   ${balance}$\n` +
          `  Net Worth: ${netWorth}$\n` +
          `  PNL:       ${pnl}$`,
          '+', 'SUCCESS'
        );

        const tgLog =
          `🎖 Points: <b>${totalPoints}</b>\n` +
          `💎 Rank: <b>${rank}</b>\n` +
          `📈 Volume: <b>${volume}$</b>\n` +
          `📌 Positions: <b>${totalPositions}</b>\n` +
          `💰 Balance: <b>${balance}$</b>\n` +
          `💸 Net Worth: <b>${netWorth}$</b>\n` +
          `💵 Total PNL: <b>${pnl}$</b>\n`;

        await this.wallet.db.appendReport(this.encodedPkey, tgLog);
        return true;

      } catch (err) {
        attempt++;
        this.log(`Parse attempt ${attempt}/${maxRetries} failed: ${err.message}`, '-', 'ERROR');
        if (attempt >= maxRetries) throw err;
        await asyncSleep(2);
      }
    }
  }

  // ── Leverage ─────────────────────────────────────────────────────────────────

  async changeLeverage(tokenName, leverage) {
    await this.browser.changeLeverage(tokenName, leverage);
    this.log(`Changed ${tokenName} leverage to <white>${leverage}x</white>`);
  }

  async checkForBalance(neededBalance) {
    const balance = await this.browser.getBalance();
    if (neededBalance > balance) {
      const label = this.prefix ? `${this.label} | ` : '';
      throw new CustomError(
        `${label}Not enough balance, need at least ${roundCut(neededBalance, 2)}$, have ${roundCut(balance, 2)}$`
      );
    }
    return balance;
  }

  async calculateUsdAmountForOrder(tokenName) {
    const cfg = settings.get();
    const tokenCfg = cfg.tokens[tokenName];
    const [minLev, maxLev] = tokenCfg.leverage;
    const leverage = Math.max(1, randint(minLev, maxLev));
    const balance = await this.browser.getBalance();

    let usdAmount;
    const amounts = cfg.trading.tradeAmounts.amount;
    if (amounts[0] !== 0 || amounts[1] !== 0) {
      if (amounts[0] > balance) {
        throw new CustomError(`Not enough balance, need ${amounts[0]}$, have ${roundCut(balance, 2)}$`);
      }
      const max = amounts[1] > balance ? balance : amounts[1];
      usdAmount = uniform(amounts[0], max);
    } else {
      const pct = uniform(...cfg.trading.tradeAmounts.percent) / 100;
      usdAmount = balance * pct;
    }

    return { usdAmount: usdAmount * leverage, leverage };
  }

  // ── Spread wait ──────────────────────────────────────────────────────────────

  async _waitForSpread(tokenName) {
    const cfg = settings.get();
    const tokenCfg = cfg.tokens[tokenName];
    let firstCheck = true;

    while (true) {
      const prices = await this.getTokenPrice(tokenName);
      if (prices.spread <= tokenCfg.maxSpread) {
        if (!firstCheck) this.log(`${tokenName} spread ok (${roundCut(prices.spread, 3)}%), creating order...`);
        return prices;
      }
      if (firstCheck) {
        firstCheck = false;
        this.log(
          `${tokenName} spread ${roundCut(prices.spread, 3)}%. Waiting for max spread ${tokenCfg.maxSpread}%`
        );
      }
      await asyncSleep(1);
    }
  }

  // ── Wait for limit fill ──────────────────────────────────────────────────────

  async _waitForLimitFilled({ orderIds, tokenName, qty, price, orderSide, isClose, triggerStr, customPrice }) {
    const cfg = settings.get();
    const minutesToWait = cfg.trading.futuresLimits.toWait;
    const deadline = Date.now() + minutesToWait * 60 * 1000;
    const minutesStr = !customPrice && !triggerStr
      ? `${minutesToWait} minute${minutesToWait !== 1 ? 's' : ''}`
      : '';

    const actionName = isClose
      ? (orderSide === 'sell' ? 'Close Long' : 'Close Short')
      : (orderSide === 'buy' ? 'Long' : 'Short');
    const orderAction = isClose || triggerStr ? 'Close' : 'Open';

    this.log(
      `Waiting for ${orderAction} order <white>${actionName} ${qty} ${tokenName} at ${price}</white>` +
      `${triggerStr} filled${minutesStr ? ' for ' + minutesStr : ''}...`
    );

    const maxRetries = cfg.general.retry;
    let attempt = 0;

    while (true) {
      for (const orderId of orderIds) {
        let order;
        try {
          order = await this.browser.getOrders(orderId);
        } catch (err) {
          attempt++;
          this.log(`Error polling order ${orderId} (${attempt}/${maxRetries}): ${err.message}`, '!', 'WARNING');
          if (attempt >= maxRetries) throw err;
          await asyncSleep(2);
          continue;
        }

        if (order.status === 'pending') {
          if (!customPrice && !triggerStr && Date.now() > deadline) {
            this.log(`Order not filled in ${minutesStr}`, '!', 'WARNING');
            return { result: 'reopen', params: { ...order, toCancel: true } };
          }
        } else if (order.status === 'canceled' && orderIds.length === 1) {
          this.log('Order cancelled manually, reopening...', '!', 'WARNING');
          return { result: 'reopen', params: order };
        } else if (order.status === 'cleared') {
          return { result: order, params: null };
        } else {
          throw new Error(`Unexpected order status: ${order.status}`);
        }
      }
      await asyncSleep(2);
    }
  }

  // ── Price calculation helpers ─────────────────────────────────────────────────

  _calculateFirstLimitPrice(tokenName, tokenPrice, side) {
    const cfg = settings.get();
    const openDiff = uniform(...cfg.tokens[tokenName].openPrice);
    const price = side === 'buy' ? tokenPrice - openDiff : tokenPrice + openDiff;
    return roundCut(price, getToken(tokenName).priceDecimals);
  }

  _calculateLimitOrderPrice(oldPrice, side) {
    const cfg = settings.get();
    const { priceDiffAmount, priceDiffPercent } = cfg.trading.futuresLimits;
    let newPrice;
    if (priceDiffAmount[0] !== 0 || priceDiffAmount[1] !== 0) {
      const diff = uniform(...priceDiffAmount);
      newPrice = side === 'buy' ? oldPrice + diff : oldPrice - diff;
    } else {
      const pct = 1 + uniform(...priceDiffPercent) / 100;
      newPrice = side === 'buy' ? oldPrice * pct : oldPrice / pct;
    }
    return newPrice;
  }

  _calculateTriggerPrice(side, tokenPrice) {
    const cfg = settings.get();
    const { lossDiffAmount, lossDiffPercent } = cfg.trading.stopLoss;
    let price;
    if (lossDiffAmount[0] !== 0 || lossDiffAmount[1] !== 0) {
      const diff = Math.abs(uniform(...lossDiffAmount));
      price = side === 'sell' ? tokenPrice + diff : tokenPrice - diff;
    } else {
      const pct = 1 + uniform(...lossDiffPercent) / 100;
      price = side === 'sell' ? tokenPrice * pct : tokenPrice / pct;
    }
    return price;
  }

  // ── Logging ──────────────────────────────────────────────────────────────────

  log(text, smile = '•', level = 'DEBUG') {
    let label;
    if (this.groupNumber) {
      label = `<white>Group ${this.groupNumber}</white> | <white>${this.label}</white>`;
    } else {
      label = `<white>${this.label}</white>`;
    }
    logger[level.toLowerCase()](`[${smile}] ${label} | ${text}`);
  }
}

module.exports = { Variational, CustomError, OnetimeError, roundCut };
