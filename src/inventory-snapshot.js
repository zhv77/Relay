'use strict';

const fs = require('node:fs');
const { validEntry } = require('./inventory');

function normalize(value, at) {
  if (!value?.items || typeof value.items !== 'object' || Array.isArray(value.items)) return null;
  const items = Object.fromEntries(Object.entries(value.items).filter(([path, count]) => validEntry(path, count)));
  if (!Object.keys(items).length) return null;
  return { items, count: Object.keys(items).length, at: value.at || at || 0,
    pid: value.pid || null, source: value.source || 'saved scan',
    conflicts: value.conflicts || [], completeness: 'unverified' };
}

class InventorySnapshot {
  constructor(store, fallbackFiles = []) {
    this.store = store;
    const saved = store?.getMeta('inventory');
    this.best = normalize(saved?.value, saved?.at);
    this.restored = Boolean(this.best);
    for (const file of fallbackFiles) {
      try {
        const value = JSON.parse(fs.readFileSync(file, 'utf8'));
        const candidate = normalize(value.items ? value : { items: value, source: 'imported snapshot' }, fs.statSync(file).mtimeMs);
        if (candidate && (!this.best || candidate.at > this.best.at ||
            (candidate.at === this.best.at && candidate.count > this.best.count))) {
          this.best = candidate;
          this.restored = true;
          this.save();
        }
      } catch { /* optional local snapshots */ }
    }
  }
  save() {
    if (this.best) {
      this.store?.putMeta('inventory', this.best, this.best.at);
      this.store?.flush?.();
    }
  }
  update(scan) {
    const candidate = scan.ok ? normalize({ ...scan, source: 'memory scan' }, scan.at) : null;
    // Never combine scans into an invented account.
    const covers = candidate && (!this.best || Object.keys(this.best.items).every((key) => Object.hasOwn(candidate.items, key)));
    let adopted = false;
    if (candidate && (!this.best || covers)) {
      this.best = candidate;
      this.restored = false;
      adopted = true;
      this.save();
    }
    if (!this.best) return null;
    return { ...this.best, partial: true, completeness: 'unverified',
      stale: this.restored || !adopted, sawCount: scan.count || 0,
      latestConflicts: scan.conflicts?.length || 0, scanError: scan.ok ? null : scan.error };
  }
}

module.exports = { InventorySnapshot, normalize };
