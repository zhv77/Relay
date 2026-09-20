'use strict';

// Vendor offering tables, read from the wiki's own data modules.

const { loads } = require('./luadata');

const WIKI = 'https://wiki.warframe.com';
const MODULE = 'Module:Vendors/data';
const AGENT = process.env.WFM_AGENT || 'Relay/0.1 (+https://github.com/zhv77/Relay)';

// Vendor stock changes when DE adds an augment, which is a few times a year.
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Normalise one `{ "Name", "Type", cost, count, Prereq = n }` row.
function offering(entry) {
  const fields = Array.isArray(entry) ? entry : entry?._array;
  if (!Array.isArray(fields) || fields.length < 3) return null;
  const [name, kind, cost] = fields;
  if (typeof name !== 'string' || typeof cost !== 'number') return null;
  const count = typeof fields[3] === 'number' ? fields[3] : 1;
  return {
    name,
    type: typeof kind === 'string' ? kind : 'Item',
    cost: Math.round(cost),
    count: Math.round(count),
    rank: Array.isArray(entry) ? null : (entry?.Prereq ?? null),
  };
}

async function fetchModule(title) {
  const url = `${WIKI}/index.php?${new URLSearchParams({ title, action: 'raw' })}`;
  const response = await fetch(url, { headers: { 'User-Agent': AGENT } });
  if (!response.ok) throw new Error(`wiki ${response.status} for ${title}`);
  return response.text();
}

async function fetchVendors() {
  const raw = loads(await fetchModule(MODULE));
  const table = raw?.Vendors;
  if (!table || typeof table !== 'object') throw new Error('no Vendors table in module');

  const vendors = {};
  for (const [key, vendor] of Object.entries(table)) {
    if (!vendor || typeof vendor !== 'object' || Array.isArray(vendor)) continue;
    const offerings = (vendor.Offerings || []).map(offering).filter(Boolean);
    // A vendor with nothing sellable is noise in a dropdown.
    if (!offerings.length) continue;
    vendors[key] = {
      key,
      name: vendor.Name || key,
      currency: vendor.Currency || '?',
      ranks: vendor.Ranks?._array || null,
      link: `${WIKI}/w/${String(vendor.Link || key).replace(/ /g, '_')}`,
      offerings,
    };
  }
  return vendors;
}

class Vendors {
  constructor(store) {
    this.store = store;
    this.vendors = {};
    this.fetchedAt = 0;
    this.error = null;
  }

  async ensure({ force = false } = {}) {
    if (!force && Object.keys(this.vendors).length && Date.now() - this.fetchedAt < TTL_MS) {
      return this.vendors;
    }
    const cached = this.store.getMeta('vendors');
    const complete =
      cached && Object.values(cached.value).some((vendor) => 'ranks' in vendor);
    if (!force && cached && complete && Date.now() - cached.at < TTL_MS) {
      this.vendors = cached.value;
      this.fetchedAt = cached.at;
      return this.vendors;
    }
    try {
      this.vendors = await fetchVendors();
      this.fetchedAt = Date.now();
      this.store.putMeta('vendors', this.vendors);
      this.error = null;
    } catch (error) {
      this.error = error.message;
      // Stale vendor data beats none: standing costs do not drift.
      if (cached) {
        this.vendors = cached.value;
        this.fetchedAt = cached.at;
      }
    }
    return this.vendors;
  }

  list() {
    return Object.values(this.vendors)
      .map(({ key, name, currency, link, ranks, offerings }) => ({
        key,
        name,
        currency,
        link,
        ranks,
        offerCount: offerings.length,
      }))
      // Standing vendors first: those are the ones worth farming for plat.
      .sort((a, b) =>
        a.currency === b.currency
          ? a.name.localeCompare(b.name)
          : (a.currency === 'Standing' ? -1 : 1) - (b.currency === 'Standing' ? -1 : 1)
      );
  }

  get(key) {
    return this.vendors[key] || null;
  }
}

module.exports = { Vendors, fetchVendors };
