'use strict';

// Keep update decisions in the main process; the renderer cannot supply URLs.
function createUpdates(updater, { enabled, version, changed = () => {} }) {
  let state = { status: enabled ? 'idle' : 'disabled', currentVersion: version };
  let busy = false;
  const set = (status, extra = {}) => { state = { currentVersion: version, status, ...extra }; changed(state); };
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;
  updater.on('update-available', info => set('available', { version: info.version }));
  updater.on('update-not-available', () => set('current'));
  updater.on('download-progress', progress => set('downloading', { percent: Math.floor(progress.percent) }));
  updater.on('update-downloaded', info => set('ready', { version: info.version }));
  updater.on('error', () => {
    if (state.status === 'installing') busy = false;
    set('error');
  });
  async function act() {
    if (!enabled || busy) return state;
    if (state.status === 'ready') {
      busy = true;
      set('installing');
      try { updater.quitAndInstall(true, true); } catch { busy = false; set('error'); }
      return state;
    }
    busy = true;
    try {
      if (state.status !== 'available') {
        set('checking');
        await updater.checkForUpdates();
      }
      if (state.status === 'available') {
        set('downloading', { percent: 0 });
        await updater.downloadUpdate();
      }
    } catch { set('error'); }
    finally { busy = false; }
    return state;
  }
  const check = () => ['idle', 'current', 'error'].includes(state.status) ? act() : Promise.resolve(state);
  return { state: () => state, act, check };
}
module.exports = { createUpdates };
