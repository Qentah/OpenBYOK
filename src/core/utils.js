'use strict';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run async worker(items[i]) over items with bounded concurrency; returns results array. */
async function runPool(items, worker, limit) {
  const results = new Array(items.length);
  let cursor = 0;
  async function runner() {
    while (cursor < items.length) {
      const i = cursor++;
      try {
        results[i] = await worker(items[i]);
      } catch (e) {
        results[i] = null;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
  return results;
}

/** Strip trailing slashes from a base URL. */
function normUrl(url) {
  return String(url ?? '').replace(/\/+$/, '');
}

module.exports = { sleep, runPool, normUrl };
