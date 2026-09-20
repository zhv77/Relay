'use strict';

const path = require('node:path');
const os = require('node:os');
const { Worker } = require('node:worker_threads');
const { combine } = require('./inventory');

class Scanner {
  constructor({ workers = Math.min(4, os.availableParallelism()), workerFactory } = {}) {
    this.workerCount = Math.max(1, workers);
    this.workerFactory = workerFactory || (() => new Worker(path.join(__dirname, 'inventory-worker.js')));
    this.workers = [];
    this.nextId = 1;
    this.inFlight = null;
    this.hot = new Set();
    this.lastPid = null;
  }

  ensure(index) {
    if (this.workers[index]) return this.workers[index];
    const worker = this.workerFactory();
    const slot = { worker, waiting: new Map() };
    this.workers[index] = slot;
    const fail = (error) => {
      for (const { reject } of slot.waiting.values()) reject(error);
      slot.waiting.clear();
      if (this.workers[index] === slot) this.workers[index] = null;
    };
    worker.on('message', (message) => {
      const waiting = slot.waiting.get(message.id);
      if (!waiting) return;
      slot.waiting.delete(message.id);
      if (!slot.waiting.size) worker.unref();
      if (message.error) waiting.reject(new Error(message.error));
      else waiting.resolve(message.result);
    });
    worker.on('error', fail);
    worker.on('exit', (code) => fail(new Error(`Inventory worker exited (${code})`)));
    worker.unref();
    return slot;
  }

  request(index, payload) {
    const slot = this.ensure(index), id = this.nextId++;
    return new Promise((resolve, reject) => {
      slot.waiting.set(id, { resolve, reject });
      slot.worker.ref();
      try { slot.worker.postMessage({ id, ...payload }); }
      catch (error) {
        slot.waiting.delete(id);
        if (!slot.waiting.size) slot.worker.unref();
        reject(error);
      }
    });
  }

  warm() {
    for (let i = 0; i <= this.workerCount; i++) this.ensure(i);
  }

  pid() { return this.request(0, { op: 'pid' }).then((r) => r.pid); }

  scan() {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.run().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  async run() {
    this.warm();
    const started = Date.now();
    const prepared = await this.request(0, { op: 'plan' });
    if (!prepared.ok) return prepared;
    if (prepared.pid !== this.lastPid) this.hot.clear();
    this.lastPid = prepared.pid;
    const priority = (task) => this.hot.has(task.base.toString()) ? 0 : task.type === 0x20000 ? 1 : 2;
    prepared.tasks.sort((a, b) => priority(a) - priority(b));
    const batches = Array.from({ length: this.workerCount }, () => []);
    prepared.tasks.forEach((task, i) => batches[i % batches.length].push(task));
    // Settle all workers before accepting another scan, including on failure.
    const settled = await Promise.allSettled(batches.map((tasks, i) =>
      this.request(i + 1, { op: 'scan', pid: prepared.pid, tasks })));
    const failed = settled.find((r) => r.status === 'rejected');
    if (failed) throw failed.reason;
    const result = combine(settled.map((r) => r.value));
    this.hot = new Set(result.hot);
    const { hot, ...summary } = result;
    return { ok: true, pid: prepared.pid, ...summary, plannedBytes: prepared.plannedBytes,
      workers: this.workerCount, tookMs: Date.now() - started, at: Date.now() };
  }

  stop() {
    for (const slot of this.workers) {
      if (!slot) continue;
      for (const { reject } of slot.waiting.values()) reject(new Error('Inventory scanner stopped'));
      slot.waiting.clear();
      slot.worker.terminate();
    }
    this.workers = [];
    this.hot.clear();
  }
}

const scanner = new Scanner();
module.exports = { Scanner, scan: () => scanner.scan(), pid: () => scanner.pid(),
  warm: () => scanner.warm(), stop: () => scanner.stop() };
