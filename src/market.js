'use strict';

// warframe.market, fetched by each client for itself.

const RATE = Number(process.env.WFM_RATE || 3); // requests per second
const AGENT =
  process.env.WFM_AGENT || 'Relay/0.1 (+https://github.com/zhv77/Relay)';
const BASE = 'https://api.warframe.market';

// A token bucket shared by everything in the process.
class Limiter {
  constructor(rate = RATE) {
    this.rate = rate;
    this.allowance = rate;
    this.last = Date.now();
    this.spent = 0;
  }

  async take() {
    for (;;) {
      const now = Date.now();
      this.allowance = Math.min(this.rate, this.allowance + ((now - this.last) / 1000) * this.rate);
      this.last = now;
      if (this.allowance >= 1) {
        this.allowance -= 1;
        this.spent += 1;
        return;
      }
      const needed = ((1 - this.allowance) / this.rate) * 1000;
      await new Promise((resolve) => setTimeout(resolve, Math.max(15, needed)));
    }
  }
}

const limiter = new Limiter();

// Supplied by the app once an account exists.
let tokenSource = () => null;

function useToken(source) {
  tokenSource = typeof source === 'function' ? source : () => source;
}

function hasToken() {
  return Boolean(tokenSource());
}

class NoTokenError extends Error {
  constructor() {
    super('no warframe.market token - sign in on the Account tab');
    this.name = 'NoTokenError';
    this.needsToken = true;
  }
}

async function request(pathname, { retries = 2 } = {}) {
  const token = tokenSource();
  if (!token) throw new NoTokenError();

  for (let attempt = 0; ; attempt += 1) {
    await limiter.take();
    let response;
    try {
      response = await fetch(BASE + pathname, {
        headers: {
          'User-Agent': AGENT,
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
        },
      });
    } catch (error) {
      if (attempt >= retries) throw new Error(`network: ${error.message}`);
      await wait(500 * 2 ** attempt);
      continue;
    }

    if (response.status === 429) {
      const after = Number(response.headers.get('retry-after') || 0);
      await wait((after || 2 ** attempt) * 1000);
      if (attempt >= retries) throw new Error('rate limited');
      continue;
    }
    if (response.status >= 500) {
      if (attempt >= retries) throw new Error(`upstream ${response.status}`);
      await wait(500 * 2 ** attempt);
      continue;
    }
    if (response.status === 401 || response.status === 403) {
      const rejected = new Error('token rejected - sign in again and copy a fresh one');
      rejected.tokenRejected = true;
      throw rejected;
    }
    if (!response.ok) throw new Error(`${response.status} for ${pathname}`);
    return response.json();
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The whole item catalogue. One request, and it rarely changes.
async function items() {
  const body = await request('/v2/items');
  return (body.data || []).map((item) => ({
    slug: item.slug,
    id: item.id,
    name: item.i18n?.en?.name || item.slug,
    tags: item.tags || [],
    gameRef: item.gameRef || null,
    // The thumbnail warframe.market itself uses, as a path under https://warframe.market/static/assets/.
    thumb: item.i18n?.en?.thumb || null,
    // What Baro pays for it.
    ducats: item.ducats ?? null,
  }));
}

const isOnline = (order) => order.user?.status === 'ingame' || order.user?.status === 'online';

// The order book for one item, reduced to what the app reads.
async function book(slug) {
  const body = await request(`/v2/orders/item/${slug}`);
  const orders = body.data || [];
  const ranks = {};
  for (const rank of new Set(orders.map((o) => o.rank ?? 0))) {
    const atRank = orders.filter((o) => (o.rank ?? 0) === rank);
    const sells = atRank.filter((o) => o.type === 'sell');
    const buys = atRank.filter((o) => o.type === 'buy');
    const liveSells = sells.filter(isOnline);
    const liveBuys = buys.filter(isOnline);
    ranks[rank] = {
      sell: best(liveSells, 'sell'),
      buy: best(liveBuys, 'buy'),
      sellers: top(liveSells, 'sell'),
      buyers: top(liveBuys, 'buy'),
      sellCount: liveSells.length,
      buyCount: liveBuys.length,
      askLadder: liveSells.map((o) => o.platinum).sort((a, b) => a - b).slice(0, 100),
      askLadderAll: sells.map((o) => o.platinum).sort((a, b) => a - b).slice(0, 100),
    };
  }
  const rank0 = ranks[0] || {};
  return {
    slug,
    ranks,
    sellOnline: rank0.sell ?? null,
    buyOnline: rank0.buy ?? null,
    sellersOnline: rank0.sellers ?? [],
    sellCount: rank0.sellCount ?? 0,
    buyCount: rank0.buyCount ?? 0,
  };
}

function pick(order) {
  return {
    platinum: order.platinum,
    quantity: order.quantity,
    rank: order.rank ?? null,
    user: order.user?.ingameName || null,
    status: order.user?.status || null,
  };
}

function best(orders, type) {
  if (!orders.length) return null;
  const sorted = [...orders].sort((a, b) =>
    type === 'sell' ? a.platinum - b.platinum : b.platinum - a.platinum
  );
  return pick(sorted[0]);
}

function top(orders, type, count = 3) {
  return [...orders]
    .sort((a, b) => (type === 'sell' ? a.platinum - b.platinum : b.platinum - a.platinum))
    .slice(0, count)
    .map(pick);
}

// Closed-sale statistics: what an item actually trades at.
async function stats(slug) {
  const body = await request(`/v1/items/${slug}/statistics`);
  const closed = body.payload?.statistics_closed || {};
  const week = closed['48hours'] || [];
  const quarter = closed['90days'] || [];
  const unranked = (rows) => rows.filter((row) => (row.mod_rank ?? 0) === 0);
  return {
    slug,
    median7d: median(unranked(week).map((r) => r.median)),
    volume7d: sum(unranked(week).map((r) => r.volume)),
    median90d: median(unranked(quarter).map((r) => r.median)),
    volume90d: sum(unranked(quarter).map((r) => r.volume)),
    mixedRanks: week.some((row) => (row.mod_rank ?? 0) > 0),
  };
}

// Weapons that take rivens, with disposition.
async function rivenWeapons() {
  const body = await request('/v2/riven/weapons');
  return (body.data || []).map((w) => ({
    slug: w.slug, name: w.i18n?.en?.name || w.slug, type: w.rivenType, disposition: w.disposition,
  }));
}

// Riven stats with their in-game names.
async function rivenAttributes() {
  const body = await request('/v2/riven/attributes');
  return (body.data || []).map((a) => ({ slug: a.slug, name: a.i18n?.en?.name || a.slug, unit: a.unit || null }));
}

// Buyout riven auctions for a weapon that have all the given positive stats, cheapest first.
async function rivenAuctions(weapon, positives) {
  const query = new URLSearchParams({ type: 'riven', weapon_url_name: weapon, buyout_policy: 'direct', sort_by: 'price_asc' });
  if (positives.length) query.set('positive_stats', positives.join(','));
  const body = await request(`/v1/auctions/search?${query}`);
  return (body.payload?.auctions || []).filter((a) => a.visible && !a.closed).map((a) => ({
    price: a.buyout_price,
    online: a.owner?.status === 'ingame' || a.owner?.status === 'online',
    seller: a.owner?.ingame_name,
    rank: a.item.mod_rank,
    rerolls: a.item.re_rolls,
    stats: a.item.attributes.map((s) => ({ slug: s.url_name, value: s.value, positive: s.positive })),
  }));
}

function median(values) {
  const list = values.filter((v) => typeof v === 'number').sort((a, b) => a - b);
  if (!list.length) return null;
  const middle = Math.floor(list.length / 2);
  return list.length % 2 ? list[middle] : (list[middle - 1] + list[middle]) / 2;
}

function sum(values) {
  return values.reduce((total, value) => total + (value || 0), 0);
}

const ICONS = 'https://warframe.market/static/assets/';

module.exports = { items, book, stats, rivenWeapons, rivenAttributes, rivenAuctions, median, limiter, ICONS, useToken, hasToken, NoTokenError, AGENT, RATE };
