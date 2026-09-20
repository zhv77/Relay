'use strict';

// What you own, joined to what it is worth.

const scanner = require('./scanner');
const path = require('node:path');
const { InventorySnapshot } = require('./inventory-snapshot');

let store = null;
let fetcher = null;
let snapshots = null;

function attach(sharedStore, sharedFetcher) {
  store = sharedStore;
  fetcher = sharedFetcher;
  snapshots = new InventorySnapshot(store, [
    path.join(__dirname, '..', 'probe', 'dumps', 'capture.json'),
    path.join(__dirname, '..', 'probe', 'dumps', 'entries.json'),
  ]);
}

// A readable name from a path, for items the market does not list.
function leafName(path) {
  const leaf = path.split('/').pop() || path;
  return leaf.replace(/([a-z\d])([A-Z])/g, '$1 $2');
}

async function read({ focus = false } = {}) {
  let scanned;
  try {
    scanned = await scanner.scan();
  } catch (error) {
    scanned = { ok: false, error: error.message };
  }
  const snapshot = snapshots.update(scanned);
  if (!snapshot) return { ok: false, partial: true, error: scanned.error || 'No intact inventory records found. Waiting for a login or sync.', rows: [] };
  const held = { ...scanned, ...snapshot };
  const age = snapshot.at ? new Date(snapshot.at).toLocaleString() : 'an unknown time';
  const warning = `${snapshot.stale ? 'Saved' : 'Recovered'} inventory from ${age}: ${snapshot.count} item types. ` +
    'Completeness is unverified; missing items are unknown and quantities may be old.' +
    (snapshot.latestConflicts ? ` ${snapshot.latestConflicts} quantities could not be resolved in the latest scan.` : '') +
    (snapshot.scanError ? ` ${snapshot.scanError}.` : '');
  const quality = { paths: snapshot.items, heldAt: snapshot.at, partial: true, stale: snapshot.stale,
    completeness: snapshot.completeness, source: snapshot.source, sawCount: snapshot.sawCount,
    conflictingItems: snapshot.latestConflicts, warning };

  const catalogue = new Map();
  for (const item of store.items) {
    if (item.gameRef) catalogue.set(item.gameRef, item);
  }

  if (!catalogue.size) {
    // The catalogue has not arrived yet.
    const rows = Object.entries(held.items)
      .map(([path, count]) => ({ path, count, name: leafName(path), slug: null, value: null }))
      .sort((a, b) => b.count - a.count);
    return {
      ok: true,
      ...quality,
      warning: warning + ' Still loading the item catalogue.',
      rows,
      items: held.count,
      tradeable: 0,
      readMs: held.tookMs,
      at: Date.now(),
    };
  }

  const rows = [];
  for (const [path, count] of Object.entries(held.items)) {
    const listing = catalogue.get(path);
    if (!listing) continue;

    const book = store.book(listing.slug);
    const stats = store.stats(listing.slug);
    const sell = book?.sellOnline?.platinum ?? null;
    const buy = book?.buyOnline?.platinum ?? null;
    const unit = sell ?? stats?.median7d ?? null;

    rows.push({
      path,
      count,
      slug: listing.slug,
      itemId: listing.id,
      name: listing.name,
      sell,
      buy,
      median7d: stats?.median7d ?? null,
      volume7d: stats?.volume7d ?? null,
      sellers: book?.sellCount ?? null,
      buyers: book?.buyCount ?? null,
      value: unit == null ? null : Math.round(unit * count),
      priced: Boolean(book || stats),
      pricedAt: book?.fetchedAt ?? stats?.fetchedAt ?? null,
    });
  }

  rows.sort((a, b) => (b.value ?? -1) - (a.value ?? -1));

  if (focus && fetcher) {
    fetcher.setFocus('holdings', rows.map((row) => row.slug));
  }

  return {
    ok: true,
    rows,
    // The raw path counts ride along.
    paths: held.items,
    items: held.count,
    tradeable: rows.length,
    unpriced: rows.filter((row) => !row.priced).length,
    readMs: held.tookMs,
    ...quality,
    at: Date.now(),
  };
}

module.exports = { read, attach };
