'use strict';

// The local price cache.

const fs = require('node:fs');
const path = require('node:path');

const SAVE_EVERY_MS = 20_000;

class Store {
  constructor(dir) {
    this.file = path.join(dir, 'prices.json');
    this._books = new Map();
    this._stats = new Map();
    this.items = [];
    this.itemsAt = 0;
    this.meta = new Map();
    this.dirty = false;
    this.load();
    this.timer = setInterval(() => this.flush(), SAVE_EVERY_MS);
    // A save timer should not be a reason for the process to stay alive.
    if (this.timer.unref) this.timer.unref();
  }

  load() {
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.items = saved.items || [];
      this.itemsAt = saved.itemsAt || 0;
      for (const [slug, entry] of Object.entries(saved.books || {})) {
        this._books.set(slug, entry);
      }
      for (const [slug, entry] of Object.entries(saved.stats || {})) {
        this._stats.set(slug, entry);
      }
      for (const [key, entry] of Object.entries(saved.meta || {})) {
        this.meta.set(key, entry);
      }
    } catch {
      // No cache yet, or one written by a version that shaped it differently.
    }
  }

  flush() {
    if (!this.dirty) return;
    const payload = {
      items: this.items,
      itemsAt: this.itemsAt,
      books: Object.fromEntries(this._books),
      stats: Object.fromEntries(this._stats),
      meta: Object.fromEntries(this.meta),
    };
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const temporary = this.file + '.tmp';
      fs.writeFileSync(temporary, JSON.stringify(payload));
      fs.renameSync(temporary, this.file);
      this.dirty = false;
    } catch {
      // Out of disk, or the directory went away.
    }
  }

  putMeta(key, value, at = Date.now()) {
    this.meta.set(key, { value, at });
    this.dirty = true;
  }

  getMeta(key) {
    return this.meta.get(key) || null;
  }

  setItems(items) {
    this.items = items;
    this.itemsAt = Date.now();
    this.dirty = true;
  }

  putBook(slug, value, at = Date.now()) {
    this._books.set(slug, { value, at });
    this.dirty = true;
  }

  putStats(slug, value, at = Date.now()) {
    this._stats.set(slug, { value, at });
    this.dirty = true;
  }

  book(slug) {
    const entry = this._books.get(slug);
    return entry ? { ...entry.value, fetchedAt: entry.at } : null;
  }

  stats(slug) {
    const entry = this._stats.get(slug);
    return entry ? { ...entry.value, fetchedAt: entry.at } : null;
  }

  bookAge(slug) {
    const entry = this._books.get(slug);
    return entry ? Date.now() - entry.at : Infinity;
  }

  statsAge(slug) {
    const entry = this._stats.get(slug);
    return entry ? Date.now() - entry.at : Infinity;
  }

  // Seven-day volume, which is how the background sweep ranks its work.
  volume(slug) {
    return this._stats.get(slug)?.value?.volume7d ?? null;
  }

  close() {
    clearInterval(this.timer);
    this.flush();
  }
}

module.exports = { Store };
