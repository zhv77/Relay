'use strict';

// Fail the build if local data or development files reached the distribution.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const asar = require('@electron/asar');
const root = path.resolve(__dirname, '..');
const resources = path.join(root, 'dist/win-unpacked/resources');
const archive = path.join(resources, 'app.asar');
const files = asar.listPackage(archive).map((file) => file.replaceAll('\\', '/').replace(/^\//, ''));
const allowed = /^(src\/[^/]+\.js|renderer\/(index\.html|overlay\.html|renderer\.js)|package\.json|node_modules(?:\/.*)?|src|renderer)$/;
for (const file of files) {
  assert.ok(allowed.test(file), `Unexpected packaged file: ${file}`);
  assert.ok(!/(^|\/)(\.env(?:\..*)?|config\.local\.json|account\.json|prices\.json|entries\.json|capture\.json|mission-capture\.json)$/.test(file), `Personal data in package: ${file}`);
  assert.ok(file !== 'src/probe.js', 'The diagnostic entry point must not ship');
}
for (const file of ['src/main.js', 'src/inventory-worker.js', 'src/preload.js', 'renderer/index.html', 'renderer/renderer.js']) {
  assert.ok(files.includes(file), `Missing runtime file: ${file}`);
}
assert.ok(files.some((file) => /node_modules\/koffi\/.*win32_x64.*\.node$/.test(file)), 'Missing Windows inventory-reader native module');
const version = require('../package.json').version;
const filename = `Relay-Setup-${version}-x64.exe`;
const installer = path.join(root, 'dist', filename);
assert.ok(fs.statSync(installer).size > 10 * 1024 * 1024, 'Installer is incomplete (possibly an intermediate uninstaller helper)');
const digest = crypto.createHash('sha256').update(fs.readFileSync(installer)).digest('hex');
fs.writeFileSync(path.join(root, 'dist', 'SHA256SUMS.txt'), `${digest}  ${filename}\n`);
console.log(`Package verified: app files and runtime dependencies only. Installer: ${filename}`);
const config = require('js-yaml').load(fs.readFileSync(path.join(resources, 'app-update.yml'), 'utf8'));
assert.equal(config.provider, 'github');
assert.equal(config.owner, 'zhv77');
assert.equal(config.repo, 'Relay');
assert.ok(!config.token && !config.private, 'Public updates must not contain credentials');
require('./verify-release');
