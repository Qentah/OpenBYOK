'use strict';

const fs = require('fs');
const { CACHE_FILE, CACHE_MAX_AGE_MS } = require('../constants');

let cache = null; // { timestamp, results[] }

function load() {
  try {
    const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (data?.timestamp && Array.isArray(data.results)) {
      cache = data;
      return data;
    }
  } catch {}
  cache = null;
  return null;
}

function save(results) {
  cache = { timestamp: Date.now(), results };
  try {
    const tmp = CACHE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
    try { fs.chmodSync(tmp, 0o600); } catch {}
    fs.renameSync(tmp, CACHE_FILE);
  } catch {}
}

function isFresh() {
  return !!cache?.timestamp && Date.now() - cache.timestamp < CACHE_MAX_AGE_MS;
}

function ageLabel() {
  if (!cache?.timestamp) return 'no cache';
  return `${Math.round((Date.now() - cache.timestamp) / 3600000)}h ago`;
}

function getEntry(key) {
  return cache?.results?.find((r) => r.key === key) ?? null;
}

function fastestModel() {
  // Delegate to the single model-selection implementation (model-resolver).
  // Kept here for backward compat; new code should call model-resolver directly.
  try {
    const mr = require('./model-resolver');
    const r = mr.bestCachedModel({ sortBy: 'spd' });
    if (!r) return null;
    return { baseURL: r.baseURL, modelID: r.modelID, name: r.name, spd: r.spd };
  } catch {
    const valid = (cache?.results || [])
      .filter((r) => r?.baseURL && r?.modelID)
      .sort((a, b) => (a.spd ?? Infinity) - (b.spd ?? Infinity));
    if (!valid[0]) return null;
    return { baseURL: valid[0].baseURL, modelID: valid[0].modelID, name: valid[0].name || valid[0].modelID, spd: valid[0].spd };
  }
}

function clear() {
  cache = null;
  try { fs.unlinkSync(CACHE_FILE); } catch {}
}

function data() { return cache; }

module.exports = { load, save, isFresh, ageLabel, getEntry, fastestModel, clear, data };
