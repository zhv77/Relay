'use strict';

// Intact stack records do not prove that a complete account was read.
const MAX_ENTRY = 4096;
const CHUNK_BYTES = 4 * 1024 * 1024;
const PAGE_BYTES = 4096;
const PATH = /^\/Lotus\/[A-Za-z0-9_./-]+$/;
const MARKERS = ['utf8', 'utf16le'].map((encoding) => ({
  encoding, bytes: Buffer.from('"ItemType"', encoding), width: encoding === 'utf16le' ? 2 : 1,
}));
const MASTERY_MARKERS = ['utf8', 'utf16le'].map((encoding) => ({
  encoding, bytes: Buffer.from('"PlayerLevel":', encoding), width: encoding === 'utf16le' ? 2 : 1,
}));

function balanced(text, start, limit = MAX_ENTRY) {
  let depth = 0, inString = false, escaped = false;
  for (let i = start; i < Math.min(text.length, start + limit); i++) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

function validEntry(path, count) {
  return typeof path === 'string' && PATH.test(path) && Number.isSafeInteger(count) && count >= 0;
}

function addEntry(into, conflicts, path, count) {
  if (!validEntry(path, count) || conflicts.has(path)) return;
  if (Object.hasOwn(into, path) && into[path] !== count) {
    // Copies in a heap have no ordering guarantee. Max is not "newest".
    delete into[path];
    conflicts.add(path);
  } else into[path] = count;
}

function entryAt(text, at, into, conflicts) {
  const floor = Math.max(0, at - MAX_ENTRY);
  let opening = at;
  while (opening > floor) {
    opening = text.lastIndexOf('{', opening - 1);
    if (opening < floor) break;
    const blob = balanced(text, opening);
    if (!blob) continue;
    try {
      const entry = JSON.parse(blob);
      if (!Object.hasOwn(entry, 'ItemType')) continue;
      addEntry(into, conflicts, entry.ItemType, entry.ItemCount);
      return;
    } catch { /* damaged record; try its parent */ }
  }
}

function entriesIn(text, into = {}, conflicts = new Set()) {
  let cursor = 0;
  while (true) {
    const at = text.indexOf('"ItemType"', cursor);
    if (at < 0) break;
    cursor = at + 10;
    entryAt(text, at, into, conflicts);
  }
  return into;
}

function entriesInBuffer(buffer, items, conflicts) {
  let hits = 0;
  for (const { encoding, bytes, width } of MARKERS) {
    let cursor = 0;
    while (true) {
      const at = buffer.indexOf(bytes, cursor);
      if (at < 0) break;
      cursor = at + bytes.length;
      hits++;
      // Decode only a hit's neighbourhood, never a multi-GB region.
      let start = Math.max(0, at - MAX_ENTRY * width);
      if (width === 2 && (at - start) % 2) start++;
      const end = Math.min(buffer.length, at + MAX_ENTRY * width);
      entryAt(buffer.subarray(start, end).toString(encoding), (at - start) / width, items, conflicts);
    }
  }
  return hits;
}

function masteryInBuffer(buffer, candidates = {}) {
  for (const { encoding, bytes, width } of MASTERY_MARKERS) {
    let cursor = 0;
    while (true) {
      const at = buffer.indexOf(bytes, cursor);
      if (at < 0) break;
      cursor = at + bytes.length;
      const text = buffer.subarray(at, Math.min(buffer.length, at + 96 * width)).toString(encoding);
      const match = text.match(/^"PlayerLevel":(\d+),"PlayerXp":(\d+)/);
      if (!match) continue;
      const rank = Number(match[1]), xp = Number(match[2]);
      if (!Number.isSafeInteger(rank) || rank < 0 || rank > 100 ||
          !Number.isSafeInteger(xp) || xp < 0) continue;
      const key = `${rank}:${xp}`;
      candidates[key] = (candidates[key] || 0) + 1;
    }
  }
  return candidates;
}

function makeTasks(regions, chunkBytes = CHUNK_BYTES) {
  const ranges = [];
  for (const region of regions) {
    const previous = ranges.at(-1);
    if (previous && previous.base + BigInt(previous.size) === region.base && previous.type === region.type) {
      previous.size += region.size;
    } else ranges.push({ ...region });
  }
  const tasks = [];
  const overlap = MAX_ENTRY * 2;
  for (const region of ranges) {
    for (let offset = 0; offset < region.size; offset += chunkBytes) {
      const size = Math.min(chunkBytes, region.size - offset);
      tasks.push({ base: region.base + BigInt(offset), size,
        readSize: Math.min(size + overlap, region.size - offset), type: region.type });
    }
  }
  return tasks;
}

function plan(pid) {
  const { Client, findPid } = require('./memory');
  pid = pid || findPid();
  if (!pid) return { ok: false, error: 'Warframe is not running', items: {} };
  const client = new Client(pid);
  try {
    const tasks = makeTasks(client.regions(Infinity));
    return { ok: true, pid, tasks, plannedBytes: tasks.reduce((n, task) => n + task.size, 0) };
  } finally { client.close(); }
}

function scanTasks(client, tasks) {
  const items = {}, conflicts = new Set(), hot = [], masteryCandidates = {};
  let scannedBytes = 0, unreadableBytes = 0;
  for (const task of tasks) {
    let offset = 0, tail = Buffer.alloc(0), hits = 0;
    while (offset < task.readSize) {
      const remaining = task.readSize - offset;
      let block = client.read(task.base + BigInt(offset), remaining);
      if (!block?.length && client.isAlive && !client.isAlive()) {
        throw new Error('Warframe closed during the inventory scan');
      }
      if (!block?.length && remaining > PAGE_BYTES) {
        block = client.read(task.base + BigInt(offset), Math.min(PAGE_BYTES, remaining));
      }
      if (!block?.length) {
        // One unreadable page must not discard the rest of an allocation.
        const skipped = Math.min(PAGE_BYTES, remaining);
        unreadableBytes += Math.min(skipped, Math.max(0, task.size - offset));
        offset += skipped;
        tail = Buffer.alloc(0);
        continue;
      }
      const joined = tail.length ? Buffer.concat([tail, block]) : block;
      hits += entriesInBuffer(joined, items, conflicts);
      masteryInBuffer(joined, masteryCandidates);
      scannedBytes += Math.min(block.length, Math.max(0, task.size - offset));
      offset += block.length;
      tail = Buffer.from(joined.subarray(-MAX_ENTRY * 2));
    }
    if (hits) hot.push(task.base.toString());
  }
  return { items, conflicts: [...conflicts], masteryCandidates, scannedBytes, unreadableBytes, hot };
}

function readTasks(pid, tasks) {
  const { Client } = require('./memory');
  const client = new Client(pid);
  try { return scanTasks(client, tasks); } finally { client.close(); }
}

function combine(results) {
  const items = {}, masteryCandidates = {}, conflicts = new Set(results.flatMap((r) => r.conflicts));
  for (const result of results) {
    for (const [path, count] of Object.entries(result.items)) addEntry(items, conflicts, path, count);
    for (const [key, count] of Object.entries(result.masteryCandidates || {})) {
      masteryCandidates[key] = (masteryCandidates[key] || 0) + count;
    }
  }
  const bestMastery = Object.entries(masteryCandidates).sort((a, b) => b[1] - a[1])[0];
  const mastery = bestMastery ? (() => {
    const [rank, xp] = bestMastery[0].split(':').map(Number);
    return { rank, xp };
  })() : null;
  return { items, count: Object.keys(items).length, conflicts: [...conflicts],
    mastery,
    scannedBytes: results.reduce((n, r) => n + r.scannedBytes, 0),
    unreadableBytes: results.reduce((n, r) => n + r.unreadableBytes, 0),
    hot: results.flatMap((r) => r.hot), completeness: 'unverified', partial: true };
}

// Synchronous diagnostic entry point; the app uses the persistent worker pool.
function read() {
  const started = Date.now();
  const prepared = plan();
  if (!prepared.ok) return prepared;
  return { ok: true, pid: prepared.pid, ...combine([readTasks(prepared.pid, prepared.tasks)]),
    plannedBytes: prepared.plannedBytes, tookMs: Date.now() - started, at: Date.now() };
}

module.exports = { read, plan, readTasks, scanTasks, makeTasks, combine, entriesIn,
  entriesInBuffer, masteryInBuffer, balanced, validEntry, MAX_ENTRY };
