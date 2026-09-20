'use strict';

// Spends the request budget on whatever is being looked at.

const market = require('./market');

const MINUTE = 60 * 1000;

// What "fresh" means for something you are looking at.
const FOCUS_FRESH_MS = Number(process.env.WFT_FOCUS_MS || 2 * MINUTE);

// The background sweep, by how much an item trades.
const TIERS = [
  { atLeast: 100, every: 10 * MINUTE },
  { atLeast: 5, every: 60 * MINUTE },
  { atLeast: 1, every: 6 * 60 * MINUTE },
  { atLeast: 0, every: 24 * 60 * MINUTE },
];

// Closed sales over seven and ninety days move in days, not minutes.
const STATS_MS = Number(process.env.WFT_STATS_MS || 24 * 60 * MINUTE);

function tierFor(volume) {
  const amount = volume ?? 0;
  return TIERS.find((tier) => amount >= tier.atLeast) || TIERS[TIERS.length - 1];
}

class Fetcher {
  constructor(store, { onProgress } = {}) {
    this.store = store;
    this.onProgress = onProgress || (() => {});
    this.focus = { key: null, slugs: [] };
    this.running = false;
    this.stopping = false;
    this.state = {
      fetched: 0,
      failed: 0,
      lastError: null,
      current: null,
      needsToken: !market.hasToken(),
    };
  }

  // Declare what is on screen.
  setFocus(key, slugs) {
    this.focus = { key, slugs: [...new Set(slugs.filter(Boolean))] };
    this.report();
  }

  // How complete the focused view is, which is what the progress bar shows.
  progress() {
    const { slugs } = this.focus;
    let missing = 0;
    let stale = 0;
    for (const slug of slugs) {
      const age = this.store.bookAge(slug);
      if (age === Infinity) missing += 1;
      else if (age > FOCUS_FRESH_MS) stale += 1;
    }
    return {
      key: this.focus.key,
      total: slugs.length,
      missing,
      stale,
      fresh: slugs.length - missing - stale,
      needsToken: this.state.needsToken,
      working: this.running && Boolean(this.state.current),
      current: this.state.current,
      fetched: this.state.fetched,
      failed: this.state.failed,
      error: this.state.lastError,
      rate: market.limiter.rate,
    };
  }

  report() {
    this.onProgress(this.progress());
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.stopping = false;
    this.loop().catch((error) => {
      this.state.lastError = error.message;
      this.running = false;
    });
  }

  stop() {
    this.stopping = true;
  }

  // What to fetch next, or null when everything is inside its budget.
  next() {
    const { slugs } = this.focus;

    for (const slug of slugs) {
      const age = this.store.bookAge(slug);
      if (age === Infinity) return { slug, reason: 'focus-missing' };
      if (age > FOCUS_FRESH_MS) return { slug, reason: 'focus-stale' };
    }

    // Nothing on screen needs anything.
    let worst = null;
    for (const item of this.store.items) {
      const age = this.store.bookAge(item.slug);
      const ratio = age / tierFor(this.store.volume(item.slug)).every;
      if (ratio >= 1 && (!worst || ratio > worst.ratio)) worst = { slug: item.slug, ratio };
    }
    if (worst) return { slug: worst.slug, reason: 'sweep' };

    return null;
  }

  async fetchOne(slug) {
    const needStats = this.store.statsAge(slug) > STATS_MS;
    const [book, stats] = await Promise.all([
      market.book(slug).catch((error) => ({ error })),
      needStats ? market.stats(slug).catch((error) => ({ error })) : Promise.resolve(null),
    ]);
    const now = Date.now();
    if (!book.error) this.store.putBook(slug, book, now);
    if (stats && !stats.error) this.store.putStats(slug, stats, now);
    if (book.error) throw book.error;
  }

  async loop() {
    while (!this.stopping) {
      // No token, no budget.
      if (!market.hasToken()) {
        if (!this.state.needsToken) {
          this.state.needsToken = true;
          this.state.current = null;
          this.report();
        }
        await wait(2_000);
        continue;
      }
      if (this.state.needsToken) {
        this.state.needsToken = false;
        this.report();
      }

      const job = this.next();
      if (!job) {
        // Everything is inside its budget.
        this.state.current = null;
        this.report();
        await wait(5_000);
        continue;
      }

      this.state.current = job.slug;
      try {
        await this.fetchOne(job.slug);
        this.state.fetched += 1;
        this.state.lastError = null;
      } catch (error) {
        this.state.failed += 1;
        this.state.lastError = `${job.slug}: ${error.message}`;
        if (error.tokenRejected) {
          this.state.lastError = error.message;
          this.report();
          await wait(30_000);
          continue;
        }
        // Record the attempt so a permanently broken slug cannot pin the queue to itself forever.
        this.store.putBook(job.slug, { slug: job.slug, unavailable: true });
      }
      this.report();
    }
    this.running = false;
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { Fetcher, FOCUS_FRESH_MS, TIERS, STATS_MS };
