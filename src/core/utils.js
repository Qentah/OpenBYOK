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

/**
 * Clamp (context, input, output) so input+output <= context, output < context.
 * Prevents VS Code "Output token reservation leaves no room in context window".
 */
function sanitizeLimits(contextWindow, maxInput, maxOutput) {
  let ctx = (typeof contextWindow === 'number' && contextWindow > 0) ? contextWindow : 128000;
  let out = (typeof maxOutput === 'number' && maxOutput > 0) ? maxOutput : 16384;
  let inp = (typeof maxInput === 'number' && maxInput > 0) ? maxInput : null;
  if (out >= ctx) out = Math.max(1, ctx - 1);
  if (!inp || inp < 1) inp = Math.max(1, ctx - out);
  if (inp + out > ctx) out = Math.max(1, ctx - inp);
  if (inp <= 0) { inp = 1; out = Math.max(1, ctx - 1); }
  if (out <= 0) out = 1;
  return { contextWindow: ctx, maxInputTokens: inp, maxOutputTokens: out };
}

module.exports = { sleep, runPool, normUrl, sanitizeLimits };
