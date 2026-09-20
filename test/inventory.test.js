'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const inventory = require('../src/inventory');
const { InventorySnapshot } = require('../src/inventory-snapshot');
const { GameLog } = require('../src/eelog');
const { Scanner } = require('../src/scanner');
const A = '/Lotus/Types/Items/MiscItems/Ferrite', B = '/Lotus/Test/B';
const record = (count = 7, name = A) => JSON.stringify({ ItemCount: count, LastAdded: { $oid: 'fixture' }, ItemType: name });
const makeStore = (value) => ({
  saved: value ? { value, at: value.at } : null,
  getMeta() { return this.saved; },
  putMeta(key, value, at) { this.saved = { value: structuredClone(value), at }; },
});
function temp(t) {
  const root = path.resolve(__dirname, '../scratch');
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'inventory-test-'));
  t.after(() => {
    assert.ok(path.resolve(dir).startsWith(root + path.sep));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test('nested metadata, whitespace, isolated objects, and changed key order', () => {
  const result = {};
  inventory.entriesIn('garbage\0' + record() + '\0' + JSON.stringify({ ItemType: B, ItemCount: 0 }, null, '\t'), result);
  assert.deepEqual(result, { [A]: 7, [B]: 0 });
});
test('reject damaged, negative, fractional, unsafe and non-Lotus records', () => {
  const result = {};
  inventory.entriesIn([record(-1), record(1.5), record(2 ** 54), record(5, A + '\u000f'), record(5, '/Other/Item'), record().slice(0, -2)].join(','), result);
  assert.deepEqual(result, {});
});
test('duplicate copies do not add up; contradictory copies are excluded', () => {
  const result = {}, conflicts = new Set();
  inventory.entriesIn([record(7), record(7), record(6), record(7)].join(','), result, conflicts);
  assert.deepEqual(result, {});
  assert.deepEqual([...conflicts], [A]);
});
test('UTF-16 records at odd byte offsets and UTF-8 records', () => {
  const items = {}, conflicts = new Set();
  const buffer = Buffer.concat([Buffer.from([0]), Buffer.from(record(), 'utf16le'), Buffer.from('\0' + record(9, B))]);
  inventory.entriesInBuffer(buffer, items, conflicts);
  assert.deepEqual(items, { [A]: 7, [B]: 9 });
});
test('records spanning chunks and adjacent memory regions survive', () => {
  const buffer = Buffer.from('x'.repeat(220) + record() + '\0'.repeat(300));
  const tasks = inventory.makeTasks([{ base: 0n, size: 250, type: 1 }, { base: 250n, size: buffer.length - 250, type: 1 }], 256);
  const result = inventory.scanTasks({ read: (base, size) => buffer.subarray(Number(base), Number(base) + size) }, tasks);
  assert.equal(result.items[A], 7);
  assert.equal(result.scannedBytes, buffer.length);
});
test('a partial read retains its prefix and retries the remainder', () => {
  const buffer = Buffer.from(record());
  let first = true;
  const result = inventory.scanTasks({ read(base, size) {
    if (first) { first = false; return buffer.subarray(0, 30); }
    return buffer.subarray(Number(base), Number(base) + size);
  } }, [{ base: 0n, size: buffer.length, readSize: buffer.length }]);
  assert.equal(result.items[A], 7);
  assert.equal(result.scannedBytes, buffer.length);
});
test('unreadable pages do not hide subsequent readable records or stitch across holes', () => {
  const buffer = Buffer.alloc(3 * 4096);
  buffer.write(record(9, B), 8192);
  const result = inventory.scanTasks({ read(base, size) {
    const offset = Number(base);
    if (offset < 4096) return buffer.subarray(offset, Math.min(4096, offset + size));
    if (offset < 8192) return null;
    return buffer.subarray(offset, offset + size);
  } }, [{ base: 0n, size: buffer.length, readSize: buffer.length }]);
  assert.equal(result.items[B], 9);
  assert.equal(result.unreadableBytes, 4096);
  assert.equal(result.scannedBytes, 8192);
});
test('large allocations are split, not dropped', () => {
  const tasks = inventory.makeTasks([{ base: 0n, size: 3 * 1024 ** 3, type: 1 }]);
  assert.equal(tasks.reduce((n, task) => n + task.size, 0), 3 * 1024 ** 3);
  assert.ok(tasks.every((task) => task.readSize <= 4 * 1024 ** 2 + 8192));
});
test('worker results remain incomplete; cross-worker conflicts are excluded', () => {
  const base = { conflicts: [], scannedBytes: 1, unreadableBytes: 0, hot: [] };
  const result = inventory.combine([{ ...base, items: { [A]: 9 } }, { ...base, items: { [A]: 8, [B]: 1 } }]);
  assert.deepEqual(result.items, { [B]: 1 });
  assert.deepEqual(result.conflicts, [A]);
  assert.equal(result.partial, true);
});

test('snapshot collapse keeps original capture time; quantities can decrease', () => {
  const store = makeStore(), snapshots = new InventorySnapshot(store);
  const initial = snapshots.update({ ok: true, items: { [A]: 9, [B]: 1 }, at: 100, pid: 1 });
  assert.equal(initial.partial, true);
  const collapsed = snapshots.update({ ok: true, items: { [A]: 8 }, at: 200, pid: 1 });
  assert.equal(collapsed.at, 100);
  assert.equal(collapsed.stale, true);
  const decreased = snapshots.update({ ok: true, items: { [A]: 2, [B]: 0 }, at: 300, pid: 1 });
  assert.deepEqual(decreased.items, { [A]: 2, [B]: 0 });
  assert.equal(store.saved.at, 300);
  assert.equal(decreased.partial, true);
});
test('offline and restarted app keep saved rows with their original age', () => {
  const snapshots = new InventorySnapshot(makeStore({ items: { [A]: 1 }, at: 100 }));
  const result = snapshots.update({ ok: false, error: 'Warframe is not running' });
  assert.equal(result.at, 100);
  assert.equal(result.stale, true);
  assert.equal(result.items[A], 1);
  assert.equal(result.scanError, 'Warframe is not running');
});
test('old local dump imports as incomplete, with invalid records excluded', (t) => {
  const file = path.join(temp(t), 'entries.json');
  fs.writeFileSync(file, JSON.stringify({ [A]: 7, [B]: -3 }));
  const snapshots = new InventorySnapshot(makeStore(), [file]);
  const result = snapshots.update({ ok: true, items: {} });
  assert.equal(result.count, 1);
  assert.equal(result.stale, true);
  assert.equal(result.source, 'imported snapshot');
});

test('a newer saved login capture wins over a larger old dump', (t) => {
  const dir = temp(t), capture = path.join(dir, 'capture.json'), old = path.join(dir, 'entries.json');
  fs.writeFileSync(capture, JSON.stringify({ items: { [A]: 2 }, at: 3000 }));
  fs.writeFileSync(old, JSON.stringify({ items: { [A]: 9, [B]: 8 }, at: 1000 }));
  const store = makeStore({ items: { [A]: 7, [B]: 6 }, at: 2000 });
  const snapshots = new InventorySnapshot(store, [capture, old]);
  const result = snapshots.update({ ok: true, items: {} });
  assert.deepEqual(result.items, { [A]: 2 });
  assert.equal(result.at, 3000);
  assert.equal(result.stale, true);
});

test('a closed game aborts instead of retrying gigabytes of dead pages', () => {
  let reads = 0;
  assert.throws(() => inventory.scanTasks({ read() { reads++; return null; }, isAlive: () => false },
    [{ base: 0n, size: 3 * 1024 ** 3, readSize: 3 * 1024 ** 3 }]), /closed/);
  assert.equal(reads, 1);
});

test('log watcher ignores history and joins split writes without duplicate notices', (t) => {
  const file = path.join(temp(t), 'EE.log');
  fs.writeFileSync(file, 'old Hub.lua: Inventory sync done\n');
  const log = new GameLog(file, { intervalMs: 60_000 });
  t.after(() => log.stop());
  const notices = [];
  log.on('sync', (line) => notices.push(line));
  log.start();
  log.check();
  assert.equal(notices.length, 0);
  fs.appendFileSync(file, 'new Hub.lua: Inven'); log.check();
  fs.appendFileSync(file, 'tory sync done'); log.check();
  assert.equal(notices.length, 1);
  fs.appendFileSync(file, '\n'); log.check();
  assert.equal(notices.length, 1);
});
test('log watcher detects truncate-and-regrow past the previous offset', (t) => {
  const file = path.join(temp(t), 'EE.log');
  fs.writeFileSync(file, 'old log contents'.repeat(20));
  const log = new GameLog(file, { intervalMs: 60_000 });
  t.after(() => log.stop());
  let notices = 0;
  log.on('sync', () => notices++); log.start();
  fs.writeFileSync(file, 'Hub.lua: Inventory sync done\n' + 'new log\n'.repeat(100));
  log.check();
  assert.equal(notices, 1);
});

class FakeWorker extends EventEmitter {
  constructor(reply) { super(); this.reply = reply; this.requests = []; }
  ref() {} unref() {}
  postMessage(message) { this.requests.push(message); setImmediate(() => this.reply(this, message)); }
  terminate() { setImmediate(() => this.emit('exit', 0)); }
}
test('concurrent callers share a scan, and workers are reused', async () => {
  const made = [];
  const scanner = new Scanner({ workers: 2, workerFactory: () => {
    const worker = new FakeWorker((worker, request) => {
      const result = request.op === 'plan'
        ? { ok: true, pid: 1, tasks: [{ base: 0n, size: 1 }, { base: 1n, size: 1 }], plannedBytes: 2 }
        : { items: { [A]: 3 }, conflicts: [], scannedBytes: 1, unreadableBytes: 0, hot: ['0'] };
      worker.emit('message', { id: request.id, result });
    });
    made.push(worker); return worker;
  } });
  try {
    const first = scanner.scan();
    assert.equal(first, scanner.scan());
    assert.equal((await first).items[A], 3);
    await scanner.scan();
    assert.equal(made.length, 3);
    assert.equal(made[0].requests.length, 2);
  } finally { scanner.stop(); }
});
test('clean worker exit rejects pending calls and allows replacement', async () => {
  let calls = 0;
  const scanner = new Scanner({ workers: 1, workerFactory: () => new FakeWorker((worker, request) => {
    if (++calls === 1) worker.emit('exit', 0);
    else worker.emit('message', { id: request.id, result: { pid: 123 } });
  }) });
  try {
    await assert.rejects(scanner.pid(), /exited/);
    assert.equal(await scanner.pid(), 123);
  } finally { scanner.stop(); }
});
test('stopping rejects pending worker requests', async () => {
  const scanner = new Scanner({ workerFactory: () => new FakeWorker(() => {}) });
  const pending = scanner.pid();
  scanner.stop();
  await assert.rejects(pending, /stopped/);
});

test('inventory uncertainty is preserved while set planning treats undetected parts as missing', () => {
  const store = { items: [
    { slug: 'test_set', tags: ['set'], name: 'Test Set' },
    { slug: 'test_a', name: 'Test A' }, { slug: 'test_b', name: 'Test B' },
  ], book: () => ({ sellOnline: { platinum: 10 } }), stats: () => ({ median7d: 50, volume7d: 20 }) };
  const sets = require('../src/sets');
  sets.attach(store);
  const row = sets.build({ owned: { test_a: 2 }, partial: true }).rows[0];
  assert.equal(row.held, 1);
  assert.equal(row.parts[1].owned, null);
  assert.equal(row.missingCount, 1);
  assert.equal(row.toFinish, 10);
  assert.equal(row.profitToFinish, 40);
  assert.equal(sets.build({ pending: true }).rows[0].toFinish, null);
  const relics = require('../src/relics');
  relics.attach(store, null, { relics: [{ name: 'Lith Test', paths: { Intact: A, Radiant: B }, rewards: [] }] });
  const relic = relics.build({ paths: { [A]: 2 }, partial: true }).rows[0];
  assert.equal(relic.held, 2);
  assert.equal(relic.owned.Radiant, null);
  assert.equal(relic.unknown, true);
});

test('failed persistence remains dirty and succeeds on retry', (t) => {
  const { Store } = require('../src/store');
  const dir = temp(t), store = new Store(dir);
  t.after(() => store.close());
  const original = store.file;
  const blocked = path.join(dir, 'not-a-directory');
  fs.writeFileSync(blocked, 'fixture');
  store.file = path.join(blocked, 'prices.json');
  store.putMeta('inventory', { items: { [A]: 1 } }, 100);
  store.flush();
  assert.equal(store.dirty, true);
  store.file = original;
  store.flush();
  assert.equal(store.dirty, false);
  assert.equal(JSON.parse(fs.readFileSync(original)).meta.inventory.at, 100);
});

test('Windows reader reads and enumerates a fixture in its own process', { skip: process.platform !== 'win32' }, () => {
  const koffi = require('koffi');
  const { Client, findPid } = require('../src/memory');
  const buffer = Buffer.from(record());
  const pointer = koffi.alloc('uint8', buffer.length);
  const client = new Client(process.pid);
  try {
    // Only the test's own allocation is populated; the game is untouched.
    koffi.encode(pointer, koffi.array('uint8', buffer.length), [...buffer]);
    const base = koffi.address(pointer);
    assert.deepEqual(client.read(base, buffer.length), buffer);
    assert.ok([...client.regions(Infinity)].some((r) => r.base <= base && r.base + BigInt(r.size) > base));
    const pid = findPid();
    assert.ok(pid === null || Number.isSafeInteger(pid));
  } finally { client.close(); koffi.free(pointer); }
});
