'use strict';

// Relic reward tables.

const SOURCE =
  'https://raw.githubusercontent.com/WFCD/warframe-items/master/data/json/Relics.json';
const AGENT = process.env.WFM_AGENT || 'Relay/0.1 (+https://github.com/zhv77/Relay)';

// Reward tables change when DE vaults or unvaults, a few times a year.
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

const REFINEMENTS = ['Intact', 'Exceptional', 'Flawless', 'Radiant'];

// "Lith A1 Radiant" -> { base: "Lith A1", refinement: "Radiant" }.
function split(name) {
  const at = name.lastIndexOf(' ');
  if (at < 0) return null;
  const refinement = name.slice(at + 1);
  if (!REFINEMENTS.includes(refinement)) return null;
  return { base: name.slice(0, at), refinement };
}

// The reward table, keyed by relic name.
function condense(entries) {
  const relics = new Map();

  for (const entry of entries) {
    if (entry.category !== 'Relics' && entry.type !== 'Relic') continue;
    const parts = split(entry.name || '');
    if (!parts) continue;

    let relic = relics.get(parts.base);
    if (!relic) {
      relic = {
        name: parts.base,
        era: parts.base.split(' ')[0],
        vaulted: Boolean(entry.vaulted),
        slug: entry.marketInfo?.urlName || null,
        paths: {},
        rewards: [],
      };
      relics.set(parts.base, relic);
    }
    relic.paths[parts.refinement] = entry.uniqueName || null;

    for (const reward of entry.rewards || []) {
      const item = reward.item || {};
      const slug = item.warframeMarket?.urlName || null;
      const key = slug || item.name;
      if (!key) continue;

      let existing = relic.rewards.find((r) => (r.slug || r.name) === key);
      if (!existing) {
        existing = {
          name: item.name || key,
          slug,
          path: item.uniqueName || null,
          rarity: reward.rarity || null,
          chances: {},
        };
        relic.rewards.push(existing);
      }
      existing.chances[parts.refinement] = reward.chance ?? 0;
    }
  }

  return [...relics.values()];
}

class Void {
  constructor(store) {
    this.store = store;
    this.relics = [];
    this.fetchedAt = 0;
    this.error = null;
    this.byName = new Map();
    // Reward slug -> the relics that drop it.
    this.bySlug = new Map();
  }

  index() {
    this.byName = new Map();
    this.bySlug = new Map();
    for (const relic of this.relics) {
      this.byName.set(relic.name, relic);
      for (const reward of relic.rewards) {
        if (!reward.slug) continue;
        const list = this.bySlug.get(reward.slug) || [];
        list.push({
          relic: relic.name,
          era: relic.era,
          vaulted: relic.vaulted,
          chance: reward.chances.Intact ?? 0,
          rarity: reward.rarity,
        });
        this.bySlug.set(reward.slug, list);
      }
    }
    for (const list of this.bySlug.values()) {
      list.sort((a, b) => (a.vaulted ? 1 : 0) - (b.vaulted ? 1 : 0) || b.chance - a.chance);
    }
  }

  async ensure({ force = false } = {}) {
    if (!force && this.relics.length && Date.now() - this.fetchedAt < TTL_MS) {
      return this.relics;
    }

    const cached = this.store.getMeta('relics');
    if (!force && cached && Date.now() - cached.at < TTL_MS) {
      this.relics = cached.value;
      this.fetchedAt = cached.at;
      this.index();
      return this.relics;
    }

    try {
      const response = await fetch(SOURCE, { headers: { 'User-Agent': AGENT } });
      if (!response.ok) throw new Error(`relic data ${response.status}`);
      this.relics = condense(await response.json());
      this.fetchedAt = Date.now();
      this.store.putMeta('relics', this.relics);
      this.error = null;
    } catch (error) {
      this.error = error.message;
      if (cached) {
        this.relics = cached.value;
        this.fetchedAt = cached.at;
      }
    }

    this.index();
    return this.relics;
  }

  // Which relics drop this item, farmable ones first.
  sourcesOf(slug) {
    return this.bySlug.get(slug) || [];
  }

  get(name) {
    return this.byName.get(name) || null;
  }
}

module.exports = { Void, condense, REFINEMENTS };
