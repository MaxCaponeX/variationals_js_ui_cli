'use strict';
/**
 * HTTP client for the Variational API (omni.variational.io).
 *
 * Uses axios with a persistent cookie jar to simulate a browser session.
 * Retry logic is handled at a higher level (variational.js).
 */

const axios = require('axios');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');

const logger = require('../utils/logger');
const settings = require('./settings');

const BASE_URL = 'https://omni.variational.io';

const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Origin': 'https://omni.variational.io',
  'Referer': 'https://omni.variational.io/',
  'sec-ch-ua': '"Chromium";v="136", "Google Chrome";v="136", "Not.A/Brand";v="99"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-origin',
};

class Browser {
  constructor({ proxy, address, db }) {
    this.address = address;
    this.db = db;

    // Normalise proxy URL
    if (proxy && !['', null, undefined].includes(proxy) &&
        !proxy.includes('login:password@ip:port')) {
      this.proxy = proxy.startsWith('http') ? proxy : 'http://' + proxy;
    } else {
      this.proxy = null;
    }

    this._jar = new CookieJar();
    this._client = this._createClient();
  }

  _createClient() {
    const axiosInstance = wrapper(axios.create({
      baseURL: BASE_URL,
      headers: DEFAULT_HEADERS,
      timeout: 30000,
      withCredentials: true,
      jar: this._jar,
    }));

    if (this.proxy) {
      // Parse proxy URL for axios config
      try {
        const url = new URL(this.proxy);
        axiosInstance.defaults.proxy = {
          protocol: url.protocol.replace(':', ''),
          host: url.hostname,
          port: parseInt(url.port),
          auth: url.username ? { username: url.username, password: url.password } : undefined,
        };
      } catch (_) {
        logger.warning(`Invalid proxy URL: ${this.proxy}`);
      }
    }

    return axiosInstance;
  }

  async _request(method, url, options = {}) {
    try {
      const response = await this._client.request({
        method: method.toUpperCase(),
        url,
        ...options,
      });
      return response;
    } catch (err) {
      if (err.response) {
        // Check for Cloudflare rate limit in HTML response
        const text = err.response.data;
        if (typeof text === 'string') {
          const match = text.match(/<title>.*?(\d+(?:\.\d+)?)\s*(ms|seconds).*?<\/title>/is);
          if (match) {
            const amount = parseFloat(match[1]);
            const unit = match[2];
            const sleepSec = unit === 'ms' ? Math.ceil(amount / 1000) + 1 : Math.ceil(amount) + 1;
            const cf_err = new Error(`Cloudflare rate limit — sleep ${sleepSec}s`);
            cf_err.cloudflare = true;
            cf_err.toSleep = sleepSec;
            throw cf_err;
          }
        }
        const errData = err.response.data;
        throw new Error(`HTTP ${err.response.status}: ${JSON.stringify(errData).slice(0, 300)}`);
      }
      throw err;
    }
  }

  // ── Auth ─────────────────────────────────────────────────────────────────────

  async isAccountRegistered() {
    const resp = await this._request('GET', `/api/auth/company/${this.address}`);
    return !!(resp.data.company && resp.data.settlement_pool);
  }

  async getSignData() {
    const resp = await this._request('POST', '/api/auth/generate_signing_data', {
      data: { address: this.address },
    });
    const text = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
    if (!text.startsWith('omni.variational.io wants you to')) {
      throw new Error(`Failed to get sign data: ${text}`);
    }
    return text;
  }

  async authLogin(signature) {
    let resp;
    try {
      resp = await this._request('POST', '/api/auth/login', {
        data: { address: this.address, signed_message: signature },
      });
    } catch (err) {
      if (err.cloudflare) {
        return { success: false, log: `Sleep ${err.toSleep}s (Cloudflare)`, toSleep: err.toSleep };
      }
      throw err;
    }

    const data = resp.data;
    if (!data.token) throw new Error(`Failed to auth login: ${JSON.stringify(data)}`);
    return { success: true, data };
  }

  // ── Market data ──────────────────────────────────────────────────────────────

  async getBalance() {
    const resp = await this._request('GET', '/api/portfolio', { params: { compute_margin: 'true' } });
    if (resp.data.balance === undefined) throw new Error(`Failed to get balance: ${JSON.stringify(resp.data)}`);
    return parseFloat(resp.data.balance);
  }

  async getBalanceDetailed() {
    const resp = await this._request('GET', '/api/settlement_pools/details');
    if (resp.data.balance === undefined) throw new Error(`Failed to get detailed balance: ${JSON.stringify(resp.data)}`);
    return resp.data;
  }

  async getSupportedAssets() {
    const resp = await this._request('GET', '/api/metadata/supported_assets');
    return resp.data;
  }

  async getIndicative(tokenName, { price = null, amount = null } = {}) {
    const qty = amount !== null ? String(amount) : String(10 / parseFloat(price));
    const resp = await this._request('POST', '/api/quotes/indicative', {
      data: {
        instrument: {
          underlying: tokenName,
          funding_interval_s: 3600,
          settlement_asset: 'USDC',
          instrument_type: 'perpetual_future',
        },
        qty,
      },
    });
    if (!resp.data.qty_limits) throw new Error(`Failed to get ${tokenName} indicative: ${JSON.stringify(resp.data)}`);
    return resp.data;
  }

  async changeLeverage(tokenName, leverage) {
    const resp = await this._request('POST', '/api/settlement_pools/set_leverage', {
      data: { leverage: String(leverage), asset: tokenName },
    });
    return resp.data;
  }

  // ── Orders ───────────────────────────────────────────────────────────────────

  async createOrder(payload) {
    const orderType = payload.order_type || 'market';
    const resp = await this._request('POST', `/api/orders/new/${orderType}`, { data: payload });
    if (!resp.data.rfq_id) throw new Error(`Failed to create order: ${JSON.stringify(resp.data)}`);
    return resp.data;
  }

  async cancelOrder(orderId) {
    const resp = await this._request('POST', '/api/orders/cancel', { data: { rfq_id: orderId } });
    if (resp.data !== null && resp.status !== 200) {
      throw new Error(`Failed to cancel order: ${JSON.stringify(resp.data)}`);
    }
  }

  async getOrders(orderId = null, params = {}) {
    const resp = await this._request('GET', '/api/orders/v2', {
      params: { order_by: 'created_at', order: 'desc', limit: 20, offset: 0, ...params },
    });
    if (!resp.data.result) throw new Error(`Failed to get orders: ${JSON.stringify(resp.data)}`);

    if (orderId === null) return resp.data.result;

    const order = resp.data.result.find((o) => o.rfq_id === orderId);
    if (!order) throw new Error(`No order found with id ${orderId}`);
    return order;
  }

  async getPositions(tokenName = null) {
    const resp = await this._request('GET', '/api/positions');
    if (!Array.isArray(resp.data)) throw new Error(`Failed to get positions: ${JSON.stringify(resp.data)}`);
    if (!tokenName) return resp.data;
    return resp.data.find((p) => p.position_info.instrument.underlying === tokenName) || null;
  }

  async getTrades(tokenName = null, params = {}, isLiquidation = false) {
    const resp = await this._request('GET', '/api/trades', {
      params: { order_by: 'created_at', order: 'desc', limit: 20, offset: 0, ...params },
    });
    if (!resp.data.result) throw new Error(`Failed to get trades: ${JSON.stringify(resp.data)}`);
    if (!tokenName) return resp.data.result;
    return resp.data.result.find((t) =>
      t.instrument.underlying === tokenName &&
      (!isLiquidation || t.trade_type === 'liquidation')
    ) || null;
  }

  async getVolume() {
    const resp = await this._request('GET', '/api/referrals/summary');
    if (resp.data.trade_volume === undefined && resp.data.own_volume === undefined) {
      throw new Error(`Failed to get volume: ${JSON.stringify(resp.data)}`);
    }
    return resp.data;
  }

  async getPnl() {
    const resp = await this._request('GET', '/api/leaderboard', {
      params: { limit: 20, offset: 0, period: 'total', ranking: 'pnl' },
    });
    if (!resp.data.result) throw new Error(`Failed to get PNL: ${JSON.stringify(resp.data)}`);
    return resp.data.result.self;
  }

  async getPoints() {
    const resp = await this._request('GET', '/api/points/summary', {
      params: { limit: 20, offset: 0, period: 'total', ranking: 'pnl' },
    });
    return resp.data;
  }
}

module.exports = Browser;
