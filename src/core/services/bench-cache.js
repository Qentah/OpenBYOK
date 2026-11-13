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
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2)); } catch {}
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
  const valid = (cache?.results || [])
    .filter((r) => r?.baseURL && r?.modelID)
    .sort((a, b) => ((b.tokensPerSec ?? 0) - (a.tokensPerSec ?? 0)) ||
      ((a.ttftMs ?? Infinity) - (b.ttftMs ?? Infinity)));
  if (!valid[0]) return null;
  return { baseURL: valid[0].baseURL, modelID: valid[0].modelID, name: valid[0].name || valid[0].modelID };
}

function clear() {
  cache = null;
  try { fs.unlinkSync(CACHE_FILE); } catch {}
}

function data() { return cache; }

module.exports = { load, save, isFresh, ageLabel, getEntry, fastestModel, clear, data };
