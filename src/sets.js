'use strict';

// Sets: what you can finish, and what finishing is worth.

let store = null;
let fetcher = null;
let voidData = null;

const icons = require('./icons');

// The catalogue already carries warframe.market's own thumbnail for every set.
function iconOf(slug) {
  return icons.iconOf(store, slug);
}

function attach(sharedStore, sharedFetcher, sharedVoid) {
  store = sharedStore;
  fetcher = sharedFetcher;
  voidData = sharedVoid;
}

let cachedMembership = null;
let cachedFor = 0;

// setSlug -> { set, parts[] }, built once per catalogue.
function membership() {
  if (cachedMembership && cachedFor === store.items.length) return cachedMembership;

  const sets = store.items.filter((item) => (item.tags || []).includes('set'));
  // Longest prefix first so the more specific set claims a part before a shorter one can.
  const prefixes = sets
    .map((set) => ({ set, prefix: set.slug.replace(/_set$/, '_') }))
    .sort((a, b) => b.prefix.length - a.prefix.length);

  const map = new Map(sets.map((set) => [set.slug, { set, parts: [] }]));
  for (const item of store.items) {
    if ((item.tags || []).includes('set')) continue;
    const owner = prefixes.find((entry) => item.slug.startsWith(entry.prefix));
    if (owner) map.get(owner.set.slug).parts.push(item);
  }

  cachedMembership = map;
  cachedFor = store.items.length;
  return map;
}

function priceOf(slug) {
  const book = store.book(slug);
  const stats = store.stats(slug);
  return {
    sell: book?.sellOnline?.platinum ?? null,
    buy: book?.buyOnline?.platinum ?? null,
    median7d: stats?.median7d ?? null,
    volume7d: stats?.volume7d ?? null,
    priced: Boolean(book || stats),
    pricedAt: book?.fetchedAt ?? stats?.fetchedAt ?? null,
  };
}

// Focus is not declared here.
// Relic name -> how many you hold, every refinement counted.
function relicsHeld(paths) {
  const held = new Map();
  if (!voidData) return held;
  for (const relic of voidData.relics || []) {
    let count = 0;
    for (const path of Object.values(relic.paths || {})) if (path) count += paths[path] || 0;
    if (count) held.set(relic.name, count);
  }
  return held;
}

function build({ owned = {}, paths = {}, pending = false, partial = false, warning } = {}) {
  const heldRelics = relicsHeld(paths);
  if (!store.items.length) {
    return { ok: true, rows: [], pending, warning: 'still loading the item catalogue' };
  }

  const rows = [];
  for (const { set, parts } of membership().values()) {
    const setPrice = priceOf(set.slug);

    const partRows = parts.map((part) => {
      const price = priceOf(part.slug);
      return {
        slug: part.slug,
        name: part.name,
        owned: owned[part.slug] ?? (partial || pending ? null : 0),
        ...price,
        cost: price.sell ?? price.median7d ?? null,
        // And what one you already hold is worth, which is not the same number.
        worth: price.median7d ?? price.buy ?? null,
        // Where it comes from, farmable relics first.
        sources: voidData
          ? voidData
              .sourcesOf(part.slug)
              .map((source) => ({ ...source, held: heldRelics.get(source.relic) || 0 }))
              .sort((a, b) =>
                (b.held ? 1 : 0) - (a.held ? 1 : 0) ||
                (a.vaulted ? 1 : 0) - (b.vaulted ? 1 : 0) ||
                b.chance - a.chance
              )
              .slice(0, 6)
          : [],
      };
    });

    // For planning, undetected parts count as missing.
    const missing = partRows.filter((part) => !part.owned);
    const notHeld = partRows;
    const held = partRows.filter((part) => part.owned > 0).length;
    const unknown = partRows.filter((part) => part.owned == null).length;

    const sum = (list) => {
      let total = 0;
      for (const part of list) {
        if (part.cost == null) return null;
        total += part.cost;
      }
      return Math.round(total);
    };

    const toFinish = pending ? null : sum(missing);
    const fromScratch = sum(partRows);

    const sells = setPrice.median7d ?? setPrice.buy ?? null;

    const inflated =
      setPrice.sell != null &&
      setPrice.median7d != null &&
      setPrice.sell > setPrice.median7d * 2;

    rows.push({
      slug: set.slug,
      icon: iconOf(set.slug),
      itemId: set.id,
      name: set.name,
      gameRef: set.gameRef,
      built: set.gameRef ? (owned[set.slug] || 0) > 0 : false,
      partCount: partRows.length,
      held,
      missingCount: pending ? null : missing.length,
      unknown,
      missing: missing.map((part) => ({
        name: part.name,
        slug: part.slug,
        cost: part.cost,
        sources: part.sources,
      })),
      // How many relics drop something you still need, and whether any of them is farmable today.
      sourceCount: (() => {
        const names = new Set();
        for (const part of notHeld) for (const source of part.sources || []) names.add(source.relic);
        return names.size;
      })(),
      farmable: notHeld.some((part) => (part.sources || []).some((source) => !source.vaulted)),
      notHeld: notHeld.map((part) => ({ name: part.name, slug: part.slug, sources: part.sources })),
      vaulted: (() => {
        const relicParts = partRows.filter((part) => (part.sources || []).length);
        if (!relicParts.length) return null;
        return relicParts.some((part) => part.sources.every((source) => source.vaulted));
      })(),
      heldWorth: (() => {
        const owned = partRows.filter((part) => part.owned > 0 && part.worth != null);
        return owned.length ? Math.round(owned.reduce((n, p) => n + p.worth, 0)) : null;
      })(),
      parts: partRows,
      setSell: setPrice.sell,
      setBuy: setPrice.buy,
      setMedian: setPrice.median7d,
      sellsFor: sells,
      inflated,
      // Six sales a week is not a market you can count on clearing into.
      thin: (setPrice.volume7d ?? 0) < 10,
      volume7d: setPrice.volume7d,
      priced: setPrice.priced,
      pricedAt: setPrice.pricedAt,
      toFinish,
      fromScratch,
      // What you make selling the finished set, having bought only what you lack.
      profitToFinish: sells != null && toFinish != null ? Math.round(sells - toFinish) : null,
      profitFromScratch:
        sells != null && fromScratch != null ? Math.round(sells - fromScratch) : null,
      unresolved: partRows.length === 0,
    });
  }

  // Nearly-finished and profitable first: that is the actionable end.
  rows.sort((a, b) => (b.profitToFinish ?? -Infinity) - (a.profitToFinish ?? -Infinity));

  return {
    ok: true,
    pending,
    partial,
    warning,
    rows,
    total: rows.length,
    unresolved: rows.filter((row) => row.unresolved).length,
    at: Date.now(),
  };
}

module.exports = { build, attach, membership };
