'use strict';
/**
 * HTTP client for the Variational API (omni.variational.io).
 *
 * Uses electron.net — Chromium's real network stack — for authentic Chrome
 * TLS fingerprint, HTTP/2, and per-account isolated cookie sessions.
 * Proxy is set per-session via Chromium's built-in proxy resolver.
 */

const { net, session } = require('electron');

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

    // Each account gets its own isolated Chromium session (cookies, cache)
    this._sess = session.fromPartition(`account-${address}`, { cache: false });

    // Parse proxy credentials separately — Chromium proxyRules doesn't accept auth inline
    this._proxyAuth = null;
    let proxyRules = null;
    if (this.proxy) {
      try {
        const u = new URL(this.proxy);
        proxyRules = `${u.protocol}//${u.hostname}:${u.port}`;
        if (u.username) {
          this._proxyAuth = {
            username: decodeURIComponent(u.username),
            password: decodeURIComponent(u.password),
          };
        }
      } catch (_) { proxyRules = this.proxy; }
    }

    // Clear cookies from any previous run, then set proxy
    this._ready = this._sess
      .clearStorageData({ storages: ['cookies'] })
      .then(() => proxyRules
        ? this._sess.setProxy({ proxyRules })
        : Promise.resolve()
      );
  }

  _buildUrl(path, params) {
    const url = new URL(path.startsWith('http') ? path : BASE_URL + path);
    if (params) {
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    }
    return url.toString();
  }

  async _request(method, path, options = {}) {
    await this._ready;

    const url = this._buildUrl(path, options.params);

    return new Promise((resolve, reject) => {
      const request = net.request({
        method: method.toUpperCase(),
        url,
        session: this._sess,
        useSessionCookies: true,
      });

      for (const [k, v] of Object.entries(DEFAULT_HEADERS)) request.setHeader(k, v);
      for (const [k, v] of Object.entries(options.headers || {})) request.setHeader(k, v);

      request.on('response', (response) => {
        const chunks = [];
        response.on('data', (c) => chunks.push(c));
        response.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          let data;
          try { data = JSON.parse(raw); } catch { data = raw; }

          const status = response.statusCode;

          if (status >= 200 && status < 300) {
            resolve({ status, data, headers: response.headers });
            return;
          }

          // Cloudflare: explicit wait time in <title>
          if (typeof data === 'string') {
            const match = data.match(/<title>.*?(\d+(?:\.\d+)?)\s*(ms|seconds).*?<\/title>/is);
            if (match) {
              const amount = parseFloat(match[1]);
              const sleepSec = match[2] === 'ms' ? Math.ceil(amount / 1000) + 1 : Math.ceil(amount) + 1;
              const err = new Error(`Cloudflare rate limit — sleep ${sleepSec}s`);
              err.cloudflare = true;
              err.toSleep = sleepSec;
              return reject(err);
            }
            if (data.includes('Just a moment') || data.includes('cf-browser-verification') || data.includes('_cf_chl_')) {
              return reject(new Error(`HTTP ${status}: Cloudflare bot protection triggered — используйте прокси`));
            }
          }

          reject(new Error(`HTTP ${status}: ${JSON.stringify(data).slice(0, 300)}`));
        });
        response.on('error', reject);
      });

      request.on('error', reject);

      // Provide proxy credentials when Chromium challenges for auth
      if (this._proxyAuth) {
        request.on('login', (_authInfo, callback) => {
          callback(this._proxyAuth.username, this._proxyAuth.password);
        });
      }

      if (options.data) {
        request.setHeader('Content-Type', 'application/json');
        request.write(JSON.stringify(options.data));
      }

      request.end();
    });
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
