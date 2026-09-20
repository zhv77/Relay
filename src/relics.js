'use strict';

// What a relic is worth opening, and what it is worth selling instead.

const { REFINEMENTS } = require('./void');
const icons = require('./icons');

const RADSHARE_PLAYERS = 4;

let store = null;
let fetcher = null;
let voidData = null;

function attach(sharedStore, sharedFetcher, sharedVoid) {
  store = sharedStore;
  fetcher = sharedFetcher;
  voidData = sharedVoid;
}

// The catalogue is the only place an icon or a ducat value lives.
function iconOf(slug) {
  return icons.iconOf(store, slug);
}

// The catalogue is the only place a ducat value lives.
let ducatsBySlug = null;
function ducatsOf(slug) {
  if (!ducatsBySlug || ducatsBySlug.size !== store.items.length) {
    ducatsBySlug = new Map();
    for (const item of store.items) ducatsBySlug.set(item.slug, item.ducats ?? 0);
  }
  return ducatsBySlug.get(slug) ?? 0;
}

// What one of these fetches if you sell it.
function platOf(slug) {
  if (!slug) return 0;
  const stats = store.stats(slug);
  const book = store.book(slug);
  const value = stats?.median7d ?? book?.buyOnline?.platinum ?? stats?.median90d ?? null;
  return value == null ? 0 : value;
}

function priced(slug) {
  if (!slug) return true; // Forma is worth nothing and always will be.
  return Boolean(store.stats(slug) || store.book(slug));
}

// Chance-weighted value of one drop at a refinement.
function expected(rewards, refinement, valueOf) {
  let total = 0;
  for (const reward of rewards) {
    const chance = reward.chances[refinement] ?? 0;
    total += (chance / 100) * valueOf(reward);
  }
  return total;
}

// Expected value of the best drop when `players` open the same relic.
function expectedBestOf(rewards, refinement, valueOf, players = RADSHARE_PLAYERS) {
  const buckets = new Map();
  for (const reward of rewards) {
    const value = valueOf(reward);
    const chance = (reward.chances[refinement] ?? 0) / 100;
    buckets.set(value, (buckets.get(value) || 0) + chance);
  }

  let total = 0;
  let cumulative = 0;
  let previous = 0;
  for (const value of [...buckets.keys()].sort((a, b) => a - b)) {
    cumulative += buckets.get(value);
    total += value * (cumulative ** players - previous ** players);
    previous = cumulative;
  }
  return total;
}

// One row per relic.
function build({ paths = {}, wanted = {}, pending = false, partial = false, warning } = {}) {
  if (!store.items.length) {
    return { ok: true, rows: [], pending, warning: 'still loading the item catalogue' };
  }
  const relics = voidData.relics || [];
  if (!relics.length) {
    return { ok: true, rows: [], pending, warning: 'still loading the relic tables' };
  }

  const rows = relics.map((relic) => {
    const owned = {};
    let total = 0;
    for (const refinement of REFINEMENTS) {
      const path = relic.paths[refinement];
      const count = path ? paths[path] ?? (partial || pending ? null : 0) : (partial || pending ? null : 0);
      owned[refinement] = count;
      total += count;
    }

    const plat = {};
    const ducats = {};
    for (const refinement of REFINEMENTS) {
      plat[refinement] = round(expected(relic.rewards, refinement, (r) => platOf(r.slug)));
      ducats[refinement] = round(expected(relic.rewards, refinement, (r) => ducatsOf(r.slug)));
    }

    const rewards = relic.rewards
      .map((reward) => ({
        name: reward.name,
        slug: reward.slug,
        icon: iconOf(reward.slug),
        rarity: reward.rarity,
        chance: reward.chances.Intact ?? 0,
        radiantChance: reward.chances.Radiant ?? reward.chances.Intact ?? 0,
        plat: round(platOf(reward.slug)),
        ducats: ducatsOf(reward.slug),
        finishes: reward.slug ? wanted[reward.slug] || null : null,
      }))
      .sort((a, b) => b.plat - a.plat);

    const relicStats = relic.slug ? store.stats(relic.slug) : null;
    const relicBid = relic.slug ? store.book(relic.slug)?.buyOnline?.platinum ?? null : null;
    let sells = null;
    let sellsBasis = null;
    if (relicStats?.median7d != null) [sells, sellsBasis] = [relicStats.median7d, 'week'];
    else if (relicBid != null) [sells, sellsBasis] = [relicBid, 'bid'];
    else if (relicStats?.median90d != null) [sells, sellsBasis] = [relicStats.median90d, 'quarter'];

    const stats = relic.slug ? store.stats(relic.slug) : null;
    const book = relic.slug ? store.book(relic.slug) : null;

    return {
      name: relic.name,
      slug: relic.slug,
      icon: iconOf(relic.slug),
      era: relic.era,
      vaulted: relic.vaulted,
      owned,
      held: total,
      unknown: Object.values(owned).some((count) => count == null),
      sells,
      sellsBasis,
      sellsVolume: relicStats?.volume90d ?? null,
      platIntact: plat.Intact,
      platRadiant: plat.Radiant,
      ducatIntact: ducats.Intact,
      ducatRadiant: ducats.Radiant,
      radshare: round(expectedBestOf(relic.rewards, 'Radiant', (r) => platOf(r.slug))),
      best: rewards[0] || null,
      finishes: rewards.filter((reward) => reward.finishes).map((reward) => reward.name),
      rewards,
      // A relic is priced when every reward that could be priced is.
      priced: relic.rewards.every((reward) => priced(reward.slug)),
      pricedAt: stats?.fetchedAt ?? book?.fetchedAt ?? null,
    };
  });

  return { ok: true, pending, partial, warning, rows, count: rows.length };
}

function round(value) {
  return Math.round(value * 10) / 10;
}

// Every slug worth pricing for these relics, the relics themselves included.
function slugsFor(names) {
  const slugs = [];
  const seen = new Set();
  const add = (slug) => {
    if (!slug || seen.has(slug)) return;
    seen.add(slug);
    slugs.push(slug);
  };
  for (const name of names) {
    const relic = voidData.get(name);
    if (!relic) continue;
    add(relic.slug);
    for (const reward of relic.rewards) add(reward.slug);
  }
  return slugs;
}

module.exports = { attach, build, slugsFor, expected, expectedBestOf };
