'use strict';

// Riven trait base values and roll rules, from the wiki's Riven Mods page (ExportUpgrades).
// Keys are warframe.market attribute slugs. Columns follow CLASSES.

const CLASSES = ['rifle', 'shotgun', 'pistol', 'archgun', 'melee'];
// Riven types warframe.market uses that share another class's values.
const CLASS_OF = { rifle: 'rifle', shotgun: 'shotgun', pistol: 'pistol', kitgun: 'pistol', archgun: 'archgun', melee: 'melee', zaw: 'melee' };

const BASE = {
  critical_chance: [149.99, 90, 149.99, 99.9, 180],
  critical_damage: [120, 90, 90, 80.1, 90],
  'base_damage_/_melee_damage': [165, 164.7, 219.6, 99.9, 164.7],
  multishot: [90, 119.7, 119.7, 60.3, null],
  'fire_rate_/_attack_speed': [60.03, 90, 74.7, 60.03, 54.9],
  status_chance: [90, 90, 90, 60.3, 90],
  status_duration: [99.99, 99.99, 99.99, 99.99, 99.99],
  heat_damage: [90, 90, 90, 119.7, 90],
  cold_damage: [90, 90, 90, 119.7, 90],
  electric_damage: [90, 90, 90, 119.7, 90],
  toxin_damage: [90, 90, 90, 119.7, 90],
  impact_damage: [119.97, 119.97, 119.97, 90, 119.7],
  puncture_damage: [119.97, 119.97, 119.97, 90, 119.7],
  slash_damage: [119.97, 119.97, 119.97, 90, 119.7],
  damage_vs_corpus: [0.45, 0.45, 0.45, 0.45, 0.45],
  damage_vs_grineer: [0.45, 0.45, 0.45, 0.45, 0.45],
  damage_vs_infested: [0.45, 0.45, 0.45, 0.45, 0.45],
  magazine_capacity: [50, 50, 50, 60.3, null],
  reload_speed: [50, 50, 50, 99.9, null],
  ammo_maximum: [49.95, 90, 90, 99.9, null],
  punch_through: [2.7, 2.7, 2.7, 2.7, null],
  projectile_speed: [90, 90, 90, null, null],
  recoil: [90, 90, 90, 90, null],
  zoom: [59.99, null, 80.1, 59.99, null],
  range: [null, null, null, null, 1.94],
  combo_duration: [null, null, null, null, 8.1],
  channeling_damage: [null, null, null, null, 24.5],
  channeling_efficiency: [null, null, null, null, 73.44],
  finisher_damage: [null, null, null, null, 119.7],
  critical_chance_on_slide_attack: [null, null, null, null, 120],
  chance_to_gain_extra_combo_count: [null, null, null, null, 58.77],
  chance_to_gain_combo_count: [null, null, null, null, 58.77],
};

// Bonus and malus multipliers by how many positive traits and whether there is a negative.
const LAYOUT = {
  '2+0': { bonus: 0.99, malus: 0 },
  '2+1': { bonus: 1.2375, malus: 0.495 },
  '3+0': { bonus: 0.75, malus: 0 },
  '3+1': { bonus: 0.9375, malus: 0.75 },
};

// Elements and punch through only ever roll as positives; the melee combo count pair is split by direction.
const NEVER_NEGATIVE = new Set(['heat_damage', 'cold_damage', 'electric_damage', 'toxin_damage', 'punch_through',
  'chance_to_gain_extra_combo_count']);
const NEVER_POSITIVE = new Set(['chance_to_gain_combo_count']);

// Traits whose good direction is shown with a minus in game, like "-60% Weapon Recoil".
const INVERTED = new Set(['recoil']);

// General community view, used when the market has too few listings to say.
const GOOD = {
  gun: new Set(['critical_chance', 'critical_damage', 'base_damage_/_melee_damage', 'multishot', 'fire_rate_/_attack_speed',
    'status_chance', 'heat_damage', 'cold_damage', 'electric_damage', 'toxin_damage']),
  melee: new Set(['critical_chance', 'critical_damage', 'base_damage_/_melee_damage', 'fire_rate_/_attack_speed', 'range',
    'status_chance', 'heat_damage', 'cold_damage', 'electric_damage', 'toxin_damage', 'channeling_damage']),
};
const HARMLESS = {
  gun: new Set(['zoom', 'ammo_maximum', 'recoil', 'projectile_speed', 'impact_damage', 'puncture_damage', 'slash_damage',
    'damage_vs_corpus', 'damage_vs_grineer', 'damage_vs_infested']),
  melee: new Set(['chance_to_gain_combo_count', 'finisher_damage', 'critical_chance_on_slide_attack', 'impact_damage',
    'puncture_damage', 'slash_damage', 'damage_vs_corpus', 'damage_vs_grineer', 'damage_vs_infested']),
};

function base(slug, type) {
  const column = CLASSES.indexOf(CLASS_OF[type]);
  return column < 0 ? null : BASE[slug]?.[column] ?? null;
}

module.exports = { BASE, LAYOUT, NEVER_NEGATIVE, NEVER_POSITIVE, INVERTED, GOOD, HARMLESS, CLASS_OF, base };
