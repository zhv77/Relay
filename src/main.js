'use strict';

// Electron shell.

const path = require('node:path');
const { app, BrowserWindow, ipcMain, Menu, shell, Tray } = require('electron');
const packageCheck = process.argv.includes('--package-check');
// Fixed folder so settings survive updates; carries over data from the old name.
const userData = packageCheck
  ? path.join(require('node:os').tmpdir(), `relay-package-check-${process.pid}`)
  : path.join(app.getPath('appData'), 'relay');
if (!packageCheck) {
  const fs = require('node:fs');
  const legacy = path.join(app.getPath('appData'), 'warframe-trader');
  if (!fs.existsSync(userData) && fs.existsSync(legacy)) {
    try { fs.cpSync(legacy, userData, { recursive: true }); } catch {}
  }
}
app.setPath('userData', userData);

const holdings = require('./holdings');
const vendorViews = require('./vendors');
const sets = require('./sets');
const { Account } = require('./account');
const { Presence } = require('./presence');
const { Store } = require('./store');
const { Fetcher } = require('./fetcher');
const { Vendors } = require('./wiki');
const { Void } = require('./void');
const scanner = require('./scanner');
const { GameLog } = require('./eelog');
const relics = require('./relics');
const market = require('./market');

// Off unless RELAY_WATCH is set.
require('./watch').start(ipcMain);

// Reading takes a second and a half, and the answer only changes when the game syncs.
const CACHE_MS = 2 * 60_000;

// Periodic fallback between bounded login/sync capture windows.
const WAITING_MS = 30_000;

// How long to keep scanning after the client says it has synced.
const HUNT_MS = 30_000;
let huntUntil = 0;
let gameLog = null;
let cached = null;
let scanning = null;
let rescanRequested = false;
let mainWindow = null;
let tray = null;
// Closing the window only hides it to the tray; this is set once the app really quits.
let quitting = false;
let updateTimer;
let account = null;
let presence = null;
let store = null;
let fetcher = null;
let vendors = null;
let voidData = null;
let overlay = null;

let listings = new Map();
let listingsAt = 0;
const LISTINGS_MS = 30_000;

// warframe.market answers /orders/my with an item id and nothing else - no slug, no name.
let byId = null;
function nameOrder(order) {
  if (!byId || byId.size !== store.items.length) {
    byId = new Map();
    for (const item of store.items) byId.set(item.id, item);
  }
  const item = order.itemId ? byId.get(order.itemId) : null;
  return { ...order, slug: order.slug || item?.slug || null, name: item?.name || null };
}

async function myListings({ force = false } = {}) {
  if (!force && Date.now() - listingsAt < LISTINGS_MS) return listings;
  if (!account?.token) {
    listings = new Map();
    return listings;
  }
  try {
    const orders = (await account.orders()).map(nameOrder);
    listings = new Map(
      orders.filter((order) => order.type === 'sell' && order.slug).map((o) => [o.slug, o])
    );
    listingsAt = Date.now();
  } catch {
    // A rejected token should not blank the table; it just means no Yours.
    listings = new Map();
  }
  return listings;
}

// Starts a scan, or joins the one already running.
function refreshHoldings({ focus = false, afterCurrent = false } = {}) {
  if (scanning) {
    if (afterCurrent) rescanRequested = true;
    return scanning;
  }
  scanning = holdings
    .read({ focus })
    .catch((error) => ({ ok: false, error: error.message, rows: [] }))
    .then((result) => {
      cached = { ...result, at: Date.now() };
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('holdings:changed');
      }
      return cached;
    })
    .finally(() => {
      scanning = null;
      if (rescanRequested) {
        rescanRequested = false;
        refreshHoldings({});
      }
    });
  return scanning;
}

// What you own - answered immediately, always.
function readHoldings({ force = false, focus = false, wait = false } = {}) {
  const window = cached?.partial ? WAITING_MS : CACHE_MS;
  const stale = !cached || Date.now() - cached.at >= window;
  const scan = force || stale ? refreshHoldings({ focus }) : null;
  if (wait) return scan || cached;

  if (cached) {
    if (focus && fetcher) fetcher.setFocus('holdings', cached.rows.map((r) => r.slug));
    return cached;
  }
  return { ok: true, pending: true, rows: [], at: 0 };
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    backgroundColor: '#111317',
    title: 'Relay',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  window.removeMenu();
  window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  window.on('close', (event) => {
    if (quitting || !tray) return;
    event.preventDefault();
    window.hide();
  });
  return window;
}

// Keeps Relay, and the in-game overlay, running while its window is closed.
async function createTray(window) {
  const show = () => {
    if (window.isDestroyed()) return;
    window.show();
    window.focus();
  };
  tray = new Tray(await app.getFileIcon(process.execPath, { size: 'small' }));
  tray.setToolTip('Relay');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Relay', click: show },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]));
  tray.on('click', show);
}

ipcMain.handle('holdings:read', (_event, options) => readHoldings(options || {}));
ipcMain.handle('mastery:read', () => holdings.mastery());
ipcMain.handle('fetch:progress', () => fetcher.progress());
ipcMain.handle('catalogue:status', () => catalogueStatus());

// The renderer declares what is on screen, because only the renderer knows.
ipcMain.handle('focus:set', (_event, key, slugs) => {
  fetcher.setFocus(key, Array.isArray(slugs) ? slugs : []);
  return fetcher.progress();
});
ipcMain.handle('sets:read', (_event, options = {}) => {
  const held = readHoldings({});
  const owned = {};
  for (const row of held.rows || []) if (row.slug) owned[row.slug] = row.count;
  return sets.build({ owned, paths: held.paths || {}, pending: Boolean(held.pending), partial: held.partial || !held.ok, warning: held.warning || held.error });
});
ipcMain.handle('relics:read', async (_event, options = {}) => {
  await voidData.ensure();
  const held = readHoldings({});
  return relics.build({
    paths: held.paths || {},
    wanted: setsWanted(),
    pending: Boolean(held.pending),
    partial: held.partial || !held.ok,
    warning: held.warning || held.error,
  });
});

// Which parts would finish a set you are short of.
function setsWanted() {
  const held = readHoldings({});
  const owned = {};
  for (const row of held.rows || []) if (row.slug) owned[row.slug] = row.count;
  const built = sets.build({ owned, pending: Boolean(held.pending), partial: held.partial || !held.ok });
  const wanted = {};
  for (const row of built.rows || []) {
    if (!row.missingCount) continue;
    for (const part of row.missing) {
      (wanted[part.slug] = wanted[part.slug] || []).push(row.name);
    }
  }
  return wanted;
}

// Open an item's page on warframe.market, in the user's own browser.
ipcMain.handle('market:open', async (_event, slug) => {
  if (typeof slug !== 'string' || !/^[a-z0-9_]{1,120}$/.test(slug)) {
    return { ok: false, error: 'not an item' };
  }
  await shell.openExternal(`https://warframe.market/items/${slug}`);
  return { ok: true };
});

ipcMain.handle('vendors:list', () => vendorViews.list());
ipcMain.handle('vendors:stock', async (_event, key, options = {}) => {
  const held = readHoldings({});
  const mine = await myListings({ force: options.force });
  const owned = {};
  for (const row of held.rows || []) if (row.slug) owned[row.slug] = row.count;
  return vendorViews.stock(key, { owned, listings: mine });
});

ipcMain.handle('presence:read', () => presence.report());
ipcMain.handle('presence:set', async (_event, status) => {
  try {
    return await presence.set(status);
  } catch (error) {
    return { ...presence.report(), error: error.message };
  }
});

ipcMain.handle('account:status', () => account.status());
ipcMain.handle('account:orders', async () => {
  if (!account.token) return { ok: false, error: 'no token set', orders: [] };
  try {
    const orders = (await account.orders()).map(nameOrder);
    return { ok: true, orders };
  } catch (error) {
    return { ok: false, error: error.message, orders: [] };
  }
});
// Everything that has to be redone when the account changes.
function accountChanged() {
  listingsAt = 0;
  // A new token is a new session: the old socket is signed in as nobody now.
  presence.restart();
  // And a first token is the first budget, so the catalogue can finally be fetched.
  refreshCatalogue();
}

ipcMain.handle('account:setToken', async (_event, token) => {
  const status = await account.setToken(token);
  accountChanged();
  return status;
});

ipcMain.handle('account:signIn', async (_event, email, password) => {
  try {
    const status = await account.signIn(String(email || ''), String(password || ''));
    accountChanged();
    return status;
  } catch (error) {
    return {
      hasToken: Boolean(account.token),
      masked: account.masked(),
      valid: false,
      error: error.message,
    };
  }
});

ipcMain.handle('orders:post', async (_event, orders) => {
  const results = [];
  for (const order of orders) {
    try {
      await account.create(order);
      results.push({ slug: order.slug, ok: true });
    } catch (error) {
      results.push({ slug: order.slug, ok: false, error: error.message });
    }
  }
  listingsAt = 0;
  return { results, posted: results.filter((r) => r.ok).length };
});

ipcMain.handle('orders:remove', async (_event, ids) => {
  const results = [];
  for (const id of ids) {
    try {
      await account.remove(id);
      results.push({ id, ok: true });
    } catch (error) {
      results.push({ id, ok: false, error: error.message });
    }
  }
  listingsAt = 0;
  return { results, removed: results.filter((r) => r.ok).length };
});

const smoke = process.argv.includes('--smoke');

app.whenReady().then(async () => {
  if (packageCheck) return require('./package-check').run({ app, BrowserWindow });
  const updates = require('./updates').createUpdates(require('electron-updater').autoUpdater, {
    enabled: app.isPackaged && process.platform === 'win32', version: app.getVersion(),
    changed: state => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('updates:changed', state);
    },
  });
  ipcMain.handle('updates:state', () => updates.state());
  ipcMain.handle('updates:act', () => updates.act());
  if (app.isPackaged) {
    updateTimer = setInterval(() => updates.check(), 4 * 60 * 60 * 1000);
    updateTimer.unref();
    updates.check();
  }
  scanner.warm();
  account = new Account(app.getPath('userData'));
  market.useToken(() => account.token);

  store = new Store(app.getPath('userData'));
  vendors = new Vendors(store);
  voidData = new Void(store);

  // Created before the fetcher, which reports progress into it.
  const window = createWindow();
  mainWindow = window;
  if (!smoke) createTray(window).catch(() => {});

  fetcher = new Fetcher(store, {
    onProgress: (state) => {
      if (!window.isDestroyed()) window.webContents.send('fetch:progress', state);
    },
  });
  holdings.attach(store, fetcher);
  vendorViews.attach(store, fetcher, vendors);
  sets.attach(store, fetcher, voidData);
  relics.attach(store, fetcher, voidData);

  fetcher.start();
  refreshCatalogue();
  // One request a week from GitHub, and everything about relics depends on it.
  voidData.ensure().catch(() => {});

  let lastPid = null;
  const watchGame = setInterval(async () => {
    let pid = null;
    try {
      pid = await scanner.pid();
    } catch {
      return;
    }
    if (pid === lastPid) return;
    const appeared = pid != null;
    lastPid = pid;
    if (appeared) {
      huntUntil = Date.now() + 60_000;
      refreshHoldings({ afterCurrent: true });
    }
  }, 1_000);
  watchGame.unref();

  // The client says when the payload has landed, so the app stops guessing.
  gameLog = new GameLog();
  gameLog.on('sync', () => {
    huntUntil = Date.now() + HUNT_MS;
    refreshHoldings({ afterCurrent: true });
  });
  gameLog.start();

  overlay = require('./overlay').start({
    pid: () => scanner.pid(),
    folder: path.join(app.getPath('userData'), 'captures'),
    debug: process.env.RELAY_OVERLAY === 'debug',
  });
  window.on('closed', () => overlay.stop());

  const waitForSync = setInterval(() => {
    if (!lastPid) return;
    if (Date.now() < huntUntil || !cached || (cached.partial && Date.now() - cached.at >= WAITING_MS)) refreshHoldings({});
  }, 250);
  waitForSync.unref();

  presence = new Presence(account, {
    onChange: (state) => {
      if (!window.isDestroyed()) window.webContents.send('presence:changed', state);
    },
  });
  presence.start();

  window.webContents.on('did-finish-load', () => {
    if (!window.isDestroyed()) window.webContents.send('presence:changed', presence.report());
  });

  // Optional local verification without dumping inventory paths or account data.
  if (process.argv.includes('--inventory-check')) {
    refreshHoldings({}).then((result) => console.log('inventory-check: ' + JSON.stringify({
      ok: result.ok, items: result.items, tradeable: result.tradeable,
      heldAt: result.heldAt, partial: result.partial, stale: result.stale,
      error: result.error,
    })));
  }

  if (smoke) {
    const problems = [];
    window.webContents.on('console-message', (_e, level, message) => {
      if (level >= 2) problems.push(message);
    });
    window.webContents.on('render-process-gone', (_e, details) =>
      problems.push('renderer gone: ' + details.reason)
    );
    await new Promise((resolve) => window.webContents.once('did-finish-load', resolve));
    // The one caller that has nothing to report without the scan.
    const result = await readHoldings({ force: false, wait: true });
    console.log(
      result.ok
        ? `smoke: window loaded, ${result.rows.length} rows, ${result.tradeable} tradeable` +
            (result.warning ? ` (${result.warning})` : '')
        : `smoke: window loaded, unavailable (${result.error})`
    );
    const panel = await window.webContents.executeJavaScript(`
      (async () => {
        document.querySelector('.tab[data-tab="syndicates"]').click();
        await new Promise((r) => setTimeout(r, 6000));
        return {
          vendors: (syn.vendors || []).length,
          rows: document.querySelectorAll('#offerRows tr').length,
          columns: document.querySelectorAll('#offerGrid thead th').length,
          cells: document.querySelector('#offerRows tr')?.cells.length ?? 0,
          actions: document.getElementById('offerActions').textContent,
          status: document.getElementById('offerStatus').textContent,
          account: document.getElementById('account').textContent,
          vendorSearch: (() => {
            const closed = {
              panelHidden: document.getElementById('vendorPanel').hidden,
              label: document.getElementById('vendorLabel').textContent,
            };
            document.getElementById('vendorButton').click();
            const opened = {
              panelShown: !document.getElementById('vendorPanel').hidden,
              searchIsFirst:
                document.getElementById('vendorPanel').firstElementChild?.id === 'vendorSearch',
              allItems: document.querySelectorAll('#vendorList .combo-item').length,
            };
            const box = document.getElementById('vendorSearch');
            box.value = 'meridian';
            box.dispatchEvent(new Event('input'));
            const items = [...document.querySelectorAll('#vendorList .combo-item')];
            const groups = [...document.querySelectorAll('#vendorList .combo-group')]
              .map((node) => node.textContent);
            return {
              closed,
              opened,
              matches: items.length,
              first: items[0]?.dataset.key,
              groups,
            };
          })(),
          groupsUnfiltered: (() => {
            const box = document.getElementById('vendorSearch');
            box.value = '';
            box.dispatchEvent(new Event('input'));
            const groups = [...document.querySelectorAll('#vendorList .combo-group')]
              .map((n) => n.textContent);
            const openWorlds = (() => {
              const nodes = [...document.querySelectorAll('#vendorList > *')];
              const at = nodes.findIndex((n) => n.textContent === 'Open worlds');
              if (at < 0) return null;
              const rows = [];
              for (let i = at + 1; i < nodes.length; i += 1) {
                if (nodes[i].classList.contains('combo-group')) break;
                rows.push(nodes[i].textContent.replace(/s+/g, ' ').trim());
              }
              return rows;
            })();
            // Picking closes it again and the label follows the choice.
            document.querySelector('#vendorList .combo-item').click();
            return {
              groups,
              openWorlds,
              closedAfterPick: document.getElementById('vendorPanel').hidden,
              label: document.getElementById('vendorLabel').textContent,
            };
          })(),
          relicsTab: await (async () => {
            document.querySelector('.tab[data-tab="relics"]').click();
            await new Promise((r) => setTimeout(r, 4000));
            const heads = [...document.querySelectorAll('#relicGrid thead th')];
            const first = document.querySelector('#relicRows tr');
            const mine = {
              heads: heads.length,
              cells: first ? first.cells.length : 0,
              rows: document.getElementById('relicRows').children.length,
              status: document.getElementById('relicStatus').textContent,
              pair: first
                ? heads.map((h, i) => [h.textContent.trim(), first.cells[i]?.textContent.trim() ?? '(missing)'])
                : [],
            };
            document.getElementById('relicMine').click();
            await new Promise((r) => setTimeout(r, 300));
            mine.allRows = document.getElementById('relicRows').children.length;
            mine.allStatus = document.getElementById('relicStatus').textContent;
            const firstAll = document.querySelector('#relicRows tr');
            mine.firstAll = firstAll
              ? [...firstAll.cells].map((c) => c.textContent.trim()).slice(0, 9)
              : null;
            const images = [...document.querySelectorAll('#relicRows img.icon')];
            await new Promise((r) => setTimeout(r, 2500));
            mine.icons = {
              rendered: images.length,
              loaded: images.filter((img) => img.naturalWidth > 0).length,
              first: images[0]?.src || null,
            };
            return mine;
          })(),
          setsTab: await (async () => {
            document.querySelector('.tab[data-tab="sets"]').click();
            await new Promise((r) => setTimeout(r, 2500));
            [...document.querySelectorAll('#setGrid th')].find((t) => t.dataset.sort === 'name').click();
            await new Promise((r) => setTimeout(r, 1500));
            const visible = (nodes) =>
              [...nodes].filter((n) => getComputedStyle(n).display !== 'none');
            const heads = visible(document.querySelectorAll('#setGrid thead th'));
            const first = document.querySelector('#setRows tr');
            const cells = first ? visible(first.cells) : [];
            const out = {
              rows: document.querySelectorAll('#setRows tr').length,
              heads: heads.length,
              cells: cells.length,
              status: document.getElementById('setStatus').textContent,
              pair: heads.map((h, i) => [h.textContent.trim(), cells[i]?.textContent.trim() ?? '(missing)']).slice(0, 6),
              focus: (await window.warframe.fetchProgress()).key,
              focusTotal: (await window.warframe.fetchProgress()).total,
              nekrosVisible: [...document.querySelectorAll('#setRows tr')]
                .some((tr) => tr.cells[0].textContent.includes('Nekros Prime')),
              redraws: await (async () => {
            // Counts full rebuilds over a window: this is the number that was making the table unusable.
            let count = 0;
            const body = document.getElementById('setRows');
            const watcher = new MutationObserver((records) => {
              for (const record of records) if (record.removedNodes.length > 20) count += 1;
            });
            watcher.observe(body, { childList: true });
            await new Promise((r) => setTimeout(r, 10000));
            watcher.disconnect();
            return { rebuildsIn10s: count, rows: body.children.length };
          })(),
              viewport: (() => {
            const rows = [...document.querySelectorAll('#setRows tr')];
            if (!rows.length) return null;
            const height = window.innerHeight;
            const onScreen = rows.filter((tr) => {
              const r = tr.getBoundingClientRect();
              return r.bottom > 0 && r.top < height;
            });
            return {
              windowHeight: height,
              rowHeight: Math.round(rows[0].getBoundingClientRect().height),
              fullyVisible: onScreen.length,
              first: onScreen[0]?.cells[0].textContent.trim(),
              last: onScreen[onScreen.length - 1]?.cells[0].textContent.trim(),
            };
          })(),
              focusOrder: await (async () => {
            const p = await window.warframe.fetchProgress();
            const rows = [...document.querySelectorAll('#setRows tr')];
            const firstVisible = rows.find((tr) => {
              const r = tr.getBoundingClientRect();
              return r.bottom > 0 && r.top < window.innerHeight;
            });
            return { total: p.total, key: p.key, firstOnScreen: firstVisible?.cells[0].textContent.trim() };
          })(),
              narrow: (() => {
                // A small window, measured: every cell in a row should be as tall as the row.
                const wrap = document.getElementById('panel-sets');
                const before = wrap.style.width;
                wrap.style.width = '760px';
                const tr = document.querySelector('#setRows tr');
                const heights = tr ? [...tr.cells].map((td) => Math.round(td.getBoundingClientRect().height)) : [];
                const row = tr ? Math.round(tr.getBoundingClientRect().height) : 0;
                wrap.style.width = before;
                return { row, heights };
              })(),
              linked: (() => {
                const tr = document.querySelector('#setRows tr');
                const chip = tr?.querySelector('.part');
                const name = tr?.cells[0];
                return {
                  row: Boolean(tr?.classList.contains('linked')),
                  name: Boolean(name?.querySelector('.linked')),
                  chip: Boolean(chip?.classList.contains('linked')),
                  title: name?.querySelector('.linked')?.title || null,
                };
              })(),
              greenRow: (() => {
                const tr = [...document.querySelectorAll('#setRows tr.near')][0];
                return tr ? { name: tr.cells[0].textContent.trim(), title: tr.title } : null;
              })(),
              hoverRule: [...document.styleSheets]
                .flatMap((s) => { try { return [...s.cssRules]; } catch { return []; } })
                .some((rule) => rule.selectorText && rule.selectorText.includes('tr:hover')),
              components: (() => {
                const tr = [...document.querySelectorAll('#setRows tr')]
                  .find((row) => row.cells[0].textContent.includes('Dual Kamas Prime'))
                  || document.querySelector('#setRows tr');
                if (!tr) return null;
                const chips = [...tr.querySelectorAll('.part')].map((c) => ({
                  text: c.textContent.trim(),
                  have: c.classList.contains('have'),
                }));
                return { set: tr.cells[0].textContent.trim(), have: tr.cells[1].textContent.trim(), chips };
              })(),
            };
            document.querySelector('.tab[data-tab="syndicates"]').click();
            await new Promise((r) => setTimeout(r, 1200));
            return out;
          })(),
          catalogueMessages: await (async () => {
            const read = (id) => document.getElementById(id).textContent;
            document.querySelector('.tab[data-tab="sets"]').click();
            await new Promise((r) => setTimeout(r, 800));
            const out = {};
            for (const state of [
              { state: 'needsLogin' },
              { state: 'loading' },
              { state: 'failed', error: 'HTTP 503', retryAt: Date.now() + 30000 },
            ]) {
              applyCatalogue(state);
              out[state.state] = read('setStatus');
              if (state.state === 'needsLogin') {
                document.querySelector('.tab[data-tab="relics"]').click();
                await new Promise((r) => setTimeout(r, 300));
                applyCatalogue(state);
                out.relics = read('relicStatus');
                document.querySelector('.tab[data-tab="sets"]').click();
                await new Promise((r) => setTimeout(r, 300));
                applyCatalogue(state);
              }
            }
            applyCatalogue(await window.warframe.catalogue());
            out.restored = catalogue.state;
            document.querySelector('.tab[data-tab="syndicates"]').click();
            return out;
          })(),
          vendorListOverflow: await (async () => {
            // The dropdown must never scroll sideways: measured open, with the widest child named if it does.
            el('vendorButton').click();
            await new Promise((r) => setTimeout(r, 200));
            const list = document.getElementById('vendorList').closest('.combo-list') || document.getElementById('vendorList');
            const box = list.getBoundingClientRect();
            let widest = null;
            for (const child of list.querySelectorAll('*')) {
              const right = child.getBoundingClientRect().right;
              if (!widest || right > widest.right) widest = { right, what: child.className || child.tagName };
            }
            let clipped = 0;
            for (const item of list.querySelectorAll('.combo-item')) {
              if (item.scrollWidth > item.clientWidth + 1) clipped += 1;
            }
            const out = {
              clipped,
              clientWidth: list.clientWidth,
              scrollWidth: list.scrollWidth,
              width: Math.round(box.width),
              widest: widest && { overBy: Math.round(widest.right - box.right), what: widest.what },
            };
            el('vendorButton').click();
            return out;
          })(),
          offerLink: (() => {
            const tr = document.querySelector('#offerRows tr');
            const link = tr?.cells[0].querySelector('.linked');
            return { linked: Boolean(link), title: link?.title || null };
          })(),
          alignment: (() => {
            // Compares what is *visible*, which is the only thing that can be misaligned.
            const visible = (nodes) =>
              [...nodes].filter((n) => getComputedStyle(n).display !== 'none');
            const check = () => {
              const heads = visible(document.querySelectorAll('#offerGrid thead th'));
              const first = document.querySelector('#offerRows tr');
              const cells = first ? visible(first.cells) : [];
              const pair = heads.map((h, i) => [
                h.textContent.trim(),
                cells[i]?.textContent.trim() ?? '(missing)',
              ]);
              return { heads: heads.length, cells: cells.length, pair: pair.slice(0, 8) };
            };
            const collapsed = check();
            document.getElementById('offerExtras').click();
            const expanded = check();
            document.getElementById('offerExtras').click();
            return { collapsed, expanded };
          })(),
          fetchBar: (() => {
            const bar = document.getElementById('fetchBar');
            return {
              shown: !bar.hidden,
              text: document.getElementById('fetchText').textContent,
              fill: document.getElementById('fetchFill').style.width,
            };
          })(),
          presence: (() => {
            const box = document.getElementById('presenceBox');
            return {
              shown: !box.hidden,
              status: document.getElementById('presenceStatus').value,
              enabled: !document.getElementById('presenceStatus').disabled,
              dot: document.getElementById('presenceDot').className,
            };
          })(),
          accountTab: (() => {
            document.querySelector('.tab[data-tab="account"]').click();
            return {
              shown: !document.getElementById('panel-account').hidden,
              status: document.getElementById('tokenStatus').textContent,
              signIn: Boolean(document.getElementById('signInForm')),
              tokenFallback: Boolean(document.getElementById('tokenInput')),
              form: (() => {
                const form = document.getElementById('signInForm');
                const email = document.getElementById('signInEmail');
                const submit = document.getElementById('signIn');
                const out = document.getElementById('clearToken');
                const box = form.getBoundingClientRect();
                return {
                  emailBackground: getComputedStyle(email).backgroundColor,
                  emailColor: getComputedStyle(email).color,
                  formWidth: Math.round(box.width),
                  signInLeft: Math.round(submit.getBoundingClientRect().left - box.left),
                  gapBetweenButtons: Math.round(
                    out.getBoundingClientRect().left - submit.getBoundingClientRect().right
                  ),
                };
              })(),
            };
          })(),
        };
      })()
    `);
    console.log('smoke: syndicates ' + JSON.stringify(panel));
    for (const problem of problems) console.log('smoke: renderer error: ' + problem);
    app.quit();
    return;
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// The catalogue changes when DE adds items, which is not often.
const CATALOGUE_MS = 12 * 60 * 60 * 1000;

// A failed download is retried on its own rather than waiting for a restart.
const CATALOGUE_RETRY_MS = 30_000;
let catalogueFetch = { state: 'idle', error: null, retryAt: null };
let catalogueTimer = null;

// Where the item catalogue stands, in terms the window can say out loud.
function catalogueStatus() {
  if (store?.items.length) return { state: 'ready', error: null };
  if (!market.hasToken()) return { state: 'needsLogin', error: null };
  return { ...catalogueFetch };
}

function pushCatalogue() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('catalogue:changed', catalogueStatus());
  }
}

async function refreshCatalogue() {
  const complete = store.items.some((item) => item.thumb);
  if (store.items.length && complete && Date.now() - store.itemsAt < CATALOGUE_MS) return;
  if (!market.hasToken()) {
    pushCatalogue();
    return;
  }
  if (catalogueFetch.state === 'loading') return;

  clearTimeout(catalogueTimer);
  catalogueFetch = { state: 'loading', error: null, retryAt: null };
  pushCatalogue();
  try {
    store.setItems(await market.items());
    catalogueFetch = { state: 'ready', error: null, retryAt: null };
  } catch (error) {
    catalogueFetch = {
      state: 'failed',
      error: error.needsToken ? 'not signed in' : error.message,
      retryAt: Date.now() + CATALOGUE_RETRY_MS,
    };
    catalogueTimer = setTimeout(refreshCatalogue, CATALOGUE_RETRY_MS);
    catalogueTimer.unref?.();
  }
  pushCatalogue();
}

let stopped = false;
app.on('before-quit', (event) => {
  quitting = true;
  if (stopped) return;
  stopped = true;
  clearInterval(updateTimer);
  presence?.stop();
  fetcher?.stop();
  store?.close();
  gameLog?.stop();
  overlay?.stop();
  tray?.destroy();
  // Quit again once any memory read in progress has finished.
  event.preventDefault();
  scanner.drain().finally(() => app.quit());
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
