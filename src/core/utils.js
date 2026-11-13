'use strict';

const path = require('path');
const os = require('os');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run async worker(items[i]) over items with bounded concurrency; returns results array. */
async function runPool(items, worker, limit) {
  const results = new Array(items.length);
  let cursor = 0;
  async function runner() {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await worker(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
  return results;
}

/** Strip trailing slashes from a base URL. */
function normUrl(url) {
  return String(url ?? '').replace(/\/+$/, '');
}

/** Absolute path to the user-level VS Code settings.json. */
function userSettingsPath() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'Code', 'User', 'settings.json');
}

module.exports = { sleep, runPool, normUrl, userSettingsPath };
