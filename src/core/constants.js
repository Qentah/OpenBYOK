'use strict';

const path = require('path');
const os = require('os');

module.exports = {
  // --- Auth / storage ---
  SECRET_KEY: 'openbyok.opencode.token',

  // --- Endpoints ---
  CONSOLE_API: 'https://opencode.ai/console/api/v2/config',
  CATALOGUE_API: 'https://models.opencode.ai/experimental/v2.0/api.json',
  DEFAULT_SERVER: 'https://opencode.ai/console',
  CLIENT_ID: 'opencode',

  // --- Benchmark cache ---
  CACHE_FILE: path.join(os.homedir(), '.openbyok-benchmark-cache.json'),
  CACHE_MAX_AGE_MS: 2 * 60 * 60 * 1000, // 2 h

  // --- Benchmark tuning ---
  BENCH_TIMEOUT_MS: 15000,
  BENCH_CONCURRENCY: 8,
  BENCH_PROMPT: "Réponds en une phrase courte : qu'est-ce que la gravité ?",
  BENCH_SLOW_TTFT_MS: 5000,
  BENCH_SLOW_TOKENS_PER_SEC: 5,
};
