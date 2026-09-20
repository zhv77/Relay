'use strict';

// Same reader as the app.
const fs = require('node:fs');
const path = require('node:path');
const { Scanner } = require('./scanner');
const { GameLog } = require('./eelog');
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
};
const scanner = new Scanner({ workers: Number(option('--workers', 4)) });
const watching = args.includes('--watch');
const output = path.resolve(option('--out', 'probe/dumps/capture.json'));
const seconds = Number(option('--seconds', 600));
let best = null, busy = false, stopped = false, huntUntil = 0, lastPid = null, queued = false;
let log, timer, finishTimer;

function stop() {
  if (stopped) return;
  stopped = true;
  clearInterval(timer);
  clearTimeout(finishTimer);
  log?.stop();
  scanner.stop();
}

async function capture(reason) {
  if (stopped) return;
  if (busy) { if (reason === 'sync') queued = true; return; }
  busy = true;
  try {
    const result = await scanner.scan();
    const { items, conflicts, ...summary } = result;
    console.log(JSON.stringify({ ...summary, conflicts: conflicts?.length || 0, reason }));
    if (result.ok && result.count && (!best || result.count > best.count ||
        Object.keys(best.items).every((key) => Object.hasOwn(items, key)))) {
      best = { ...result, source: 'memory scan' };
      if (watching) {
        fs.mkdirSync(path.dirname(output), { recursive: true });
        fs.writeFileSync(output + '.tmp', JSON.stringify(best));
        fs.renameSync(output + '.tmp', output);
      }
    }
    if (!watching && result.ok) {
      const filter = args.find((arg) => !arg.startsWith('--') && !['--workers', '--seconds', '--out'].some((key) => option(key) === arg)) || '';
      for (const [name, count] of Object.entries(items).filter(([name]) => name.toLowerCase().includes(filter.toLowerCase())).slice(0, 20)) {
        console.log(`${count} ${name}`);
      }
    }
    if (!result.ok && !watching) process.exitCode = 1;
  } catch (error) {
    if (!stopped) console.error(error.message);
    if (!watching) process.exitCode = 1;
  } finally {
    busy = false;
    if (queued && !stopped) { queued = false; capture('after sync'); }
  }
}

async function main() {
  scanner.warm();
  if (!watching) { try { await capture('manual'); } finally { stop(); } return; }
  try { best = JSON.parse(fs.readFileSync(output, 'utf8')); } catch { /* first capture */ }
  log = new GameLog();
  log.on('sync', () => { huntUntil = Date.now() + 30_000; capture('sync'); });
  log.start();
  let checking = false;
  timer = setInterval(async () => {
    if (checking || stopped) return;
    checking = true;
    try {
      const pid = await scanner.pid();
      if (pid !== lastPid) {
        lastPid = pid;
        if (pid) { huntUntil = Date.now() + 60_000; capture('game started'); }
      }
      if (pid && Date.now() < huntUntil) capture('capture window');
    } catch (error) { if (!stopped) console.error(error.message); }
    finally { checking = false; }
  }, 200);
  finishTimer = setTimeout(stop, seconds * 1000);
  process.once('SIGINT', stop);
  console.log(`Inventory watcher ready for ${seconds}s. Waiting for launch/login; output: ${output}`);
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; stop(); });
