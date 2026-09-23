'use strict';

// Matches a riven read off the screen to warframe.market, grades its traits and prices it.

const market = require('./market');
const traits = require('./riven-traits');
const dispositions = require('./riven-dispositions');

const CATALOGUE_MS = 24 * 60 * 60 * 1000;
const LISTINGS_MS = 5 * 60 * 1000;
// Below this many listings the market says too little about which traits people want.
const ENOUGH_LISTINGS = 20;

// In-game names that differ from warframe.market's.
const ALIASES = {
  'fire rate': 'fire_rate_/_attack_speed',
  'attack speed': 'fire_rate_/_attack_speed',
  'melee damage': 'base_damage_/_melee_damage',
  'projectile speed': 'projectile_speed',
  'initial combo': 'channeling_damage',
};

let catalogue = null;
const listings = new Map();

async function load() {
  if (catalogue && Date.now() - catalogue.at < CATALOGUE_MS) return catalogue;
  const [weapons, attributes] = await Promise.all([market.rivenWeapons(), market.rivenAttributes()]);
  const names = new Map(attributes.map((a) => [a.name.toLowerCase(), a.slug]));
  for (const [alias, slug] of Object.entries(ALIASES)) names.set(alias, slug);
  // Longest first, so "Dual Toxocyst" wins over a shorter name it starts with.
  weapons.sort((a, b) => b.name.length - a.name.length);
  const bySlug = new Map(attributes.map((a) => [a.slug, a]));
  catalogue = { at: Date.now(), weapons, names, bySlug };
  return catalogue;
}

function auctions(weapon, positives) {
  const key = `${weapon}|${[...positives].sort().join(',')}`;
  let entry = listings.get(key);
  if (!entry || Date.now() - entry.at > LISTINGS_MS) {
    entry = { at: Date.now(), promise: market.rivenAuctions(weapon, positives) };
    entry.promise.catch(() => listings.delete(key));
    listings.set(key, entry);
  }
  return entry.promise;
}

// Exact name, else the longest known name the text starts with, so OCR extras like "Damaged" still match.
function match(text, names) {
  if (names.has(text)) return names.get(text);
  let best = null;
  for (const [name, slug] of names) {
    if (text.startsWith(name + ' ') || (text.startsWith(name) && text.length - name.length <= 2)) {
      if (!best || name.length > best.name.length) best = { name, slug };
    }
  }
  return best?.slug ?? null;
}

// "+110.7% Critical Chance" -> { slug, size, positive }; null for stats the market doesn't know yet.
function stat(text, names) {
  const m = text.match(/^([+\-x?])(\d+(?:\.\d+)?)[%sm]?\s+(.+)$/);
  if (!m) return null;
  const slug = match(m[3].toLowerCase(), names);
  if (!slug) return null;
  const value = Number(m[2]);
  if (m[1] === 'x') return { slug, size: Math.abs(value - 1), positive: value >= 1 };
  const minus = m[1] === '-';
  return { slug, size: value, positive: traits.INVERTED.has(slug) ? minus : !minus };
}

// Lowest and highest a trait can roll on this riven, as a size (faction traits: distance from x1).
function range(slug, type, disposition, multiplier) {
  const value = traits.base(slug, type);
  if (value == null || !multiplier) return null;
  return { low: value * disposition * multiplier * 0.9, high: value * disposition * multiplier * 1.1 };
}

// How often each trait shows up on the pricier half of a weapon's listings.
function demand(found) {
  const cut = market.median(found.map((a) => a.price).filter((p) => p > 0)) ?? 0;
  const pricey = found.filter((a) => a.price >= cut);
  const share = (slug, positive) =>
    pricey.length ? pricey.filter((a) => a.stats.some((s) => s.slug === slug && s.positive === positive)).length / pricey.length : 0;
  const top = Math.max(...Object.keys(traits.BASE).map((slug) => share(slug, true)), 0.01);
  // Compared with the weapon's most wanted trait, since a riven only has room for two or three.
  return { enough: found.length >= ENOUGH_LISTINGS, share, relative: (slug) => share(slug, true) / top };
}

// Rating 0 (rarely wanted) to 3 (sought after), and whether the trait is fine as the negative.
function judge(slug, family, wanted) {
  const harmless = traits.HARMLESS[family].has(slug);
  if (!wanted.enough) return { rating: traits.GOOD[family].has(slug) ? 2 : 0, harmless };
  const share = wanted.relative(slug);
  return {
    rating: share >= 0.6 ? 3 : share >= 0.35 ? 2 : share >= 0.15 ? 1 : 0,
    harmless: harmless || wanted.share(slug, false) >= 0.1,
  };
}

// Ways to choose k of n, as a float; only ever small numbers here.
function choose(n, k) {
  if (k < 0 || k > n) return 0;
  let result = 1;
  for (let i = 0; i < k; i++) result = (result * (n - i)) / (i + 1);
  return result;
}

// Chance per cycle of ending up with the anchor trait plus another, with and without locking the anchor.
// Positives are drawn evenly from the pool. Locked, the anchor stays and the layout is fixed, so the other
// positive slots are drawn from the rest. Unlocked, the layout is re-rolled too, each layout assumed equally likely.
function outlook(slugs, drawn, cost) {
  const eligible = slugs.filter((slug) => !traits.NEVER_POSITIVE.has(slug));
  const n = eligible.length;
  const positives = drawn.filter((d) => d.positive);
  const lockedTrait = drawn.find((d) => d.locked && !d.unknown);
  const anchor = lockedTrait?.positive ? lockedTrait
    : lockedTrait ? null
    : [...positives].filter((d) => !d.unknown).sort((a, b) => b.rating - a.rating || (b.roll ?? 0) - (a.roll ?? 0))[0];
  if (!anchor) return null;

  const k = positives.length;
  const layouts = [2, 3];
  const unlocked = (fn) => layouts.reduce((sum, size) => sum + fn(size), 0) / layouts.length;
  // Both the anchor and one given trait among the positives.
  const pair = {
    locked: (k - 1) / (n - 1),
    unlocked: unlocked((size) => (size * (size - 1)) / (n * (n - 1))),
  };
  const isLocked = Boolean(lockedTrait);
  // Chance a trait, or at least one of a group, is a positive on the next roll, as things stand now.
  const rollable = (slug) => eligible.includes(slug) && !(isLocked && slug === anchor.slug);
  const roll = (slug) => {
    if (isLocked && slug === anchor.slug) return 1;
    if (!rollable(slug)) return 0;
    return isLocked ? (k - 1) / (n - 1) : unlocked((size) => size / n);
  };
  const rollGroup = (group) => {
    const g = group.filter(rollable).length;
    return isLocked
      ? 1 - choose(n - 1 - g, k - 1) / choose(n - 1, k - 1)
      : unlocked((size) => 1 - choose(n - g, size) / choose(n, size));
  };
  return {
    anchor: { slug: anchor.slug, text: anchor.text, locked: isLocked },
    layout: `${k} positive${drawn.some((d) => d.positive === false) ? ', 1 negative' : ''}`,
    open: k - 1,
    // Traits a positive slot can draw from.
    eligible: n,
    pair: (slug) => (slug === anchor.slug || !eligible.includes(slug) ? null : pair),
    rollable,
    roll,
    rollGroup,
    // The button shows the cost for the current state; a lock doubles it.
    cost: cost ? { locked: isLocked ? cost : cost * 2, unlocked: isLocked ? cost / 2 : cost } : null,
  };
}

async function analyse(riven) {
  const { weapons, names, bySlug } = await load();
  const lower = riven.name.toLowerCase();
  const weapon = weapons.find((w) => lower.startsWith(w.name.toLowerCase() + ' '));
  if (!weapon) return { error: `unknown weapon in "${riven.name}"` };

  // Variants like Kuva Ogris share the riven but not the disposition, so the "Fits in" weapon decides it.
  const fits = riven.fitsIn && Object.keys(dispositions).find((name) => name.toLowerCase() === riven.fitsIn.toLowerCase());
  const variant = fits || weapon.name;
  const disposition = dispositions[variant] ?? weapon.disposition;
  const family = traits.CLASS_OF[weapon.type] === 'melee' ? 'melee' : 'gun';

  const read = riven.stats.map((s) => ({ ...s, parsed: stat(s.text, names) }));
  const positives = read.filter((s) => s.parsed?.positive).map((s) => s.parsed.slug);
  const negatives = read.filter((s) => s.parsed && !s.parsed.positive).length;
  const layout = traits.LAYOUT[`${positives.length}+${negatives}`];

  const wanted = demand(await auctions(weapon.slug, []));

  const drawn = read.map((s) => {
    if (!s.parsed) return { text: s.text, locked: s.locked, unknown: true };
    const { slug, size, positive } = s.parsed;
    const span = layout && range(slug, weapon.type, disposition, positive ? layout.bonus : layout.malus);
    const roll = span ? Math.min(1, Math.max(0, (size - span.low) / (span.high - span.low))) : null;
    return { text: s.text, locked: s.locked, slug, positive, roll, ...judge(slug, family, wanted) };
  });

  // Every trait this weapon class can roll, with its range for this riven's layout.
  const slugs = Object.keys(traits.BASE).filter((slug) => traits.base(slug, weapon.type) != null);
  const chances = outlook(slugs, drawn, riven.cost);
  const pool = slugs.map((slug) => {
    const attribute = bySlug.get(slug);
    const hit = drawn.find((d) => d.slug === slug);
    return {
      slug,
      name: attribute?.name || slug,
      unit: attribute?.unit || null,
      good: layout ? range(slug, weapon.type, disposition, layout.bonus) : null,
      bad: layout?.malus && !traits.NEVER_NEGATIVE.has(slug) ? range(slug, weapon.type, disposition, layout.malus) : null,
      canBeNegative: !traits.NEVER_NEGATIVE.has(slug),
      drawn: hit ? { positive: hit.positive, roll: hit.roll, locked: hit.locked } : null,
      chance: chances?.pair(slug) ?? null,
      next: chances ? chances.roll(slug) : null,
      ...judge(slug, family, wanted),
    };
  }).sort((a, b) => b.rating - a.rating || a.name.localeCompare(b.name));

  return {
    weapon: weapon.name,
    variant,
    disposition,
    layout: layout ? `${positives.length} positive${negatives ? ', 1 negative' : ''}` : null,
    fromMarket: wanted.enough,
    drawn,
    pool,
    // Per-slot odds for the next cycle, with the lock or with the best trait as the one to keep.
    outlook: chances && {
      anchor: chances.anchor, layout: chances.layout, open: chances.open, cost: chances.cost, eligible: chances.eligible,
      // Traits the open slots can draw from, when locked.
      choices: pool.filter((t) => t.chance).length,
      // The anchor plus at least one trait from each rating.
      byRating: [3, 2, 1, 0].map((rating) => {
        const group = pool.filter((t) => t.rating === rating).map((t) => t.slug);
        return { rating, count: group.filter(chances.rollable).length, next: chances.rollGroup(group) };
      }),
    },
    grade: grade(drawn),
  };
}

// A word for the trait choice and an average for how high the values rolled.
function grade(drawn) {
  const known = drawn.filter((d) => !d.unknown);
  const good = known.filter((d) => d.positive);
  if (!good.length) return null;
  const average = good.reduce((sum, d) => sum + d.rating, 0) / good.length;
  const hurts = known.some((d) => !d.positive && !d.harmless);
  const rolled = known.filter((d) => d.roll != null);
  return {
    traits: average >= 2.5 && !hurts ? 'Great' : average >= 1.75 && !hurts ? 'Good' : average >= 1 ? 'Mixed' : 'Weak',
    rolls: rolled.length ? Math.round((rolled.reduce((sum, d) => sum + d.roll, 0) / rolled.length) * 100) : null,
  };
}

module.exports = { analyse };
