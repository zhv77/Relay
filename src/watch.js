'use strict';

// Says when the main process stopped answering, and what it was doing.

const STEP_MS = 100;
const REPORT_MS = Number(process.env.WFT_WATCH_MS || 150);

let open = new Set();

// Wraps ipcMain.handle so every call is timed and named while it runs.
function watchIpc(ipcMain) {
  const original = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, handler) =>
    original(channel, async (...args) => {
      const started = Date.now();
      open.add(channel);
      try {
        return await handler(...args);
      } finally {
        open.delete(channel);
        const took = Date.now() - started;
        if (took >= REPORT_MS) console.log(`watch: ${channel} took ${took} ms`);
      }
    });
}

function watchLoop() {
  let last = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    const late = now - last - STEP_MS;
    last = now;
    if (late >= REPORT_MS) {
      const doing = open.size ? [...open].join(', ') : 'nothing on IPC';
      console.log(`watch: main thread blocked ${late} ms during ${doing}`);
    }
  }, STEP_MS);
  timer.unref();
}

function start(ipcMain) {
  if (!process.env.WFT_WATCH) return false;
  watchIpc(ipcMain);
  watchLoop();
  return true;
}

module.exports = { start };
