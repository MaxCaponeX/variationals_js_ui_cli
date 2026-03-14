'use strict';
/**
 * Electron renderer process — GUI logic.
 *
 * Communicates with the main process exclusively via window.api (preload bridge).
 */

// ── State ──────────────────────────────────────────────────────────────────────
let config = {};
let isRunning = false;

// ── DOM helpers ────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const val = (id) => $(id) && $(id).value;
const setVal = (id, v) => { if ($(id)) $(id).value = v ?? ''; };
const checked = (id) => $(id) && $(id).checked;
const setChecked = (id, v) => { if ($(id)) $(id).checked = !!v; };

// ── Navigation ─────────────────────────────────────────────────────────────────
document.querySelectorAll('.nav-item').forEach((item) => {
  item.addEventListener('click', () => {
    const page = item.dataset.page;
    document.querySelectorAll('.nav-item').forEach((i) => i.classList.remove('active'));
    document.querySelectorAll('.page').forEach((p) => p.classList.remove('active'));
    item.classList.add('active');
    document.getElementById(`page-${page}`)?.classList.add('active');
  });
});

// ── Log console ────────────────────────────────────────────────────────────────
const LEVEL_COLORS = {
  DEBUG: 'log-level-DEBUG', INFO: 'log-level-INFO',
  SUCCESS: 'log-level-SUCCESS', WARNING: 'log-level-WARNING', ERROR: 'log-level-ERROR',
};

function appendLog(entry, container) {
  const el = document.createElement('div');
  el.className = `log-entry ${LEVEL_COLORS[entry.level] || 'log-level-INFO'}`;
  const ts = new Date(entry.time || Date.now());
  const timeStr = `${String(ts.getHours()).padStart(2,'0')}:${String(ts.getMinutes()).padStart(2,'0')}:${String(ts.getSeconds()).padStart(2,'0')}`;
  el.innerHTML = `<span class="log-time">${timeStr}</span>${escapeHtml(entry.message)}`;
  container.appendChild(el);

  // Limit to last 1000 entries
  while (container.children.length > 1000) container.removeChild(container.firstChild);
}

function escapeHtml(text) {
  return String(text).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

const dashLog = $('dash-log');
const fullLog = $('full-log');

window.api.onLog((entry) => {
  appendLog(entry, dashLog);
  appendLog(entry, fullLog);

  const autoScroll = checked('log-autoscroll');
  if (autoScroll) {
    dashLog.scrollTop = dashLog.scrollHeight;
    fullLog.scrollTop = fullLog.scrollHeight;
  }
});

$('btn-clear-logs').addEventListener('click', () => { fullLog.innerHTML = ''; dashLog.innerHTML = ''; });

// ── Trading callbacks ──────────────────────────────────────────────────────────
window.api.onTradingDone(({ result, mode }) => {
  setRunning(false);
  const doneMsg = mode === 5 ? 'Парсинг завершён' : mode === 3 ? 'Закрытие позиций завершено' : 'Торговля завершена';
  appendLog({ level: 'SUCCESS', message: `[+] ${doneMsg}`, time: new Date().toISOString() }, dashLog);
  refreshDbStatus();
});
window.api.onTradingError(({ error }) => {
  setRunning(false);
  appendLog({ level: 'ERROR', message: `[-] Ошибка торговли: ${error}`, time: new Date().toISOString() }, dashLog);
});

// ── Running state ──────────────────────────────────────────────────────────────
function setRunning(state) {
  isRunning = state;
  const badge = $('status-badge');
  badge.innerHTML = state
    ? '<span class="badge badge-running">● Работает</span>'
    : '<span class="badge badge-idle">Ожидание</span>';

  [$('btn-run-single'), $('btn-run-delta'), $('btn-run-sell'), $('btn-run-parse'),
   $('btn-create-single'), $('btn-create-delta')].forEach((b) => { if (b) b.disabled = state; });
  $('btn-stop').disabled = !state;
}

async function startMode(mode) {
  if (isRunning) return;
  const password = await askDbPassword();
  if (password === null) return;
  setRunning(true);
  const result = await window.api.startTrading(mode, password);
  if (!result.ok) {
    setRunning(false);
    alert(`Ошибка запуска: ${result.error}`);
  }
}

$('btn-run-single').addEventListener('click', () => startMode(1));
$('btn-run-delta').addEventListener('click', () => startMode(2));
$('btn-run-sell').addEventListener('click', () => startMode(3));
$('btn-run-parse').addEventListener('click', () => startMode(5));
$('btn-stop').addEventListener('click', async () => {
  await window.api.stopTrading();
  setRunning(false);
});

// ── Database ───────────────────────────────────────────────────────────────────
async function refreshDbStatus() {
  const status = await window.api.getDbStatus();
  $('info-threads').textContent = config.general?.threads ?? '—';
  if (status.type === 'empty') {
    $('db-info').textContent = 'Пусто';
    $('db-pending').textContent = '0';
  } else if (status.type === 'error') {
    $('db-info').textContent = 'Ошибка';
    $('db-pending').textContent = '—';
  } else {
    $('db-info').textContent = status.type === 'groups' ? `${status.count} групп` : `${status.count} аккаунтов`;
    $('db-pending').textContent = status.pending;
  }
}

function askDbPassword() {
  return new Promise((resolve) => {
    const dlg = $('dialog-db-password');
    $('db-password-input').value = '';
    dlg.showModal();
    dlg.addEventListener('close', function handler() {
      dlg.removeEventListener('close', handler);
      resolve(dlg.returnValue === 'confirm' ? $('db-password-input').value : null);
    });
  });
}

async function createDb(mode) {
  const confirm = await window.api.showDialog({
    type: 'question',
    buttons: ['Отмена', 'Создать'],
    defaultId: 1,
    title: 'Создание базы данных',
    message: `Создать новую ${mode === 101 ? 'Single' : 'Delta Neutral'} базу данных?\nЭто перезапишет существующую базу.`,
  });
  if (confirm.response !== 1) return;

  const password = await askDbPassword();
  if (password === null) return; // пользователь нажал Отмена

  const result = await window.api.createDatabase(mode, password);
  if (result.ok) {
    await refreshDbStatus();
    appendLog({ level: 'SUCCESS', message: '[+] База данных успешно создана', time: new Date().toISOString() }, dashLog);
  } else {
    alert(`Ошибка: ${result.error}`);
  }
}

$('btn-create-single').addEventListener('click', () => createDb(101));
$('btn-create-delta').addEventListener('click', () => createDb(102));

// ── Token list ─────────────────────────────────────────────────────────────────
function renderTokens() {
  const list = $('token-list');
  list.innerHTML = '';
  const tokens = config.tokens || {};

  for (const [name, data] of Object.entries(tokens)) {
    const row = document.createElement('tr');
    row.className = 'token-row';
    row.dataset.token = name;
    row.innerHTML = `
      <td class="token-name">${name}</td>
      <td>
        <div class="range-input">
          <input type="number" class="t-price-min" value="${data.prices[0]}" step="1" min="0">
          <span class="range-sep">–</span>
          <input type="number" class="t-price-max" value="${data.prices[1]}" step="1" min="0">
        </div>
      </td>
      <td>
        <div class="range-input">
          <input type="number" class="t-lev-min" value="${data.leverage[0]}" step="1" min="1" max="100">
          <span class="range-sep">–</span>
          <input type="number" class="t-lev-max" value="${data.leverage[1]}" step="1" min="1" max="100">
        </div>
      </td>
      <td>
        <input type="number" class="t-spread" value="${data.maxSpread}" step="0.001" min="0">
      </td>
      <td>
        <div class="range-input">
          <input type="number" class="t-open-min" value="${data.openPrice[0]}" step="0.1" min="0">
          <span class="range-sep">–</span>
          <input type="number" class="t-open-max" value="${data.openPrice[1]}" step="0.1" min="0">
        </div>
      </td>
      <td><button class="btn-remove" title="Удалить токен">✕</button></td>
    `;
    row.querySelector('.btn-remove').addEventListener('click', () => {
      delete config.tokens[name];
      renderTokens();
    });
    list.appendChild(row);
  }
}

function collectTokensFromUI() {
  const rows = document.querySelectorAll('.token-row');
  const tokens = {};
  rows.forEach((row) => {
    const name = row.dataset.token;
    tokens[name] = {
      prices: [
        parseFloat(row.querySelector('.t-price-min').value) || 0,
        parseFloat(row.querySelector('.t-price-max').value) || 0,
      ],
      leverage: [
        parseInt(row.querySelector('.t-lev-min').value) || 1,
        parseInt(row.querySelector('.t-lev-max').value) || 1,
      ],
      maxSpread: parseFloat(row.querySelector('.t-spread').value) || 0.01,
      openPrice: [
        parseFloat(row.querySelector('.t-open-min').value) || 0,
        parseFloat(row.querySelector('.t-open-max').value) || 0,
      ],
    };
  });
  return tokens;
}

$('btn-add-token').addEventListener('click', () => {
  const name = $('new-token-name').value.trim().toUpperCase();
  if (!name) return;
  if (!config.tokens) config.tokens = {};
  config.tokens[name] = { prices: [0, 999999], leverage: [1, 5], maxSpread: 0.01, openPrice: [0, 0] };
  $('new-token-name').value = '';
  renderTokens();
});

$('btn-save-tokens').addEventListener('click', async () => {
  config.tokens = collectTokensFromUI();
  const result = await window.api.saveSettings(config);
  if (result.ok) alert('Токены сохранены!');
  else alert(`Ошибка: ${result.error}`);
});

// ── Load settings into form ────────────────────────────────────────────────────
function loadSettingsToForm(cfg) {
  config = cfg;

  // Single mode
  setVal('s-amount-min', cfg.trading.tradeAmounts.amount[0]);
  setVal('s-amount-max', cfg.trading.tradeAmounts.amount[1]);
  setVal('s-pct-min', cfg.trading.tradeAmounts.percent[0]);
  setVal('s-pct-max', cfg.trading.tradeAmounts.percent[1]);
  setChecked('s-cancel-all', cfg.trading.tradeAmounts.cancelAllBefore);
  setVal('s-trades-min', cfg.trading.tradesCount[0]);
  setVal('s-trades-max', cfg.trading.tradesCount[1]);
  setChecked('s-allow-long', cfg.trading.futureActions.sides.Long);
  setChecked('s-allow-short', cfg.trading.futureActions.sides.Short);
  setChecked('s-open-limit', cfg.trading.futureActions.types.open.includes('limit'));
  setChecked('s-open-market', cfg.trading.futureActions.types.open.includes('market'));
  setChecked('s-close-limit', cfg.trading.futureActions.types.close.includes('limit'));
  setChecked('s-close-market', cfg.trading.futureActions.types.close.includes('market'));
  setVal('s-close-diff-min', cfg.trading.futuresLimits.priceDiffPercent[0]);
  setVal('s-close-diff-max', cfg.trading.futuresLimits.priceDiffPercent[1]);
  setVal('s-wait-fill', cfg.trading.futuresLimits.toWait);
  setChecked('s-sl-enable', cfg.trading.stopLoss.enable);
  setVal('s-sl-min', cfg.trading.stopLoss.lossDiffPercent[0]);
  setVal('s-sl-max', cfg.trading.stopLoss.lossDiffPercent[1]);
  setChecked('s-sell-cancel', cfg.trading.sellSettings.cancelOrders);
  setChecked('s-sell-close', cfg.trading.sellSettings.closePositions);

  // Delta mode
  setVal('d-pair-min', cfg.trading.pairSettings.pairAmount[0]);
  setVal('d-pair-max', cfg.trading.pairSettings.pairAmount[1]);
  setVal('d-hold-min', cfg.trading.pairSettings.positionHold[0]);
  setVal('d-hold-max', cfg.trading.pairSettings.positionHold[1]);
  $('d-order-type').value = cfg.trading.futuresLimits.orderType;
  setVal('d-diff-min', cfg.trading.tradeAmounts.deltaDiff[0]);
  setVal('d-diff-max', cfg.trading.tradeAmounts.deltaDiff[1]);

  // General
  setVal('g-threads', cfg.general.threads);
  setVal('g-retry', cfg.general.retry);
  setChecked('g-shuffle', cfg.general.shuffleWallets);
  setVal('sl-orders-min', cfg.sleep.betweenOrders[0]);
  setVal('sl-orders-max', cfg.sleep.betweenOrders[1]);
  setVal('sl-threads-min', cfg.sleep.betweenThreads[0]);
  setVal('sl-threads-max', cfg.sleep.betweenThreads[1]);
  setVal('sl-account-min', cfg.sleep.afterAccount[0]);
  setVal('sl-account-max', cfg.sleep.afterAccount[1]);
  setVal('sl-open-min', cfg.sleep.betweenOpenOrders[0]);
  setVal('sl-open-max', cfg.sleep.betweenOpenOrders[1]);
  setVal('sl-close-min', cfg.sleep.betweenCloseOrders[0]);
  setVal('sl-close-max', cfg.sleep.betweenCloseOrders[1]);
  setVal('sl-sellall-min', cfg.sleep.afterSellAll[0]);
  setVal('sl-sellall-max', cfg.sleep.afterSellAll[1]);
  setVal('tg-token', cfg.telegram.botToken);
  setVal('tg-ids', (cfg.telegram.userIds || []).join(', '));
  setVal('path-pk', cfg.paths.privatekeysFile);
  setVal('path-proxy', cfg.paths.proxiesFile);

  // Tokens
  renderTokens();
  refreshDbStatus();
}

// ── Collect settings from form ────────────────────────────────────────────────
function collectSettings() {
  const getTypes = (limitId, marketId) => {
    const types = [];
    if (checked(limitId)) types.push('limit');
    if (checked(marketId)) types.push('market');
    return types.length ? types : ['market'];
  };

  return {
    ...config,
    general: {
      threads: parseInt(val('g-threads')) || 3,
      retry: parseInt(val('g-retry')) || 3,
      shuffleWallets: checked('g-shuffle'),
    },
    tokens: collectTokensFromUI(),
    trading: {
      ...config.trading,
      tradesCount: [parseInt(val('s-trades-min')), parseInt(val('s-trades-max'))],
      futureActions: {
        sides: {
          Long: checked('s-allow-long'),
          Short: checked('s-allow-short'),
        },
        types: {
          open: getTypes('s-open-limit', 's-open-market'),
          close: getTypes('s-close-limit', 's-close-market'),
        },
      },
      tradeAmounts: {
        amount: [parseFloat(val('s-amount-min')) || 0, parseFloat(val('s-amount-max')) || 0],
        percent: [parseFloat(val('s-pct-min')) || 70, parseFloat(val('s-pct-max')) || 90],
        deltaDiff: [parseFloat(val('d-diff-min')) || 0, parseFloat(val('d-diff-max')) || 0],
        cancelAllBefore: checked('s-cancel-all'),
      },
      futuresLimits: {
        priceDiffAmount: [0, 0],
        priceDiffPercent: [parseFloat(val('s-close-diff-min')) || 0.03, parseFloat(val('s-close-diff-max')) || 0.045],
        toWait: parseFloat(val('s-wait-fill')) || 1,
        orderType: $('d-order-type').value,
      },
      stopLoss: {
        enable: checked('s-sl-enable'),
        lossDiffAmount: [0, 0],
        lossDiffPercent: [parseFloat(val('s-sl-min')) || 0.03, parseFloat(val('s-sl-max')) || 0.045],
      },
      sellSettings: {
        cancelOrders: checked('s-sell-cancel'),
        closePositions: checked('s-sell-close'),
      },
      pairSettings: {
        pairAmount: [parseInt(val('d-pair-min')) || 2, parseInt(val('d-pair-max')) || 3],
        positionHold: [parseInt(val('d-hold-min')) || 40, parseInt(val('d-hold-max')) || 120],
      },
    },
    sleep: {
      betweenOrders: [parseInt(val('sl-orders-min')), parseInt(val('sl-orders-max'))],
      betweenThreads: [parseInt(val('sl-threads-min')), parseInt(val('sl-threads-max'))],
      afterAccount: [parseInt(val('sl-account-min')), parseInt(val('sl-account-max'))],
      betweenOpenOrders: [parseInt(val('sl-open-min')), parseInt(val('sl-open-max'))],
      betweenCloseOrders: [parseInt(val('sl-close-min')), parseInt(val('sl-close-max'))],
      afterSellAll: [parseInt(val('sl-sellall-min')), parseInt(val('sl-sellall-max'))],
    },
    telegram: {
      botToken: val('tg-token') || '',
      userIds: (val('tg-ids') || '').split(',').map((s) => s.trim()).filter(Boolean).map(Number),
    },
    paths: {
      privatekeysFile: val('path-pk') || 'user_data/privatekeys/privatekeys.txt',
      proxiesFile: val('path-proxy') || 'user_data/proxies/proxies.txt',
      databasesDir: config.paths?.databasesDir || 'databases',
    },
  };
}

// ── Save buttons ───────────────────────────────────────────────────────────────
$('btn-save-settings').addEventListener('click', async () => {
  const newCfg = collectSettings();
  const result = await window.api.saveSettings(newCfg);
  if (result.ok) { config = newCfg; alert('Настройки сохранены!'); }
  else alert(`Ошибка: ${result.error}`);
});

$('btn-save-single').addEventListener('click', async () => {
  const newCfg = collectSettings();
  const result = await window.api.saveSettings(newCfg);
  if (result.ok) { config = newCfg; alert('Настройки Single сохранены!'); }
  else alert(`Ошибка: ${result.error}`);
});

$('btn-save-delta').addEventListener('click', async () => {
  const newCfg = collectSettings();
  const result = await window.api.saveSettings(newCfg);
  if (result.ok) { config = newCfg; alert('Настройки Delta сохранены!'); }
  else alert(`Ошибка: ${result.error}`);
});

$('btn-reload-settings').addEventListener('click', async () => {
  const cfg = await window.api.reloadSettings();
  loadSettingsToForm(cfg);
  alert('Настройки перезагружены из файла.');
});

// ── Accounts page ─────────────────────────────────────────────────────────────

function renderKeyList(lines) {
  const list = $('key-list');
  list.innerHTML = '';
  lines.forEach((key) => {
    const row = document.createElement('div');
    row.className = 'key-row';
    const input = document.createElement('input');
    input.type = 'password';
    input.className = 'key-input';
    input.value = key;
    input.readOnly = true;
    input.autocomplete = 'off';

    const eyeBtn = document.createElement('button');
    eyeBtn.className = 'btn-eye';
    eyeBtn.title = 'Показать / скрыть';
    eyeBtn.textContent = '👁';
    eyeBtn.addEventListener('click', () => {
      input.type = input.type === 'password' ? 'text' : 'password';
    });

    const delBtn = document.createElement('button');
    delBtn.className = 'btn-remove';
    delBtn.title = 'Удалить';
    delBtn.textContent = '✕';
    delBtn.addEventListener('click', async () => {
      row.remove();
      updateKeysCount();
      const keys = collectKeys();
      const filePath = config.paths?.privatekeysFile || 'user_data/privatekeys/privatekeys.txt';
      await window.api.saveLinesFile(filePath, keys);
    });

    row.append(input, eyeBtn, delBtn);
    list.appendChild(row);
  });
  updateKeysCount();
}

function updateKeysCount() {
  const n = $('key-list').querySelectorAll('.key-row').length;
  $('keys-count').textContent = n ? `${n} ключей` : 'нет ключей';
}

function collectKeys() {
  return [...$('key-list').querySelectorAll('.key-input')].map((i) => i.value.trim()).filter(Boolean);
}

async function loadKeys() {
  const path = config.paths?.privatekeysFile || 'user_data/privatekeys/privatekeys.txt';
  const res = await window.api.readLinesFile(path);
  renderKeyList(res.ok ? res.lines : []);
}

async function loadProxies() {
  const path = config.paths?.proxiesFile || 'user_data/proxies/proxies.txt';
  const res = await window.api.readLinesFile(path);
  $('proxy-textarea').value = res.ok ? res.lines.join('\n') : '';
  updateProxiesCount(res.ok ? res.lines.length : 0);
}

function updateProxiesCount(n) {
  $('proxies-count').textContent = n ? `${n} прокси` : 'нет прокси';
}

$('btn-save-keys').addEventListener('click', async () => {
  const newKeys = $('new-key-input').value.split('\n').map((k) => k.trim()).filter(Boolean);
  const keys = [...collectKeys(), ...newKeys];
  const path = config.paths?.privatekeysFile || 'user_data/privatekeys/privatekeys.txt';
  const res = await window.api.saveLinesFile(path, keys);
  if (res.ok) {
    $('new-key-input').value = '';
    renderKeyList(keys);
    alert(`Сохранено ${keys.length} ключей.`);
  } else {
    alert(`Ошибка: ${res.error}`);
  }
});

$('btn-reload-keys').addEventListener('click', loadKeys);

$('btn-save-proxies').addEventListener('click', async () => {
  const lines = $('proxy-textarea').value.split('\n').map((l) => l.trim()).filter(Boolean);
  const path = config.paths?.proxiesFile || 'user_data/proxies/proxies.txt';
  const res = await window.api.saveLinesFile(path, lines);
  if (res.ok) { updateProxiesCount(lines.length); alert(`Сохранено ${lines.length} прокси.`); }
  else alert(`Ошибка: ${res.error}`);
});

$('btn-reload-proxies').addEventListener('click', loadProxies);

$('proxy-textarea').addEventListener('input', () => {
  const n = $('proxy-textarea').value.split('\n').map((l) => l.trim()).filter(Boolean).length;
  updateProxiesCount(n);
});

// ── Init ───────────────────────────────────────────────────────────────────────
(async () => {
  const cfg = await window.api.getSettings();
  loadSettingsToForm(cfg);
  loadKeys();
  loadProxies();
})();
