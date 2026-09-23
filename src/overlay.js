'use strict';

// In-game overlay: reads the riven cycle screen from screenshots and shows prices beside it.

const fs = require('node:fs');
const path = require('node:path');
const koffi = require('koffi');
const { app, BrowserWindow, desktopCapturer, nativeImage, screen } = require('electron');
const rivens = require('./rivens');

const user32 = koffi.load('user32.dll');
const RECT = koffi.struct('OVERLAY_RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
const POINT = koffi.struct('OVERLAY_POINT', { x: 'int32', y: 'int32' });
const GetForegroundWindow = user32.func('void* __stdcall GetForegroundWindow()');
const GetWindowThreadProcessId = user32.func('uint32 __stdcall GetWindowThreadProcessId(void* window, _Out_ uint32* pid)');
const GetClientRect = user32.func('bool __stdcall GetClientRect(void* window, _Out_ OVERLAY_RECT* rect)');
const ClientToScreen = user32.func('bool __stdcall ClientToScreen(void* window, _Inout_ OVERLAY_POINT* point)');
const WindowFromPoint = user32.func('void* __stdcall WindowFromPoint(OVERLAY_POINT point)');
const GetAncestor = user32.func('void* __stdcall GetAncestor(void* window, uint32 flags)');
const IsWindow = user32.func('bool __stdcall IsWindow(void* window)');
const IsIconic = user32.func('bool __stdcall IsIconic(void* window)');
const GA_ROOT = 2;
const kernel32 = koffi.load('kernel32.dll');
const OpenProcess = kernel32.func('void* __stdcall OpenProcess(uint32 access, bool inherit, uint32 pid)');
const CloseHandle = kernel32.func('bool __stdcall CloseHandle(void* handle)');
const QueryFullProcessImageNameW = kernel32.func('bool __stdcall QueryFullProcessImageNameW(void* process, uint32 flags, _Out_ uint16* name, _Inout_ uint32* size)');
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

const INTERVAL_MS = 1500;
// Visibility is checked more often, so the panels leave quickly when something covers the game.
const VISIBILITY_MS = 250;
const KEEP = 5;
// Frames without a riven before the panel hides, so one misread does not blink it away.
const MISSES_TO_HIDE = 2;
// Summary in the empty space left of the riven cards, trait table on the right, on a 1920x1080 game.
const PANELS = {
  summary: { at: { x: 60, y: 150 }, width: 400, height: 900 },
  traits: { at: { x: 1470, y: 92 }, width: 440, height: 980 },
};

// Regions on a 1920x1080 riven cycle screen, scaled from the centre for other sizes.
const CYCLE_BUTTON = { x: 800, y: 943, width: 320, height: 38 };
const RIVEN_CARD = { x: 830, y: 705, width: 265, height: 120 };
// After a cycle the old riven sits to the left, smaller.
const PREVIOUS_CARD = { x: 492, y: 700, width: 226, height: 92 };
// The weapon under "Fits in", which decides the disposition for variants like Kuva Ogris.
const FITS_IN = { x: 1630, y: 915, width: 195, height: 35 };

// Points beside each panel and the game's centre, on a 1920x1080 game. They sit outside the panels so the
// check sees what is under the overlay rather than the overlay itself.
const PROBES = [{ x: 30, y: 300 }, { x: 960, y: 540 }, { x: 1440, y: 300 }];

// Windows' screenshot tools put a full-screen layer over the game; the overlay should stay in the shot.
const CAPTURE_TOOLS = new Set(['snippingtool.exe', 'screenclippinghost.exe', 'screensketch.exe']);

// Executable name for a process id, cached since the same few windows are asked about all the time.
const names = new Map();
function processName(id) {
  if (names.has(id)) return names.get(id);
  let name = null;
  const handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, id);
  if (handle) {
    try {
      const buffer = new Uint16Array(260);
      const size = [buffer.length];
      if (QueryFullProcessImageNameW(handle, 0, buffer, size)) {
        name = String.fromCharCode(...buffer.subarray(0, size[0])).split('\\').pop().toLowerCase();
      }
    } finally { CloseHandle(handle); }
  }
  if (names.size > 200) names.clear();
  names.set(id, name);
  return name;
}

const ownerOf = (window) => {
  const owner = [0];
  GetWindowThreadProcessId(window, owner);
  return owner[0];
};

// The game's window: the foreground one when it is the game, else the last one seen, unless closed or minimized.
let lastGame = null;
function gameWindow(pid) {
  if (!pid) return null;
  const front = GetForegroundWindow();
  const window = front && ownerOf(front) === pid ? front
    : lastGame && IsWindow(lastGame) && !IsIconic(lastGame) && ownerOf(lastGame) === pid ? lastGame : null;
  if (!window) return null;
  lastGame = window;
  return describe(window);
}

// Client area in physical pixels.
function describe(window) {
  const rect = {};
  const origin = { x: 0, y: 0 };
  if (!GetClientRect(window, rect) || !ClientToScreen(window, origin)) return null;
  const width = rect.right - rect.left;
  const height = rect.bottom - rect.top;
  if (width <= 0 || height <= 0) return null;
  return { id: `window:${koffi.address(window)}:`, rect: { x: origin.x, y: origin.y, width, height } };
}

// Whether the game shows at every probe point, so a window on another monitor does not hide the overlay.
// A screenshot tool's layer counts as the game.
function unobscured(game, pid) {
  const { x, y, width, height } = game.rect;
  const scale = height / 1080;
  return PROBES.every((probe) => {
    const point = { x: Math.round(x + width / 2 + (probe.x - 960) * scale), y: Math.round(y + probe.y * scale) };
    const hit = WindowFromPoint(point);
    if (!hit) return false;
    const owner = ownerOf(GetAncestor(hit, GA_ROOT) || hit);
    return owner === pid || CAPTURE_TOOLS.has(processName(owner));
  });
}

// Captures the game window itself, so the overlay and other windows never show up.
async function capture(game) {
  const { width, height } = game.rect;
  const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width, height } });
  const source = sources.find((s) => s.id.startsWith(game.id));
  if (!source || source.thumbnail.isEmpty()) throw new Error('Game window not capturable');
  return source.thumbnail;
}

function region(image, area) {
  const { width, height } = image.getSize();
  const scale = height / 1080;
  return image.crop({
    x: Math.round(width / 2 + (area.x - 960) * scale), y: Math.round(area.y * scale),
    width: Math.round(area.width * scale), height: Math.round(area.height * scale),
  });
}

// Upscaled black-on-white copy; OCR misreads the small light-on-dark card text otherwise.
function clean(image) {
  const big = image.resize({ width: image.getSize().width * 3, quality: 'best' });
  const pixels = big.toBitmap();
  const gray = new Uint8Array(pixels.length / 4);
  for (let i = 0; i < gray.length; i++) gray[i] = Math.max(pixels[i * 4], pixels[i * 4 + 1], pixels[i * 4 + 2]);
  const cut = otsu(gray);
  for (let i = 0; i < gray.length; i++) {
    pixels.fill(gray[i] > cut ? 0 : 255, i * 4, i * 4 + 3);
    pixels[i * 4 + 3] = 255;
  }
  return nativeImage.createFromBitmap(pixels, big.getSize());
}

// Brightness that best splits text from background.
function otsu(gray) {
  const counts = new Array(256).fill(0);
  for (const v of gray) counts[v]++;
  let total = 0;
  for (let v = 0; v < 256; v++) total += v * counts[v];
  let below = 0, belowSum = 0, best = 0, cut = 128;
  for (let v = 0; v < 256; v++) {
    below += counts[v];
    belowSum += v * counts[v];
    const above = gray.length - below;
    if (!below || !above) continue;
    const spread = below * above * (belowSum / below - (total - belowSum) / above) ** 2;
    if (spread > best) { best = spread; cut = v; }
  }
  return cut;
}

let reader = null;
async function read(image) {
  reader ||= (async () => {
    const worker = await require('tesseract.js').createWorker('eng', 1, { cachePath: path.join(app.getPath('userData'), 'ocr') });
    await worker.setParameters({ tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+-.% ' });
    return worker;
  })();
  const { data } = await (await reader).recognize(clean(image).toPNG());
  return data.text;
}

// "+125.3% Damage", with whatever OCR made of a lock icon in front.
const STAT = /^(.*?)([+\-xX])?(\d+(?:\.\d+)?)(%?)\s+([A-Za-z][A-Za-z ]*[A-Za-z])/;

// Name and stats from a card; wrapped stat lines are joined back up.
function card(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const first = lines.findIndex((l) => STAT.test(l));
  if (first < 0) return { name: '?', stats: [] };
  const stats = [];
  for (const line of lines.slice(first)) {
    const m = line.match(STAT);
    if (m) {
      const name = m[5].replace(/(\s+\S)+$/, '').trim();
      // Faction damage is always a multiplier, and its "x" is the sign OCR drops most.
      const sign = /damage to/i.test(name) ? 'x' : (m[2] || '?');
      // Lock icons read as a digit just before the sign.
      stats.push({ text: `${sign}${m[3]}${m[4]} ${name}`, locked: /\d\s*$/.test(m[1]) });
    } else if (stats.length) {
      // A wrapped stat's second line, minus the lock icon OCR reads as stray characters around it.
      const words = line.split(/\s+/).filter((w) => /^[A-Z][a-z]{2,}$/.test(w));
      if (words.length) stats[stats.length - 1].text += ' ' + words.slice(0, 2).join(' ');
    }
  }
  // Card art bleeds into the top of the region, so the name is the line just above the stats.
  return { name: lines[first - 1] || '?', stats };
}

// The riven on the cycle screen, plus the previous one while choosing after a cycle.
async function riven(image) {
  const button = await read(region(image, CYCLE_BUTTON));
  const choosing = /confirm/i.test(button);
  if (!choosing && !/cycle\s*for/i.test(button)) return null;
  const current = card(await read(region(image, RIVEN_CARD)));
  if (!current.stats.length) return null;
  current.fitsIn = (await read(region(image, FITS_IN))).trim();
  // "CYCLE FOR -.3.500" is 3,500 Kuva; the Kuva icon reads as stray punctuation.
  const cost = Number(button.replace(/^.*?for/i, '').replace(/\D/g, ''));
  if (cost >= 900 && cost <= 7000) current.cost = cost;
  if (choosing) current.previous = { ...card(await read(region(image, PREVIOUS_CARD))), fitsIn: current.fitsIn };
  return current;
}

// A reading OCR fully made sense of.
function readable(reading) {
  return Boolean(reading) && reading.name !== '?' && reading.stats.length >= 2 && reading.stats.every((s) => !s.text.startsWith('?'));
}

// Keeps the last clean reading of the same riven when a frame is misread.
function steady(last, next) {
  if (readable(next)) return next;
  return last && (next.name === last.name || next.name === '?') ? last : null;
}

function createPanel(name) {
  const { width, height } = PANELS[name];
  const panel = new BrowserWindow({
    width, height, show: false, frame: false, transparent: true, resizable: false,
    focusable: false, skipTaskbar: true, hasShadow: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  panel.setAlwaysOnTop(true, 'screen-saver');
  panel.setIgnoreMouseEvents(true);
  panel.loadFile(path.join(__dirname, '..', 'renderer', 'overlay.html'), { query: { panel: name } });
  return panel;
}

// With debug on, recent screenshots are kept in the folder for tuning.
function start({ pid, folder, debug }) {
  if (debug) fs.mkdirSync(folder, { recursive: true });
  const panels = Object.fromEntries(Object.keys(PANELS).map((name) => [name, createPanel(name)]));
  const each = (fn) => Object.entries(panels).forEach(([name, panel]) => !panel.isDestroyed() && fn(panel, name));
  const hide = () => each((panel) => panel.isVisible() && panel.hide());
  let shown = null;
  let misses = 0;
  let busy = false;
  let gamePid = null;

  // Reads the screen while the game is visible, even when another window has focus.
  async function tick() {
    if (busy) return;
    busy = true;
    try {
      gamePid = await pid();
      const game = gameWindow(gamePid);
      if (!game || !unobscured(game, gamePid)) return;
      const started = Date.now();
      const image = await capture(game);
      const found = await riven(image);
      if (found) {
        misses = 0;
        const current = steady(shown?.current, found);
        const previous = found.previous ? steady(shown?.previous, found.previous) : null;
        if (current) {
          // The choice screen hides the cost, so the last one seen stands in.
          current.cost ??= shown?.current?.cost;
          for (const reading of [current, previous].filter(Boolean)) {
            reading.analysis ||= await rivens.analyse(reading).catch((error) => ({ error: error.message }));
          }
          shown = { current, previous };
          each((panel) => panel.webContents.send('overlay:state', shown));
        }
      } else if (++misses >= MISSES_TO_HIDE) {
        shown = null;
      }
      if (debug) await keep(folder, started, image.toPNG(), found);
      place();
    } catch (error) {
      if (debug) console.log(`overlay: ${error.message}`);
    } finally {
      busy = false;
    }
  }

  // Shows the panels over the game while a riven is on screen and nothing covers the game.
  function place() {
    const game = shown && gameWindow(gamePid);
    if (!game || !unobscured(game, gamePid)) return hide();
    const dip = screen.screenToDipRect(null, game.rect);
    const scale = dip.height / 1080;
    each((panel, name) => {
      const { at } = PANELS[name];
      panel.setPosition(Math.round(dip.x + dip.width / 2 + (at.x - 960) * scale), Math.round(dip.y + at.y * scale));
      if (!panel.isVisible()) panel.showInactive();
    });
  }

  const timer = setInterval(tick, INTERVAL_MS);
  const watcher = setInterval(() => {
    try { place(); } catch (error) { if (debug) console.log(`overlay: ${error.message}`); }
  }, VISIBILITY_MS);
  return {
    stop() {
      clearInterval(timer);
      clearInterval(watcher);
      each((panel) => panel.destroy());
      reader?.then((worker) => worker.terminate()).catch(() => {});
      reader = null;
    },
  };
}

// Rolling screenshots, with riven screens kept apart so samples survive.
async function keep(folder, at, png, found) {
  await fs.promises.writeFile(path.join(folder, `shot-${at}.png`), png);
  prune(folder, 'shot');
  if (!found) return;
  await fs.promises.writeFile(path.join(folder, `riven-${at}.png`), png);
  prune(folder, 'riven');
}

function prune(folder, prefix) {
  const shots = fs.readdirSync(folder).filter((f) => f.startsWith(`${prefix}-`) && f.endsWith('.png')).sort();
  for (const old of shots.slice(0, -KEEP)) fs.rmSync(path.join(folder, old), { force: true });
}

module.exports = { start };
