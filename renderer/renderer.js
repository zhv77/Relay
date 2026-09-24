'use strict';

// The window.

const statusText = document.getElementById('status');
const warnText = document.getElementById('warn');
const refreshButton = document.getElementById('refresh');
const updateButton = document.getElementById('update');
function showUpdate(state) {
  const labels = { idle: 'Check for updates', checking: 'Checking…', current: 'Up to date',
    available: 'Preparing update…', downloading: `Downloading ${state.percent || 0}%`,
    ready: 'Restart to update', installing: 'Restarting…', error: 'Retry update' };
  updateButton.hidden = state.status === 'disabled';
  updateButton.textContent = labels[state.status] || 'Check for updates';
  updateButton.disabled = ['checking', 'available', 'downloading', 'installing'].includes(state.status);
  updateButton.title = `Version ${state.currentVersion}${state.version ? ` · Update ${state.version}` : ''}`;
}
window.warframe.onUpdate(showUpdate);
window.warframe.updateState().then(showUpdate).catch(() => {});
updateButton.addEventListener('click', () => window.warframe.updateAction().then(showUpdate).catch(() => {}));

function briefInventoryWarning(warning) {
  return /^(Saved|Recovered) inventory\b/.test(warning || '')
    ? 'Estimated from your latest inventory scan.'
    : warning || '';
}

// Whether items can be matched to warframe.market yet, and if not, why.
let catalogue = { state: 'ready' };

function catalogueReady() {
  return catalogue.state === 'ready';
}

function catalogueMessage() {
  switch (catalogue.state) {
    case 'needsLogin':
      return 'Sign in on the Account tab to match your items to warframe.market.';
    case 'loading':
    case 'idle':
      return 'Downloading the warframe.market item list...';
    case 'failed': {
      const wait = catalogue.retryAt ? Math.max(0, Math.round((catalogue.retryAt - Date.now()) / 1000)) : null;
      return `Could not reach warframe.market (${catalogue.error || 'unknown error'}).` +
        (wait != null ? ` Trying again in ${wait}s.` : '');
    }
    default:
      return '';
  }
}

function catalogueClass() {
  return catalogue.state === 'failed' ? 'status bad' : 'status warn';
}

function plat(value) {
  return value == null ? '' : `${value.toLocaleString()}p`;
}

async function load({ force = false } = {}) {
  refreshButton.disabled = true;
  statusText.className = 'status';
  statusText.title = '';
  statusText.textContent = force ? 'reading the game...' : 'loading...';
  warnText.hidden = true;

  try {
    const result = await window.warframe.holdings({ force });
    if (result.pending) {
      // The scan is running elsewhere; it will say so when it lands.
      statusText.textContent = 'reading the game...';
      return;
    }
    if (!result.ok) {
      statusText.className = 'status bad';
      statusText.textContent = result.error;
    } else {
      statusText.className = 'status' + (result.partial ? ' warn' : '');
      statusText.textContent = !catalogueReady()
        ? `${result.items.toLocaleString()} item types read - ${catalogueMessage()}`
        : result.partial
        ? `${result.items.toLocaleString()} item types · Estimated from your latest inventory scan`
        : `${result.items.toLocaleString()} item types read`;
      statusText.title = result.warning || '';
      if (!catalogueReady()) {
        statusText.className = catalogueClass();
        warnText.hidden = true;
      } else if (result.warning && !result.partial) {
        warnText.hidden = false;
        warnText.textContent = result.warning;
      } else if (result.partial) {
        // The status already explains the limitation.
        warnText.hidden = true;
      }
    }
  } catch (error) {
    statusText.className = 'status bad';
    statusText.textContent = String(error.message || error);
  } finally {
    refreshButton.disabled = false;
  }
}

refreshButton.addEventListener('click', () => load({ force: true }));
load();


const el = (id) => document.getElementById(id);

function masteryThreshold(rank) {
  return rank <= 30 ? 2500 * rank * rank : 2250000 + 147500 * (rank - 30);
}

function masteryLabel(rank) {
  return rank <= 30 ? `Mastery Rank ${rank}` : `Legendary Rank ${rank - 30}`;
}

async function loadMastery() {
  const result = await window.warframe.mastery();
  if (!result.ok) {
    el('masteryStatus').className = 'status warn';
    el('masteryStatus').textContent = result.error;
    el('masteryRank').textContent = '';
    el('masteryFill').style.width = '0%';
    el('masteryProgress').textContent = '';
    el('masteryTotal').textContent = '';
    return;
  }
  const current = masteryThreshold(result.rank);
  const next = masteryThreshold(result.rank + 1);
  const earned = Math.max(0, result.xp - current);
  const needed = Math.max(1, next - current);
  el('masteryStatus').className = 'status';
  el('masteryStatus').textContent = 'Account mastery';
  el('masteryRank').textContent = masteryLabel(result.rank);
  el('masteryFill').style.width = `${Math.min(100, earned / needed * 100)}%`;
  el('masteryProgress').textContent = `${earned.toLocaleString()} / ${needed.toLocaleString()} to ${masteryLabel(result.rank + 1)}`;
  el('masteryTotal').textContent = `${result.xp.toLocaleString()} total`;
}

const syn = {
  rows: [],
  vendor: null,
  sort: { key: 'perThousand', dir: -1 },
  loaded: false,
};


// The price the current rule would post a row at.
function postPrice(row) {
  const basis = el('ruleBasis').value;
  if (basis === 'fixed') return Math.max(1, Number(el('ruleFixed').value) || 0) || null;
  const base = basis === 'median7d' ? (row.median7d ?? row.median90d) : row[basis];
  if (base == null) return null;
  const adjust = Number(el('ruleAdjust').value) || 0;
  // One plat is the floor: warframe.market has no free orders.
  return Math.max(1, Math.round(base + adjust));
}

function sellersCheaper(row, price) {
  if (price == null || !row.askLadder) return null;
  return row.askLadder.filter((ask) => ask < price).length;
}


function visibleOffers() {
  const needle = el('offerFilter').value.trim().toLowerCase();
  const minVol = Number(el('offerMinVol').value) || 0;
  const minPrice = Number(el('offerMinPrice').value) || 0;
  const maxAhead = Number(el('offerMaxAhead').value) || 0;
  const { key, dir } = syn.sort;

  return syn.rows
    .filter((row) => {
      if (el('offerTradeable').checked && !row.tradeable) return false;
      if (needle && !row.name.toLowerCase().includes(needle)) return false;
      if (!row.priced) return true;
      if ((row.volume7d ?? 0) < minVol) return false;
      const price = postPrice(row);
      if (minPrice && (price == null || price < minPrice)) return false;
      if (maxAhead && (sellersCheaper(row, price) ?? 0) > maxAhead) return false;
      return true;
    })
    .sort((a, b) => {
      const value = (row) => {
        if (key === 'postAt') return postPrice(row);
        if (key === 'ahead') return sellersCheaper(row, postPrice(row));
        return row[key];
      };
      const x = value(a);
      const y = value(b);
      if (typeof x === 'string' || typeof y === 'string') {
        return String(x ?? '').localeCompare(String(y ?? '')) * dir;
      }
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      return (x - y) * dir;
    });
}


function ageText(at) {
  if (!at) return null;
  const minutes = Math.round((Date.now() - at) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return minutes + 'm ago';
  const hours = Math.round(minutes / 60);
  return hours < 48 ? hours + 'h ago' : Math.round(hours / 24) + 'd ago';
}

function ageClass(at) {
  if (!at) return '';
  const minutes = (Date.now() - at) / 60000;
  if (minutes > 24 * 60) return 'stale bad';
  return minutes > 60 ? 'stale' : '';
}

function cell(text, className, title, extra = false) {
  const td = document.createElement('td');
  if (text instanceof Node) td.append(text);
  else td.textContent = text ?? '';
  if (className) td.className = className;
  if (title) td.title = title;
  // The header and the body have to agree about which columns exist.
  if (extra) td.dataset.extra = '';
  return td;
}

// Make a name open its item on warframe.market.
function opensMarket(element, slug, label) {
  if (!slug) return element;
  element.classList.add('linked');
  element.title = element.title
    ? `${element.title}${String.fromCharCode(10)}Click to open ${label} on warframe.market`
    : `Click to open ${label} on warframe.market`;
  element.addEventListener('click', () => {
    // A click that ends a text selection is not a click on the name.
    if (String(window.getSelection())) return;
    window.warframe.openItem(slug);
  });
  return element;
}

function unknownCell(className, extra = false) {
  const span = document.createElement('span');
  span.className = 'unknown';
  span.textContent = '?';
  span.title = 'Not priced yet';
  return cell(span, className, null, extra);
}

function listedCell(row) {
  if (row.listed == null) return cell('', 'num dim');
  const span = document.createElement('span');
  const market = row.sell;
  let suffix = '';
  let tone = 'mine';
  if (market != null && row.listed !== market) {
    const gap = Math.round(Math.abs(row.listed - market));
    suffix = row.listed < market ? ' \u2193' : ' \u2191';
    tone = row.listed < market ? 'mine low' : 'mine high';
    span.title = row.listed < market
      ? `You are asking ${gap}p under the cheapest online seller`
      : `You are asking ${gap}p over the cheapest online seller`;
  }
  span.className = tone;
  span.textContent = `${row.listed}p${suffix}`;
  return cell(span, 'num');
}

function renderOffers() {
  const rows = visibleOffers();
  const body = el('offerRows');

  el('offerEmpty').hidden = rows.length > 0;
  if (!rows.length) {
    el('offerEmpty').textContent = syn.rows.length
      ? 'Nothing matches those filters.'
      : 'Nothing loaded.';
    body.replaceChildren();
    renderActions([]);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const row of rows) {
    const tr = document.createElement('tr');
    const price = postPrice(row);
    const cheaper = sellersCheaper(row, price);
    const plat = (value) => (value == null ? '' : `${value}p`);
    const priced = row.priced;

    const label = document.createElement('span');
    label.textContent = row.name;
    opensMarket(label, row.tradeable ? row.slug : null, row.name);
    const name = cell(label);
    if (!row.tradeable) name.className = 'muted';

    tr.append(
      name,
      cell(row.type, 'dim', null, true),
      cell(row.reqRank == null ? '' : row.reqRank, 'num dim'),
      cell(row.cost.toLocaleString(), 'num dim', null, true),
      cell(row.count, 'num dim', null, true),
      listedCell(row),
      priced ? cell(plat(price), price == null ? 'num' : 'num good') : unknownCell('num'),
      priced ? cell(plat(row.sell), 'num') : unknownCell('num'),
      priced
        ? cell(
            cheaper == null ? '' : String(cheaper),
            'num ' + (cheaper === 0 ? 'ahead-good' : cheaper > 10 ? 'ahead-bad' : ''),
            row.askLadder && row.askLadder.length
              ? `online asks: ${row.askLadder.slice(0, 12).join('p, ')}p`
              : 'nobody online is selling this'
          )
        : unknownCell('num'),
      priced ? cell(plat(row.buy), 'num dim') : unknownCell('num dim'),
      priced ? cell(plat(row.median7d), 'num dim') : unknownCell('num dim'),
      priced ? cell(row.volume7d == null ? '' : row.volume7d.toLocaleString(), 'num dim') : unknownCell('num dim'),
      priced ? cell(plat(row.median90d), 'num dim', null, true) : unknownCell('num dim', true),
      cell(row.owned ? row.owned.toLocaleString() : '', 'num dim', null, true),
      cell(plat(row.value), 'num', null, true),
      cell(row.perThousand == null ? '' : `${row.perThousand}p`, 'num good'),
      priced
        ? cell(ageText(row.pricedAt) ?? '', 'num ' + ageClass(row.pricedAt))
        : unknownCell('num')
    );
    fragment.append(tr);
  }
  body.replaceChildren(fragment);
  renderActions(rows);
  declareOfferFocus(rows);
}

function declareOfferFocus(rows) {
  const { visible, rest } = rowsOnScreen(el('offerRows'));
  const order = [...visible, ...rest]
    .map((index) => rows[index])
    .filter((row) => row && row.slug)
    .map((row) => row.slug);
  declareFocus(`vendor:${el('vendor').value}`, order);
}


function renderActions(rows) {
  const postable = rows.filter((row) => row.tradeable && row.itemId && row.priced && postPrice(row) != null);
  const listed = rows.filter((row) => row.listingId);
  const fresh = postable.filter((row) => row.listed == null);
  const unpriced = rows.filter((row) => row.tradeable && !row.priced).length;
  const qty = Math.max(1, Number(el('ruleQty').value) || 1);
  const total = fresh.reduce((sum, row) => sum + postPrice(row) * qty, 0);

  const notes = [];
  if (listed.length) notes.push(`${listed.length} already listed`);
  if (unpriced) notes.push(`${unpriced} unpriced`);
  const tail = notes.length ? ' \u00b7 ' + notes.join(' \u00b7 ') : '';

  el('offerActions').textContent = fresh.length
    ? `${fresh.length} to post, ${total}p in total${tail}`
    : notes.length
      ? `Nothing new to post${tail}`
      : 'nothing here can be posted';

  el('postAll').disabled = !fresh.length || !syn.canPost;
  el('postAll').textContent = fresh.length ? `Post ${fresh.length}` : 'Post';
  el('postAll').title = syn.canPost ? '' : 'Set a warframe.market token first';
  el('removeListed').disabled = !listed.length || !syn.canPost;
  el('removeListed').textContent = listed.length
    ? `Remove ${listed.length} listing${listed.length === 1 ? '' : 's'}`
    : 'Remove listings';
}


function favourites() {
  try {
    return new Set(JSON.parse(localStorage.getItem('favouriteVendors') || '[]'));
  } catch {
    return new Set();
  }
}

function syncStar() {
  const on = favourites().has(el('vendor').value);
  el('vendorFav').textContent = on ? '\u2605' : '\u2606';
  el('vendorFav').classList.toggle('on', on);
}

// The six faction syndicates, in the order the game lists them.
const CLASSIC = [
  'Steel Meridian',
  'Arbiters of Hexis',
  'Cephalon Suda',
  'The Perrin Sequence',
  'Red Veil',
  'New Loka',
];

const OPEN_WORLDS = new Map([
  ['Offworlder > Visitor > Trusted > Surah > Kin', 'Ostron'],
  ['Outworlder > Rapscallion > Doer > Cove > Old Mate', 'Solaris United'],
  ['Stranger > Acquaintance > Associate > Friend > Family', 'Entrati'],
  ['Fallen > Watcher > Guardian > Seraph > Angel', 'The Holdfasts'],
  ['Assistant > Researcher > Colleague > Scholar > Illuminate', 'Cavia'],
  ['Leftovers > Fresh Slice > 2-For-1 > Hot & Fresh > Pizza Party', 'The Hex'],
  ['Operative > Agent > Hand > Instrument > Shadow', 'Quills / Vox Solaris'],
  ['Glinty > Whozit > Proper Felon > Primo > Logical', 'Ventkids'],
]);

// Vendors with no ladder of their own that still belong to an open world.
const OPEN_WORLD_KEYS = new Map([['Necraloid', 'Entrati'], ['Acrithis', 'Duviri']]);

function openWorld(vendor) {
  const ladder = Array.isArray(vendor.ranks) ? vendor.ranks.join(' > ') : null;
  return (ladder && OPEN_WORLDS.get(ladder)) || OPEN_WORLD_KEYS.get(vendor.key) || null;
}
function groupVendors(vendors, needle) {
  const stars = favourites();
  const match = (vendor) =>
    !needle || vendor.name.toLowerCase().includes(needle) || vendor.key.toLowerCase().includes(needle);
  const bySize = (a, b) => (b.tradeableCount ?? 0) - (a.tradeableCount ?? 0);

  const pool = vendors.filter(match);
  const taken = new Set();
  const groups = [];

  const take = (label, list) => {
    const rows = list.filter((vendor) => !taken.has(vendor.key));
    rows.forEach((vendor) => taken.add(vendor.key));
    if (rows.length) groups.push({ label, rows });
  };

  take('Favourites', pool.filter((vendor) => stars.has(vendor.key)));
  take(
    'Syndicates',
    CLASSIC.map((key) => pool.find((vendor) => vendor.key === key)).filter(Boolean)
  );
  take(
    'Open worlds',
    pool
      .filter((vendor) => openWorld(vendor))
      .sort(
        (a, b) =>
          openWorld(a).localeCompare(openWorld(b)) || a.name.localeCompare(b.name)
      )
  );
  take('Standing', pool.filter((vendor) => vendor.currency === 'Standing').sort(bySize));
  take('Tokens and currencies', pool.filter(() => true).sort(bySize));
  return groups;
}

function renderVendorList() {
  const needle = el('vendorSearch').value.trim().toLowerCase();
  const list = el('vendorList');
  const groups = groupVendors(syn.vendors || [], needle);

  if (!groups.length) {
    list.replaceChildren(Object.assign(document.createElement('div'), {
      className: 'combo-empty',
      textContent: 'No vendor matches that.',
    }));
    return;
  }

  const fragment = document.createDocumentFragment();
  syn.options = [];
  for (const group of groups) {
    const heading = document.createElement('div');
    heading.className = 'combo-group';
    heading.textContent = group.label;
    fragment.append(heading);
    for (const vendor of group.rows) {
      const item = document.createElement('div');
      item.className = 'combo-item' + (vendor.key === el('vendor').value ? ' chosen' : '');
      item.dataset.key = vendor.key;
      const name = document.createElement('span');
      const world = openWorld(vendor);
      name.textContent = vendor.name;
      if (world && group.label === 'Open worlds') {
        const tag = document.createElement('span');
        tag.className = 'combo-tag';
        tag.textContent = world;
        name.append(' ', tag);
      }
      const count = document.createElement('span');
      count.className = 'count';
      count.textContent = vendor.tradeableCount ?? vendor.offerCount;
      count.title = 'resellable offerings';
      item.append(name, count);
      item.addEventListener('click', () => chooseVendor(vendor.key));
      fragment.append(item);
      syn.options.push(vendor.key);
    }
  }
  list.replaceChildren(fragment);
}

function vendorLabel() {
  const chosen = (syn.vendors || []).find((vendor) => vendor.key === el('vendor').value);
  el('vendorLabel').textContent = chosen ? chosen.name : 'Choose a vendor';
}

function openVendorList() {
  el('vendorPanel').hidden = false;
  el('vendorButton').setAttribute('aria-expanded', 'true');
  el('vendorSearch').value = '';
  syn.active = -1;
  renderVendorList();
  el('vendorSearch').focus();
}

function closeVendorList() {
  el('vendorPanel').hidden = true;
  el('vendorButton').setAttribute('aria-expanded', 'false');
  syn.active = -1;
  vendorLabel();
}

function toggleVendorList() {
  if (el('vendorPanel').hidden) openVendorList();
  else closeVendorList();
}

function chooseVendor(key) {
  el('vendor').value = key;
  closeVendorList();
  el('vendorButton').focus();
  syncStar();
  loadStock();
}

function fillVendors(vendors) {
  syn.vendors = vendors;
  const stars = favourites();
  if (!el('vendor').value) {
    const starred = vendors.find((vendor) => stars.has(vendor.key));
    const firstClassic = CLASSIC.map((key) => vendors.find((v) => v.key === key)).find(Boolean);
    const biggest = [...vendors].sort(
      (a, b) => (b.tradeableCount ?? 0) - (a.tradeableCount ?? 0)
    )[0];
    el('vendor').value = (starred || firstClassic || biggest || {}).key || '';
  }
  vendorLabel();
  syncStar();
}

async function loadVendors() {
  if (syn.loaded) return;
  const result = await window.warframe.vendors();
  if (!result.ok) {
    el('offerStatus').className = 'status bad';
    el('offerStatus').textContent = result.error;
    return;
  }
  syn.loaded = true;
  fillVendors(result.vendors);
  await loadStock();
}

// Prices arrived for rows already on screen.
let refreshPending = false;
async function refreshOfferPrices() {
  if (refreshPending) return;
  refreshPending = true;
  setTimeout(async () => {
    refreshPending = false;
    const key = el('vendor').value;
    if (!key || document.getElementById('panel-syndicates').hidden) return;
    const result = await window.warframe.vendorStock(key, {});
    if (result.ok) {
      syn.rows = result.rows;
      renderOffers();
    }
  }, REDRAW_MS);
}

const REDRAW_MS = 4000;

let setsPending = false;
function refreshSetPrices() {
  if (setsPending) return;
  setsPending = true;
  setTimeout(async () => {
    setsPending = false;
    if (document.getElementById('panel-sets').hidden) return;
    await loadSets({ focus: false });
  }, REDRAW_MS);
}

async function loadStock({ refresh = false } = {}) {
  const key = el('vendor').value;
  if (!key) return;
  el('offerStatus').className = 'status';
  el('offerStatus').textContent = 'pricing...';

  const result = await window.warframe.vendorStock(key, { refresh, force: refresh });
  if (!result.ok) {
    el('offerStatus').className = 'status bad';
    el('offerStatus').textContent = result.error;
    syn.rows = [];
  } else {
    syn.rows = result.rows;
    syn.vendor = result.vendor;
    const tradeable = syn.rows.filter((row) => row.tradeable).length;
    el('offerStatus').className = catalogueReady() ? 'status' : catalogueClass();
    el('offerStatus').textContent = catalogueReady()
      ? `${tradeable} resellable of ${syn.rows.length} \u00b7 ${result.priced} priced`
      : catalogueMessage();
  }
  renderOffers();
}


el('vendorButton').addEventListener('click', toggleVendorList);
el('vendorSearch').addEventListener('input', renderVendorList);

el('vendorSearch').addEventListener('keydown', (event) => {
  const items = [...el('vendorList').querySelectorAll('.combo-item')];
  if (event.key === 'Escape') {
    closeVendorList();
    el('vendorButton').focus();
    return;
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    syn.active = Math.max(
      0,
      Math.min(items.length - 1, (syn.active ?? -1) + (event.key === 'ArrowDown' ? 1 : -1))
    );
    items.forEach((item, index) => item.classList.toggle('active', index === syn.active));
    items[syn.active]?.scrollIntoView({ block: 'nearest' });
    return;
  }
  if (event.key === 'Enter') {
    const pick = items[syn.active] || items[0];
    if (pick) {
      event.preventDefault();
      chooseVendor(pick.dataset.key);
    }
  }
});

// Clicking anywhere else closes it.
document.addEventListener('click', (event) => {
  if (el('vendorPanel').hidden) return;
  if (!event.target.closest('.combo')) closeVendorList();
});

el('vendorFav').addEventListener('click', () => {
  const key = el('vendor').value;
  if (!key) return;
  const stars = favourites();
  if (stars.has(key)) stars.delete(key);
  else stars.add(key);
  try {
    localStorage.setItem('favouriteVendors', JSON.stringify([...stars]));
  } catch {
    // private window: the star simply will not persist
  }
  syncStar();
  if (!el('vendorList').hidden) renderVendorList();
});

['offerFilter', 'offerMinVol', 'offerMinPrice', 'offerMaxAhead', 'ruleAdjust', 'ruleFixed', 'ruleQty']
  .forEach((id) => el(id).addEventListener('input', renderOffers));
el('offerTradeable').addEventListener('change', renderOffers);

el('ruleBasis').addEventListener('change', () => {
  const fixed = el('ruleBasis').value === 'fixed';
  el('ruleAdjustLabel').hidden = fixed;
  el('ruleFixedLabel').hidden = !fixed;
  renderOffers();
});

el('offerExtras').addEventListener('change', () => {
  document.getElementById('panel-syndicates').classList.toggle('show-extras', el('offerExtras').checked);
});

document.querySelectorAll('#offerGrid th[data-sort]').forEach((th) => {
  th.addEventListener('click', () => {
    const key = th.dataset.sort;
    syn.sort.dir = syn.sort.key === key ? -syn.sort.dir : -1;
    syn.sort.key = key;
    renderOffers();
  });
});

el('postAll').addEventListener('click', async () => {
  const qty = Math.max(1, Number(el('ruleQty').value) || 1);
  const orders = visibleOffers()
    .filter((row) => row.tradeable && row.itemId && row.priced && row.listed == null && postPrice(row) != null)
    .map((row) => ({ slug: row.slug, itemId: row.itemId, type: 'sell', platinum: postPrice(row), quantity: qty, rank: 0 }));
  if (!orders.length) return;

  const total = orders.reduce((sum, order) => sum + order.platinum * order.quantity, 0);
  const sample = orders.slice(0, 6).map((o) => `  ${o.slug} at ${o.platinum}p`).join('\n');
  if (!confirm(
    `Post ${orders.length} public sell orders on your account, ${total}p in total?\n\n${sample}` +
    (orders.length > 6 ? `\n  ...and ${orders.length - 6} more` : '') +
    '\n\nEvery row on screen you have not already listed. They go live on ' +
    'warframe.market immediately, and Remove listings undoes it.'
  )) return;

  el('postAll').disabled = true;
  el('offerStatus').textContent = `posting ${orders.length}...`;
  const result = await window.warframe.postOrders(orders);
  const failed = result.results.filter((row) => !row.ok);
  el('offerStatus').className = failed.length ? 'status bad' : 'status';
  el('offerStatus').textContent =
    `posted ${result.posted} of ${orders.length}` +
    (failed.length ? ` \u00b7 ${failed[0].error}` : '');
  await loadStock();
});

el('removeListed').addEventListener('click', async () => {
  const targets = visibleOffers().filter((row) => row.listingId);
  if (!targets.length) return;
  const worth = targets.reduce((sum, row) => sum + (row.listed || 0), 0);
  const sample = targets.slice(0, 6).map((row) => `  ${row.name} at ${row.listed}p`).join('\n');
  if (!confirm(
    `Remove ${targets.length} of your live sell orders, ${worth}p listed?\n\n${sample}` +
    (targets.length > 6 ? `\n  ...and ${targets.length - 6} more` : '') +
    '\n\nOnly the rows shown above are touched. Your other listings stay up. ' +
    'This cannot be undone - they would have to be posted again.'
  )) return;

  el('removeListed').disabled = true;
  el('offerStatus').textContent = `removing ${targets.length}...`;
  const result = await window.warframe.removeOrders(targets.map((row) => row.listingId));
  el('offerStatus').textContent = `removed ${result.removed} of ${targets.length}`;
  await loadStock();
});


async function loadAccount() {
  const status = await window.warframe.account();
  syn.canPost = Boolean(status.hasToken && status.valid);
  const box = el('account');
  if (!status.hasToken) {
    box.className = 'status warn';
    box.textContent = 'no market token - posting disabled';
    box.title = 'Open the Account tab to set one';
  } else if (status.valid) {
    box.className = 'status';
    box.textContent = `signed in as ${status.name}`;
  } else {
    box.className = 'status bad';
    box.textContent = status.error || 'token rejected';
  }
  box.style.cursor = 'pointer';
  renderTokenStatus(status);
  renderPresence(await window.warframe.presence());
  renderOffers();
}

el('account').addEventListener('click', () => {
  document.querySelector('.tab[data-tab="account"]').click();
});


const setsView = { rows: [], sort: { key: 'profitToFinish', dir: -1 }, loaded: false, pending: false };

let focusTimer = null;
function declareFocus(key, slugs) {
  clearTimeout(focusTimer);
  focusTimer = setTimeout(() => window.warframe.declareFocus(key, slugs), 250);
}

// Which rows of a table are actually on screen.
function rowsOnScreen(body) {
  const rows = [...body.children];
  const height = window.innerHeight;
  const visible = [];
  const rest = [];
  for (let i = 0; i < rows.length; i += 1) {
    const box = rows[i].getBoundingClientRect();
    (box.bottom > 0 && box.top < height ? visible : rest).push(i);
  }
  return { visible, rest };
}

function visibleSets() {
  const needle = el('setFilter').value.trim().toLowerCase();
  const maxMissing = Number(el('setMaxMissing').value) || 0;
  const haveSome = el('setHaveSome').checked;
  const profitable = el('setProfitable').checked;
  const { key, dir } = setsView.sort;

  return setsView.rows
    .filter((row) => {
      if (row.unresolved) return false;
      if (needle && !row.name.toLowerCase().includes(needle)) return false;
      if (maxMissing && row.missingCount > maxMissing) return false;
      if (haveSome && row.held < 1) return false;
      if (profitable && row.profitToFinish != null && row.profitToFinish <= 0) return false;
      return true;
    })
    .sort((a, b) => {
      const profitSort = key === 'profitToFinish' || key === 'profitFromScratch';
      if (profitSort && a.thin !== b.thin) return a.thin ? 1 : -1;

      const x = a[key];
      const y = b[key];
      if (typeof x === 'string' || typeof y === 'string') {
        return String(x ?? '').localeCompare(String(y ?? '')) * dir;
      }
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      return (x - y) * dir;
    });
}

// Where the parts you are missing come from.
function dropsCell(row) {
  const parts = row.notHeld || row.parts || [];
  if (!parts.length) return cell('', 'dim');

  const sources = new Map();
  for (const part of parts) {
    for (const source of part.sources || []) {
      const existing = sources.get(source.relic);
      if (!existing || source.chance > existing.chance) sources.set(source.relic, source);
    }
  }
  if (!sources.size) return cell('', 'dim');

  const ordered = [...sources.values()].sort(
    (a, b) =>
      (b.held ? 1 : 0) - (a.held ? 1 : 0) ||
      (a.vaulted ? 1 : 0) - (b.vaulted ? 1 : 0) ||
      b.chance - a.chance
  );

  const box = document.createElement('span');
  box.className = 'relicsrc';
  ordered.slice(0, 3).forEach((source, index) => {
    if (index) box.append(', ');
    const name = document.createElement('span');
    name.textContent = source.relic;
    if (source.held) {
      name.className = 'held';
      const count = document.createElement('span');
      count.className = 'count';
      count.textContent = `×${source.held}`;
      name.append(count);
    } else if (!source.vaulted) {
      name.className = 'farmable';
    }
    box.append(name);
  });
  if (ordered.length > 3) box.append(` +${ordered.length - 3}`);

  const td = cell(box, null);
  td.title = ordered
    .map(
      (source) =>
        `${source.relic} ${source.chance}%` +
        (source.held ? ` - you hold ${source.held}` : source.vaulted ? ' (vaulted)' : '')
    )
    .join(String.fromCharCode(10));
  return td;
}

function renderSets() {
  const rows = visibleSets();
  const body = el('setRows');
  el('setStatus').className = 'status' + (setsView.warning ? ' warn' : '');
  el('setStatus').title = setsView.warning || '';
  el('setStatus').textContent = `${rows.length} of ${setsView.rows.length} sets` +
    (setsView.warning ? ` · ${briefInventoryWarning(setsView.warning)}` : '');
  if (!catalogueReady()) {
    el('setStatus').className = catalogueClass();
    el('setStatus').title = '';
    el('setStatus').textContent = catalogueMessage();
  }
  el('setEmpty').hidden = rows.length > 0;
  if (!rows.length) {
    el('setEmpty').textContent = !catalogueReady()
      ? catalogueMessage()
      : setsView.rows.length
        ? 'Nothing matches those filters.'
        : 'Nothing loaded yet.';
    body.replaceChildren();
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const row of rows.slice(0, 300)) {
    const tr = document.createElement('tr');
    if (!setsView.pending && row.missingCount === 1) {
      tr.className = 'near';
      tr.title = `One part away based on your latest scan: ${row.missing[0].name}`;
    }

    const name = document.createElement('td');
    const label = document.createElement('span');
    label.className = 'withicon';
    const picture = iconFor(row.icon, row.name);
    if (picture) label.append(picture);
    label.append(row.name);
    opensMarket(label, row.slug, row.name);
    name.append(label);
    if (row.built) {
      const tag = document.createElement('span');
      tag.className = 'built';
      tag.textContent = 'built';
      tag.title = 'You already own the assembled item, which is not the same as owning the parts';
      name.append(' ', tag);
    }

    // Every component, ticked when held, priced when not.
    const components = document.createElement('td');
    if (row.heldWorth != null) {
      components.title = `The parts you hold are worth about ${row.heldWorth}p sold separately`;
    }
    const list = document.createElement('div');
    list.className = 'parts';
    const prefix = row.name.replace(/ Set$/, '') + ' ';
    for (const part of row.parts) {
      const chip = document.createElement('span');
      chip.className = 'part ' + (part.owned ? 'have' : 'need');
      const from = (part.sources || [])
        .map((source) => `${source.relic}${source.vaulted ? ' (vaulted)' : ''} ${source.chance}%`)
        .join(', ');
      chip.title =
        `${part.name} - ${part.owned || 0} owned` +
        (from ? String.fromCharCode(10) + 'Drops from ' + from : '');

      const label = document.createElement('span');
      label.textContent =
        (part.owned ? '\u2713\u2009' : '') +
        (part.name.startsWith(prefix) ? part.name.slice(prefix.length) : part.name);
      chip.append(label);

      // Both sides carry a number, but not the same one.
      const amount = part.owned ? part.worth : part.cost;
      const price = document.createElement('span');
      price.className = 'cost';
      price.textContent = amount == null ? ' ?' : ` ${amount}p`;
      price.title = amount == null
        ? 'not priced yet'
        : part.owned
          ? `worth about ${amount}p sold on its own`
          : `costs about ${amount}p to buy`;
      chip.append(price);
      opensMarket(chip, part.slug, part.name);
      list.append(chip);
    }
    components.append(list);

    const plat = (v) => (v == null ? '' : v + 'p');
    const profit = (v) => {
      const td = cell(v == null ? '' : (v > 0 ? '+' : '') + v + 'p', 'num');
      if (v != null) td.classList.add(v > 0 ? 'good' : 'dim');
      return td;
    };

    tr.append(
      name,
      setsView.pending
        ? cell('—', 'num dim', 'Still reading your inventory')
        : cell(`${row.held}/${row.partCount}`, 'num dim'),
      components,
      dropsCell(row),
      row.vaulted == null
        ? cell('', 'dim')
        : cell(row.vaulted ? 'Vaulted' : 'Farmable', row.vaulted ? 'dim' : ''),
      cell(plat(row.toFinish), 'num'),
      (() => {
        const td = cell(plat(row.sellsFor), 'num');
        if (!row.priced) return unknownCell('num');
        if (row.inflated) {
          td.classList.add('dim');
          td.title =
            `Trades at ${row.setMedian}p. The cheapest listing is ${row.setSell}p, ` +
            'which is one seller\u2019s asking price rather than a market.';
          const tag = document.createElement('span');
          tag.className = 'built';
          tag.style.color = '#b08a3c';
          tag.textContent = 'thin';
          td.append(' ', tag);
        }
        return td;
      })(),
      profit(row.profitToFinish),
      cell(plat(row.fromScratch), 'num dim'),
      profit(row.profitFromScratch),
      cell(row.volume7d == null ? '' : row.volume7d, 'num dim'),
      cell(ageText(row.pricedAt) ?? '', 'num ' + ageClass(row.pricedAt))
    );
    fragment.append(tr);
  }
  body.replaceChildren(fragment);

  declareSetFocus(rows);

  const finishable = rows.filter((row) => row.profitToFinish != null && row.profitToFinish > 0);
  el('setStatus').textContent =
    `${rows.length} of ${setsView.rows.length} sets` +
    (finishable.length ? ` \u00b7 ${finishable.length} worth finishing` : '') +
    (setsView.warning ? ` · ${briefInventoryWarning(setsView.warning)}` : '');
  if (!catalogueReady()) {
    el('setStatus').className = catalogueClass();
    el('setStatus').textContent = catalogueMessage();
  }
}

// Tell the fetcher what to work on, in screen order.
function declareSetFocus(rows) {
  const { visible, rest } = rowsOnScreen(el('setRows'));
  const slugs = [];
  const add = (index) => {
    const row = rows[index];
    if (!row) return;
    slugs.push(row.slug);
    for (const part of row.parts) slugs.push(part.slug);
  };
  visible.forEach(add);
  for (const index of rest.slice(0, 250)) {
    if (rows[index]) slugs.push(rows[index].slug);
  }
  declareFocus('sets', slugs);
}

// Scrolling changes what is on screen, so it changes what should be fetched.
let scrollTimer = null;
window.addEventListener('scroll', () => {
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => {
    if (!document.getElementById('panel-sets').hidden && setsView.rows.length) {
      declareSetFocus(visibleSets());
    }
    if (!document.getElementById('panel-syndicates').hidden && syn.rows.length) {
      declareOfferFocus(visibleOffers());
    }
    if (!document.getElementById('panel-relics').hidden && relicView.rows.length) {
      declareRelicFocus(visibleRelics());
    }
  }, 300);
});

async function loadSets({ focus = true } = {}) {
  el('setStatus').className = 'status';
  if (!setsView.rows.length) el('setStatus').textContent = 'reading your inventory...';
  const result = await window.warframe.sets({ focus });
  if (!result.ok) {
    el('setStatus').className = 'status bad';
    el('setStatus').textContent = result.error || 'could not build the set list';
    return;
  }
  setsView.rows = result.rows;
  setsView.pending = Boolean(result.pending);
  setsView.warning = result.warning || '';
  setsView.loaded = true;
  if (result.warning) {
    el('setStatus').className = 'status warn';
    el('setStatus').textContent = result.warning;
  }
  renderSets();
}

['setFilter', 'setMaxMissing'].forEach((id) =>
  el(id).addEventListener('input', renderSets)
);
['setHaveSome', 'setProfitable'].forEach((id) =>
  el(id).addEventListener('change', renderSets)
);

document.querySelectorAll('#setGrid th[data-sort]').forEach((th) => {
  th.addEventListener('click', () => {
    const key = th.dataset.sort;
    setsView.sort.dir = setsView.sort.key === key ? -setsView.sort.dir : -1;
    setsView.sort.key = key;
    renderSets();
  });
});


let fetchIdleSince = 0;

function renderFetch(state) {
  const bar = el('fetchBar');
  if (!state) {
    bar.hidden = true;
    return;
  }

  if (state.needsToken) {
    bar.hidden = false;
    el('fetchFill').style.width = '0%';
    el('fetchText').textContent = 'Sign in on the Account tab to see prices.';
    fetchIdleSince = 0;
    return;
  }

  if (!state.total) {
    bar.hidden = true;
    return;
  }

  const done = state.fresh;
  const share = state.total ? Math.round((done / state.total) * 100) : 100;
  el('fetchFill').style.width = share + '%';

  const behind = state.missing + state.stale;
  if (behind === 0) {
    el('fetchText').textContent = `${state.total} items up to date`;
    bar.hidden = false;
    if (!fetchIdleSince) fetchIdleSince = Date.now();
    if (Date.now() - fetchIdleSince > 4000) bar.hidden = true;
    return;
  }

  fetchIdleSince = 0;
  bar.hidden = false;
  const what = state.missing
    ? `fetching ${state.missing} not priced yet`
    : `refreshing ${state.stale} older than two minutes`;
  el('fetchText').textContent =
    `${what} \u00b7 ${done}/${state.total} current` +
    (state.error ? ` \u00b7 ${state.error}` : '');
}

window.warframe.onFetchProgress((state) => {
  renderFetch(state);
  // Prices landing are only useful if the table shows them.
  if (!document.getElementById('panel-syndicates').hidden && syn.rows.length) {
    refreshOfferPrices();
  }
  if (!document.getElementById('panel-sets').hidden && setsView.rows.length) {
    refreshSetPrices();
  }
  if (!document.getElementById('panel-relics').hidden && relicView.rows.length) {
    refreshRelicPrices();
  }
});


// What warframe.market shows other traders beside your orders.

function renderPresence(state) {
  const box = el('presenceBox');
  box.hidden = !state?.hasToken;
  if (box.hidden) return;

  const status = state.status || 'invisible';
  el('presenceDot').className = 'dot ' + status;
  el('presenceStatus').value = status;
  el('presenceStatus').disabled = !state.signedIn;
  el('presenceDot').title = !state.connected
    ? 'Not connected to warframe.market'
    : !state.signedIn
      ? state.error || 'connecting...'
      : status === 'invisible'
        ? 'Invisible: buyers filtering for online sellers will not see your orders'
        : 'Visible as ' + status;
}

el('presenceStatus').addEventListener('change', async () => {
  const wanted = el('presenceStatus').value;
  el('presenceStatus').disabled = true;
  const state = await window.warframe.setPresence(wanted);
  renderPresence(state);
  if (state.error) showNotice ? showNotice(state.error) : console.warn(state.error);
});

// The inventory scan finished.
function applyCatalogue(status) {
  const was = catalogue.state;
  catalogue = status || { state: 'ready' };
  const panel = (name) => !document.getElementById(`panel-${name}`).hidden;
  if (catalogue.state === 'ready' && was !== 'ready') {
    // It just arrived: everything open was drawn without it.
    if (panel('sets')) loadSets({ focus: true });
    if (panel('relics')) loadRelics();
    if (panel('syndicates')) loadStock();
    return;
  }
  // Still not there: redraw so the message is current.
  if (panel('sets')) renderSets();
  if (panel('relics')) renderRelics();
  if (panel('syndicates') && syn.rows.length) {
    el('offerStatus').className = catalogueClass();
    el('offerStatus').textContent = catalogueMessage();
  }
}

window.warframe.onCatalogue(applyCatalogue);
window.warframe.catalogue().then(applyCatalogue);

// A failed download says when it will retry; keep that countdown honest.
setInterval(() => {
  if (catalogue.state === 'failed') applyCatalogue(catalogue);
}, 1000);

window.warframe.onHoldings(() => {
  if (!document.getElementById('panel-sets').hidden) loadSets({ focus: false });
  if (!document.getElementById('panel-relics').hidden) loadRelics();
  if (!document.getElementById('panel-syndicates').hidden) refreshOfferPrices();
  if (!document.getElementById('panel-mastery').hidden) loadMastery();
});

window.warframe.onPresence(renderPresence);


const relicView = { rows: [], sort: { key: 'platRadiant', dir: -1 }, loaded: false, pending: false };

function visibleRelics() {
  const term = el('relicFilter').value.trim().toLowerCase();
  const mine = el('relicMine').checked;
  const farmable = el('relicFarmable').checked;
  const wanted = el('relicWanted').checked;
  const { key, dir } = relicView.sort;

  return relicView.rows
    .filter((row) => {
      if (mine && !row.held) return false;
      if (farmable && row.vaulted) return false;
      if (wanted && !row.finishes.length) return false;
      if (!term) return true;
      return (
        row.name.toLowerCase().includes(term) ||
        row.rewards.some((reward) => reward.name.toLowerCase().includes(term))
      );
    })
    .sort((a, b) => {
      const pick = (row) => {
        if (key === 'best') return row.best?.plat ?? -1;
        if (key === 'finishes') return row.finishes.length;
        return row[key];
      };
      const left = pick(a);
      const right = pick(b);
      if (typeof left === 'string' || typeof right === 'string') {
        return String(left).localeCompare(String(right)) * dir;
      }
      if (left == null) return 1;
      if (right == null) return -1;
      return (left - right) * dir;
    });
}

// The item's own thumbnail, the one warframe.market uses.
function iconFor(url, name) {
  if (!url) return null;
  const img = document.createElement('img');
  img.className = 'icon';
  img.loading = 'lazy';
  img.src = url;
  img.alt = '';
  img.title = name;
  img.addEventListener('error', () => img.remove());
  return img;
}

function renderRelics() {
  const rows = visibleRelics();
  const body = el('relicRows');

  el('relicStatus').className = 'status' + (relicView.warning ? ' warn' : '');
  el('relicStatus').title = relicView.warning || '';
  el('relicStatus').textContent =
    `${rows.length} of ${relicView.rows.length} relics` +
    (relicView.pending ? ' · reading your inventory' : '') +
    (relicView.warning ? ` · ${briefInventoryWarning(relicView.warning)}` : '');

  if (!catalogueReady()) {
    el('relicStatus').className = catalogueClass();
    el('relicStatus').title = '';
    el('relicStatus').textContent = catalogueMessage();
  }
  el('relicEmpty').hidden = rows.length > 0;
  if (!rows.length) {
    el('relicEmpty').textContent = !catalogueReady()
      ? catalogueMessage()
      : !relicView.rows.length
      ? 'Nothing loaded yet.'
      : el('relicMine').checked
        ? relicView.pending || relicView.partial
          ? 'No relics detected. Untick "Only relics I hold" to see all relics.'
          : 'You are not holding any relics. Untick "Only relics I hold" to see the rest.'
        : 'Nothing matches those filters.';
    body.replaceChildren();
    return;
  }

  const plat = (v) => (v == null ? '' : v + 'p');
  const fragment = document.createDocumentFragment();

  for (const row of rows.slice(0, 300)) {
    const tr = document.createElement('tr');

    const name = document.createElement('td');
    const label = document.createElement('span');
    label.className = 'withicon';
    const picture = iconFor(row.icon, row.name);
    if (picture) label.append(picture);
    label.append(row.name);
    opensMarket(label, row.slug, row.name);
    name.append(label);
    if (row.vaulted) {
      const tag = document.createElement('span');
      tag.className = 'vaulted';
      tag.textContent = 'vaulted';
      tag.title = 'Not in any mission drop table. The only way to get more is to buy them.';
      name.append(tag);
    }

    const held = relicView.pending
      ? cell('—', 'num dim', 'Still reading your inventory')
      : cell(
          row.held || 0,
          'num' + (row.held ? '' : ' dim'),
          row.held
            ? Object.entries(row.owned)
                .filter(([, count]) => count)
                .map(([refinement, count]) => `${count} ${refinement}`)
                .join(', ')
            : undefined
        );

    // Opened or sold, whichever is worth more.
    const sells = cell(plat(row.sells), 'num');
    if (row.sellsBasis === 'quarter') {
      // Not this week's price: dimmed, and says where it came from.
      sells.classList.add('dim');
      sells.title =
        `No sales this week and nobody buying - ${row.sells}p is the 90-day median` +
        (row.sellsVolume ? ` over ${row.sellsVolume} sales` : '');
    } else if (row.sells != null && row.sells > Math.max(row.platIntact, row.platRadiant)) {
      sells.classList.add('good');
      sells.title = 'Worth more unopened than the average drop is worth';
    }

    const best = document.createElement('td');
    if (row.best) {
      const bestLabel = document.createElement('span');
      bestLabel.className = 'withicon';
      const reward = iconFor(row.best.icon, row.best.name);
      if (reward) bestLabel.append(reward);
      bestLabel.append(row.best.name);
      best.append(bestLabel);
      const amount = document.createElement('span');
      amount.className = 'cost';
      amount.textContent = row.best.plat ? ` ${row.best.plat}p` : ' ?';
      best.append(amount);
      best.title =
        `${row.best.name} - ${row.best.chance}% intact, ${row.best.radiantChance}% radiant` +
        (row.best.ducats ? `, ${row.best.ducats} ducats` : '');
      opensMarket(best, row.best.slug, row.best.name);
    }

    const finishes = document.createElement('td');
    if (row.finishes.length) {
      finishes.className = 'good';
      finishes.textContent = row.finishes.length === 1 ? row.finishes[0] : row.finishes.length + ' parts';
      finishes.title = row.finishes.join(String.fromCharCode(10));
    }

    tr.append(
      name,
      held,
      sells,
      row.priced ? cell(plat(row.platIntact), 'num') : unknownCell('num'),
      row.priced ? cell(plat(row.platRadiant), 'num') : unknownCell('num'),
      row.priced ? cell(plat(row.radshare), 'num dim') : unknownCell('num dim'),
      cell(row.ducatIntact ? row.ducatIntact + 'd' : '', 'num dim', `${row.ducatRadiant}d opened radiant`),
      best,
      finishes,
      cell(ageText(row.pricedAt) || '', 'num ' + ageClass(row.pricedAt))
    );
    fragment.append(tr);
  }

  body.replaceChildren(fragment);
  declareRelicFocus(rows);
}

// What the fetcher should price for this page.
function declareRelicFocus(rows) {
  const { visible, rest } = rowsOnScreen(el('relicRows'));
  const slugs = [];
  const add = (index, withRewards) => {
    const row = rows[index];
    if (!row) return;
    if (row.slug) slugs.push(row.slug);
    if (!withRewards) return;
    for (const reward of row.rewards) if (reward.slug) slugs.push(reward.slug);
  };
  visible.forEach((index) => add(index, true));
  for (const index of rest.slice(0, 120)) add(index, false);
  declareFocus('relics', slugs);
}

let relicPending = false;
function refreshRelicPrices() {
  if (relicPending) return;
  relicPending = true;
  setTimeout(async () => {
    relicPending = false;
    if (document.getElementById('panel-relics').hidden) return;
    await loadRelics({ focus: false });
  }, REDRAW_MS);
}

async function loadRelics() {
  el('relicStatus').className = 'status';
  if (!relicView.rows.length) el('relicStatus').textContent = 'loading relic tables...';
  const result = await window.warframe.relics({});
  if (!result.ok) {
    el('relicStatus').className = 'status bad';
    el('relicStatus').textContent = result.error || 'could not build the relic list';
    return;
  }
  relicView.rows = result.rows;
  relicView.pending = Boolean(result.pending);
  relicView.partial = Boolean(result.partial);
  relicView.warning = result.warning || '';
  relicView.loaded = true;
  if (result.warning) {
    el('relicStatus').className = 'status warn';
    el('relicStatus').textContent = result.warning;
  }
  renderRelics();
}

['relicFilter'].forEach((id) => el(id).addEventListener('input', renderRelics));
['relicMine', 'relicFarmable', 'relicWanted'].forEach((id) =>
  el(id).addEventListener('change', renderRelics)
);

document.querySelectorAll('#relicGrid th[data-sort]').forEach((th) => {
  th.addEventListener('click', () => {
    const key = th.dataset.sort;
    relicView.sort.dir = relicView.sort.key === key ? -relicView.sort.dir : -1;
    relicView.sort.key = key;
    renderRelics();
  });
});


function renderOrders(orders) {
  const body = el('orderRows');
  el('orderEmpty').hidden = orders.length > 0;
  if (!orders.length) {
    el('orderEmpty').textContent = 'No live orders.';
    body.replaceChildren();
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const order of orders) {
    const tr = document.createElement('tr');
    tr.append(
      // The id is what the API returns; it is not what anyone calls the item.
      cell(order.name || order.slug || order.itemId || '', null, order.slug || undefined),
      cell(order.type, 'dim'),
      cell(order.platinum + 'p', 'num'),
      cell(order.quantity, 'num dim'),
      cell(order.rank == null ? '' : order.rank, 'num dim'),
      cell(order.visible ? 'yes' : 'hidden', order.visible ? 'dim' : 'num ahead-bad')
    );
    fragment.append(tr);
  }
  body.replaceChildren(fragment);
}

async function loadOrders() {
  el('orderCount').className = 'status';
  el('orderCount').textContent = 'loading...';
  const result = await window.warframe.myOrders();
  if (!result.ok) {
    el('orderCount').className = 'status bad';
    el('orderCount').textContent = result.error;
    renderOrders([]);
    return;
  }
  const sells = result.orders.filter((order) => order.type === 'sell').length;
  el('orderCount').textContent =
    `${result.orders.length} live \u00b7 ${sells} sell, ${result.orders.length - sells} buy`;
  renderOrders(result.orders);
}

function renderTokenStatus(status) {
  const box = el('tokenStatus');
  if (!status.hasToken) {
    box.className = 'status warn';
    box.textContent = status.error
      ? status.error
      : 'Not signed in. Prices, your orders and your online status all need an account.';
  } else if (status.valid) {
    box.className = 'status';
    box.textContent = `Signed in as ${status.name} (${status.platform || '?'})`;
  } else {
    box.className = 'status bad';
    box.textContent = status.error || 'Token rejected.';
  }
}

// Everything that was unreachable without an account, now that there is one.
async function afterSignIn() {
  await loadAccount();
  await loadOrders();
  renderFetch(await window.warframe.fetchProgress());
}

el('signInForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const email = el('signInEmail').value.trim();
  const password = el('signInPassword').value;
  if (!email || !password) return;

  el('signIn').disabled = true;
  el('tokenStatus').className = 'status';
  el('tokenStatus').textContent = 'signing in...';

  const status = await window.warframe.signIn(email, password);
  // Held only as long as the request.
  el('signInPassword').value = '';
  el('signIn').disabled = false;

  renderTokenStatus(status);
  if (status.valid) {
    el('signInEmail').value = '';
    await afterSignIn();
  }
});

el('saveToken').addEventListener('click', async () => {
  const token = el('tokenInput').value;
  el('tokenInput').value = '';
  await window.warframe.setToken(token);
  await afterSignIn();
});

el('clearToken').addEventListener('click', async () => {
  await window.warframe.setToken('');
  await loadAccount();
  renderOrders([]);
  el('orderCount').textContent = '';
  renderFetch(await window.warframe.fetchProgress());
});

el('reloadOrders').addEventListener('click', loadOrders);

document.querySelectorAll('.tab').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((other) => other.classList.remove('active'));
    button.classList.add('active');
    const name = button.dataset.tab;
    document.getElementById('panel-sets').hidden = name !== 'sets';
    document.getElementById('panel-relics').hidden = name !== 'relics';
    document.getElementById('panel-mastery').hidden = name !== 'mastery';
    document.getElementById('panel-syndicates').hidden = name !== 'syndicates';
    document.getElementById('panel-account').hidden = name !== 'account';
    if (name === 'sets') loadSets();
    if (name === 'relics') loadRelics();
    if (name === 'mastery') loadMastery();
    if (name === 'syndicates') loadVendors();
    if (name === 'account') loadOrders();
  });
});

loadAccount();
loadSets();
