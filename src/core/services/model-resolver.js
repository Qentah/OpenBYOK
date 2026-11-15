'use strict';

const vscode = require('vscode');
const tokenStore = require('./token-store');
const benchCache = require('./bench-cache');
const registry = require('../providers/registry');
const { BENCH_PROMPT } = require('../constants');

/**
 * Single source of truth for "which cached benchmark result is the best model".
 *
 * Replaces the former split between `benchCache.fastestModel()` (sort by spd)
 * and `benchmark.selectBestModelForCommit()` (filter by min tokens/s, sort by ttft).
 * Callers pass the policy knobs instead of re-implementing the selection:
 *   - minTokensPerSec: drop results below this throughput (0 = no filter)
 *   - sortBy: 'spd' (overall speed) or 'ttft' (responsiveness)
 */
function bestCachedModel({ minTokensPerSec = 0, sortBy = 'spd' } = {}) {
  const cache = benchCache.data();
  if (!cache?.results?.length) return null;

  let eligible = (cache.results || []).filter((r) => r?.baseURL && r?.modelID);
  if (minTokensPerSec > 0) {
    eligible = eligible.filter((r) => (r.tokensPerSec ?? 0) >= minTokensPerSec);
  }
  if (eligible.length === 0) return null;

  eligible.sort((a, b) => {
    const primary = (x) => (sortBy === 'ttft') ? (x.ttftMs ?? Infinity) : (x.spd ?? Infinity);
    const secondary = (x) => (sortBy === 'ttft') ? (x.spd ?? Infinity) : (x.ttftMs ?? Infinity);
    const d = primary(a) - primary(b);
    if (d !== 0) return d;
    return secondary(a) - secondary(b);
  });

  const r = eligible[0];
  return {
    key: r.key,
    baseURL: r.baseURL,
    modelID: r.modelID,
    name: r.name || r.modelID,
    spd: r.spd ?? null,
    tokensPerSec: r.tokensPerSec ?? null,
    ttftMs: r.ttftMs ?? null,
  };
}

/**
 * Resolve a model from a configured setting id, or fall back to the benchmark
 * cache (fastest by spd). Returns a full catalogue model when the token is
 * available, otherwise a minimal { baseURL, modelID, name, prompt } object.
 *
 * Throws when settingId is given but cannot be resolved (callers decide whether
 * to fall back to the cache).
 */
async function resolveModelFor(token, settingId) {
  if (settingId) {
    for (const provider of registry.list()) {
      if (typeof provider.findModelById !== 'function') continue;
      try {
        return await provider.findModelById(token, settingId);
      } catch { /* try next provider */ }
    }
    throw new Error(`Model "${settingId}" not found.`);
  }
  const bench = bestCachedModel({ sortBy: 'spd' });
  if (bench) {
    for (const provider of registry.list()) {
      if (typeof provider.findModelById !== 'function') continue;
      try { return await provider.findModelById(token, bench.key ?? bench.modelID); }
      catch { /* try next provider */ }
    }
    return { baseURL: bench.baseURL, modelID: bench.modelID, name: bench.name, prompt: BENCH_PROMPT };
  }
  throw new Error('No model configured and no benchmark cache. Run "OpenBYOK: Run Benchmark (with progress)".');
}

/**
 * High-level resolution used by features: setting first, then cache fallback
 * (fastest model). Returns a model object or null (never throws).
 */
async function resolveModel({ settingId } = {}) {
  if (settingId) {
    try {
      const token = await tokenStore.getToken();
      const m = await resolveModelFor(token, settingId);
      if (m?.baseURL && m?.modelID) return m;
    } catch { /* fall through to cache */ }
  }
  const cached = bestCachedModel({ sortBy: 'spd' });
  if (cached?.baseURL && cached?.modelID) {
    return { baseURL: cached.baseURL, modelID: cached.modelID, name: cached.name, prompt: BENCH_PROMPT };
  }
  return null;
}

module.exports = {
  bestCachedModel,
  resolveModelFor,
  resolveModel,
};