'use strict';

/**
 * OpenBYOK — extension entry point.
 * Wiring only: services init + command registration.
 * All logic lives in core/ (shared services & providers) and features/ (commands).
 */

const tokenStore = require('./core/services/token-store');
const benchCache = require('./core/services/bench-cache');

const byok = require('./features/byok/commands');
const benchmark = require('./features/benchmark/commands');
const opengit = require('./features/opengit/command');

async function activate(context) {
  await tokenStore.init(context.secrets);
  benchCache.load();

  // Auto-refresh benchmark cache in background only when it has expired (silent).
  if (!benchCache.isFresh()) {
    benchmark.runBackgroundBenchmark().catch(() => {});
  }

  byok.register(context);
  benchmark.register(context);
  opengit.register(context);
}

function deactivate() {}

module.exports = { activate, deactivate };
