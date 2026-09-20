'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
function logPath() {
  return process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Warframe', 'EE.log') : null;
}
const MARKERS = [/Hub\.lua: Inventory sync done/, /OnLoginComplete/];
const MAX_READ = 256 * 1024;

class GameLog extends EventEmitter {
  constructor(file = logPath(), { intervalMs = 100 } = {}) {
    super();
    Object.assign(this, { file, intervalMs, offset: 0, timer: null, watcher: null,
      identity: null, anchor: Buffer.alloc(0), remainder: '', lineMatched: false });
  }
  identify(stat) { return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`; }
  start() {
    if (!this.file || this.timer) return false;
    try {
      const stat = fs.statSync(this.file);
      this.identity = this.identify(stat);
      this.offset = stat.size; // Do not replay old login events.
      const fd = fs.openSync(this.file, 'r');
      try { this.remember(fd); } finally { fs.closeSync(fd); }
    } catch { this.offset = 0; }
    // File events for low latency; polling covers missed Windows notifications.
    try {
      this.watcher = fs.watch(path.dirname(this.file), () => this.check());
      this.watcher.on('error', () => { this.watcher?.close(); this.watcher = null; });
      this.watcher.unref();
    } catch { /* directory may not exist until first launch */ }
    this.timer = setInterval(() => this.check(), this.intervalMs);
    this.timer.unref();
    return true;
  }
  remember(fd) {
    const buffer = Buffer.alloc(Math.min(128, this.offset));
    const read = fs.readSync(fd, buffer, 0, buffer.length, this.offset - buffer.length);
    this.anchor = buffer.subarray(0, read);
  }
  check() {
    let fd;
    try {
      fd = fs.openSync(this.file, 'r');
      const stat = fs.fstatSync(fd), identity = this.identify(stat);
      let reset = identity !== this.identity || stat.size < this.offset;
      if (!reset && this.anchor.length) {
        const anchor = Buffer.alloc(this.anchor.length);
        const read = fs.readSync(fd, anchor, 0, anchor.length, this.offset - anchor.length);
        reset = read !== anchor.length || !anchor.equals(this.anchor);
      }
      if (reset) { this.offset = 0; this.remainder = ''; this.lineMatched = false; }
      this.identity = identity;
      if (stat.size <= this.offset) return;
      const buffer = Buffer.alloc(Math.min(MAX_READ, stat.size - this.offset));
      const read = fs.readSync(fd, buffer, 0, buffer.length, this.offset);
      this.offset += read;
      this.remember(fd);
      const lines = (this.remainder + buffer.subarray(0, read).toString('latin1')).split('\n');
      let notice = null;
      lines.forEach((line, i) => {
        if (!this.lineMatched && MARKERS.some((marker) => marker.test(line))) {
          notice = line.trim();
          this.lineMatched = true;
        }
        if (i < lines.length - 1) this.lineMatched = false;
      });
      this.remainder = lines.at(-1).slice(-8192);
      if (notice) this.emit('sync', notice);
    } catch { /* log absent or temporarily inaccessible */ }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.watcher?.close();
    this.timer = this.watcher = null;
  }
}
module.exports = { GameLog, logPath, MARKERS };
