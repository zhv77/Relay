'use strict';

// An item's picture, from warframe.market's own thumbnails.

const { ICONS } = require('./market');

let bySlug = null;
let builtFor = null;

function index(store) {
  if (bySlug && builtFor === store.items) return bySlug;
  bySlug = new Map();
  for (const item of store.items) if (item.thumb) bySlug.set(item.slug, ICONS + item.thumb);
  builtFor = store.items;
  return bySlug;
}

function iconOf(store, slug) {
  if (!slug) return null;
  const icons = index(store);
  if (icons.has(slug)) return icons.get(slug);

  const words = slug.split('_');
  for (let length = words.length - 1; length >= 1; length -= 1) {
    const set = `${words.slice(0, length).join('_')}_set`;
    if (icons.has(set)) return icons.get(set);
  }
  return null;
}

module.exports = { iconOf };
