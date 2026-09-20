'use strict';

// Syndicate stock, priced from the local cache.

let store = null;
let fetcher = null;
let vendors = null;

function attach(sharedStore, sharedFetcher, sharedVendors) {
  store = sharedStore;
  fetcher = sharedFetcher;
  vendors = sharedVendors;
}

// Vendor tables name what they sell; the market knows slugs.
let byName = null;
function slugFor(name) {
  if (!byName || byName.size !== store.items.length) {
    byName = new Map();
    for (const item of store.items) {
      if (item.name) byName.set(item.name.toLowerCase(), item);
    }
  }
  return byName.get(String(name).toLowerCase()) || null;
}

async function list() {
  await vendors.ensure();
  const rows = vendors.list().map((vendor) => {
    const found = vendors.get(vendor.key);
    const tradeable = found
      ? found.offerings.filter((entry) => slugFor(entry.name)).length
      : 0;
    return { ...vendor, tradeableCount: tradeable };
  });
  return { ok: true, vendors: rows, error: vendors.error };
}

async function stock(key, { owned = {}, listings = new Map(), focus = true } = {}) {
  await vendors.ensure();
  const found = vendors.get(key);
  if (!found) return { ok: false, error: `no such vendor: ${key}`, rows: [] };

  const rows = found.offerings.map((entry) => {
    const item = slugFor(entry.name);
    const slug = item?.slug || null;
    const book = slug ? store.book(slug) : null;
    const stats = slug ? store.stats(slug) : null;
    // Rank 0 is the only rank a vendor sells, so it is the only one quoted.
    const rank0 = book?.ranks?.['0'] || {};

    const sell = book?.sellOnline?.platinum ?? rank0.sell?.platinum ?? null;
    const buy = book?.buyOnline?.platinum ?? rank0.buy?.platinum ?? null;
    const median = stats?.median7d ?? stats?.median90d ?? null;

    const unit = sell ?? median;
    const count = Math.max(1, entry.count);
    const value = unit == null ? null : Math.round(unit * count);
    const perThousand =
      value != null && entry.cost > 0 && found.currency === 'Standing'
        ? Math.round((value / entry.cost) * 1000 * 10) / 10
        : null;

    const mine = slug ? listings.get(slug) || null : null;

    return {
      name: entry.name,
      type: entry.type,
      slug,
      itemId: item?.id || null,
      tradeable: Boolean(item),
      reqRank: entry.rank,
      cost: entry.cost,
      count,
      sell,
      buy,
      median7d: stats?.median7d ?? null,
      volume7d: stats?.volume7d ?? null,
      median90d: stats?.median90d ?? null,
      sellers: book?.sellCount ?? rank0.sellCount ?? null,
      buyers: book?.buyCount ?? rank0.buyCount ?? null,
      askLadder: rank0.askLadder || [],
      askLadderAll: rank0.askLadderAll || [],
      value,
      perThousand,
      owned: slug ? owned[slug] || 0 : 0,
      listed: mine ? mine.platinum : null,
      listingId: mine ? mine.id : null,
      priced: Boolean(book || stats),
      pricedAt: book?.fetchedAt ?? stats?.fetchedAt ?? null,
    };
  });

  rows.sort((a, b) => (b.perThousand ?? -1) - (a.perThousand ?? -1));

  // Having this vendor open is the whole reason to keep its prices current.
  if (focus && fetcher) {
    fetcher.setFocus(
      `vendor:${key}`,
      rows.filter((row) => row.slug).map((row) => row.slug)
    );
  }

  return {
    ok: true,
    vendor: { key: found.key, name: found.name, currency: found.currency, link: found.link },
    rows,
    priced: rows.filter((row) => row.priced).length,
    at: Date.now(),
  };
}

module.exports = { list, stock, attach };
