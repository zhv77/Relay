'use strict';

// Run only on explicit request, against the packaged runtime.
async function run({ app, BrowserWindow }) {
  const assert = require('node:assert/strict');
  const scanner = require('./scanner');
  let window;
  try {
    assert.equal(app.isPackaged, true);
    const updater = require('electron-updater').autoUpdater;
    assert.equal(typeof updater.checkForUpdates, 'function');
    assert.equal(typeof updater.quitAndInstall, 'function');
    await scanner.pid(); // Exercises loading Koffi from a packaged worker.
    const { Client } = require('./memory');
    const client = new Client(process.pid);
    try { assert.equal(client.isAlive(), true); } finally { client.close(); }
    window = new BrowserWindow({ show: false, webPreferences: {
      preload: require('node:path').join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
    } });
    await window.loadURL('data:text/html,<html><body>Package check</body></html>');
    assert.equal(await window.webContents.executeJavaScript('typeof window.warframe?.holdings'), 'function');
    console.log('Packaged app check passed: native inventory worker and preload bridge loaded.');
    scanner.stop();
    window.destroy();
    app.exit(0);
  } catch (error) {
    console.error(error.stack);
    scanner.stop();
    window?.destroy();
    app.exit(1);
  }
}

module.exports = { run };
