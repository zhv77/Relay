'use strict';

// Offline Electron smoke check: real renderer, fixture IPC, no account/network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, ipcMain, session } = require('electron');
const root = path.resolve(__dirname, '../scratch/inventory-ui');
fs.mkdirSync(root, { recursive: true });
app.setPath('userData', root);
app.disableHardwareAcceleration();
const warning = 'Saved inventory: completeness is unverified; missing items are unknown.';
const store = {
  items: [
    { slug: 'test_set', tags: ['set'], name: 'Test Set' },
    { slug: 'test_a', name: 'Test A' }, { slug: 'test_b', name: 'Test B' },
  ],
  book: () => ({ sellOnline: { platinum: 10 } }),
  stats: () => ({ median7d: 50, volume7d: 20 }),
};
const sets = require('../src/sets');
sets.attach(store);
const relics = require('../src/relics');
relics.attach(store, null, { relics: [{ name: 'Lith Test', paths: { Intact: '/Lotus/Test' }, rewards: [] }] });
const values = {
  'catalogue:status': () => ({ state: 'ready' }),
  'updates:state': () => ({ status: 'available', currentVersion: '0.1.1', version: '0.1.2' }),
  'updates:act': () => ({ status: 'ready', currentVersion: '0.1.1', version: '0.1.2' }),
  'holdings:read': () => ({ ok: true, partial: true, stale: true, items: 1, tradeable: 1, warning,
    rows: [{ name: 'Test A', slug: 'test_a', count: 2 }] }),
  'mastery:read': () => ({ ok: true, rank: 12, xp: 373720 }),
  'sets:read': () => sets.build({ owned: { test_a: 2 }, partial: true, warning }),
  'relics:read': () => relics.build({ paths: { '/Lotus/Test': 2 }, partial: true, warning }),
  'account:status': () => ({ hasToken: false }),
  'account:orders': () => ({ ok: true, orders: [] }),
  'presence:read': () => ({ hasToken: false }),
  'fetch:progress': () => ({ needsToken: true }),
  'focus:set': () => ({}),
  'vendors:list': () => ({ ok: true, vendors: [] }),
};
for (const [channel, value] of Object.entries(values)) ipcMain.handle(channel, value);

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_details, callback) => callback({ cancel: true }));
  const window = new BrowserWindow({ show: false, width: 1280, height: 860,
    webPreferences: { preload: path.resolve(__dirname, '../src/preload.js'), contextIsolation: true, nodeIntegration: false } });
  const errors = [];
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
  try {
    await window.loadFile(path.resolve(__dirname, '../renderer/index.html'));
    const result = await window.webContents.executeJavaScript(`(async () => {
      await load();
      showUpdate(await window.warframe.updateState());
      const updateAvailable = el('update').textContent;
      showUpdate(await window.warframe.updateAction());
      const updateReady = el('update').textContent;
      document.querySelector('.tab[data-tab="sets"]').click();
      await loadSets();
      const set = document.querySelector('#setRows tr');
      const setState = { status: el('setStatus').textContent, count: set.cells[1].textContent,
        unknown: set.cells[2].textContent, cost: set.cells[5].textContent, profit: set.cells[7].textContent,
        near: set.classList.contains('near') };
      document.querySelector('.tab[data-tab="relics"]').click();
      await loadRelics();
      document.querySelector('.tab[data-tab="mastery"]').click();
      await loadMastery();
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { updateAvailable, updateReady, status: el('status').textContent, warning: el('status').title, duplicateHidden: el('warn').hidden,
        set: setState, relicStatus: el('relicStatus').textContent,
        relicCount: document.querySelector('#relicRows tr').cells[1].textContent,
        masteryRank: el('masteryRank').textContent, masteryProgress: el('masteryProgress').textContent,
        holdingsTab: document.querySelector('.tab[data-tab="holdings"]'),
        activeTab: document.querySelector('.tab.active').dataset.tab,
        masteryHidden: el('panel-mastery').hidden };
    })()`);
    assert.match(result.status, /Estimated from your latest inventory scan/);
    assert.equal(result.updateAvailable, 'Preparing update…');
    assert.equal(result.updateReady, 'Restart to update');
    assert.equal(result.duplicateHidden, true);
    assert.match(result.warning, /unverified/);
    assert.match(result.set.status, /Estimated from your latest inventory scan/);
    assert.equal(result.set.count, '1/2');
    assert.doesNotMatch(result.set.unknown, /\? B/);
    assert.equal(result.set.cost, '10p');
    assert.equal(result.set.profit, '+40p');
    assert.equal(result.set.near, true);
    assert.match(result.relicStatus, /Estimated from your latest inventory scan/);
    assert.equal(result.relicCount, '2');
    assert.equal(result.masteryRank, 'Mastery Rank 12');
    assert.match(result.masteryProgress, /13,720 \/ 62,500/);
    assert.equal(result.holdingsTab, null);
    assert.equal(result.activeTab, 'mastery');
    assert.equal(result.masteryHidden, false);
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(root, 'relics.png'), (await window.webContents.capturePage()).toPNG());
    console.log('Inventory UI passed: simple counts, estimated completion costs, no renderer errors.');
    app.exit(0);
  } catch (error) { console.error(error.stack); app.exit(1); }
});
