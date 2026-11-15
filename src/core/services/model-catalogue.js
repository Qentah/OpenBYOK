'use strict';

const registry = require('../providers/registry');
const logger = require('./logger');

/**
 * Centralised enumeration of chat models across providers.
 *
 * Owns provider iteration, per-provider error handling, and (optionally) the
 * benchability filter (opencode-go non-free models are dropped when
 * `benchableOnly` is set). Returns:
 *   { models: Model[], byProvider: Map<providerID, {provider, models}>, errors: [] }
 */
async function listAll(token, { providers, benchableOnly = false, onError } = {}) {
  const provs = Array.isArray(providers) ? providers : registry.list();
  const byProvider = new Map();
  const models = [];
  const errors = [];
  for (const provider of provs) {
    let pm = [];
    try {
      const res = await provider.listModels(token);
      pm = Array.isArray(res) ? res : [];
    } catch (e) {
      errors.push({ providerID: provider.id, error: e });
      if (typeof onError === 'function') onError(provider.id, e);
      else logger.warn('provider listModels failed', e);
      pm = [];
    }
    let filtered = pm;
    if (benchableOnly && provider.id === 'opencode-go') {
      filtered = pm.filter((m) => /-free$/i.test(m.modelID));
    }
    byProvider.set(provider.id, { provider, models: filtered });
    for (const m of filtered) models.push(m);
  }
  return { models, byProvider, errors };
}

module.exports = { listAll };
