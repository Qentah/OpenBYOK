'use strict';

const { chatCompletionStream } = require('../../core/services/chat');
const { BENCH_TIMEOUT_MS, BENCH_SLOW_TTFT_MS, BENCH_SLOW_TOKENS_PER_SEC } = require('../../core/constants');

/**
 * Benchmark one model via streaming chat completion.
 * Returns { status, ttftMs, totalMs, tokens, tokensPerSec, error }.
 * status: OK | SLOW | TIMEOUT | ERROR | NO_TOKENS
 */
async function benchmarkModel(model, token, timeoutMs = BENCH_TIMEOUT_MS) {
  const result = { status: 'OK', ttftMs: null, totalMs: null, tokens: 0, tokensPerSec: null, error: null };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const start = Date.now();
  let firstTokenAt = null;
  let tokenCount = 0;
  try {
    await chatCompletionStream(
      model.baseURL, model.modelID, token,
      model.prompt ?? "Réponds en une phrase courte : qu'est-ce que la gravité ?",
      () => {
        tokenCount++;
        if (firstTokenAt === null) firstTokenAt = Date.now();
      },
      ac.signal
    );
    const end = Date.now();
    result.totalMs = end - start;
    result.tokens = tokenCount;
    if (firstTokenAt !== null) {
      result.ttftMs = firstTokenAt - start;
      const afterMs = end - firstTokenAt;
      if (tokenCount > 1 && afterMs > 0) {
        result.tokensPerSec = Number(((tokenCount - 1) / (afterMs / 1000)).toFixed(1));
      } else if (tokenCount > 0 && result.totalMs > 0) {
        result.tokensPerSec = Number((tokenCount / (result.totalMs / 1000)).toFixed(1));
      }
      // spd = seconds to generate 1000 tokens (TTFT + 1000 / tokensPerSec)
      if (result.tokensPerSec && result.tokensPerSec > 0) {
        result.spd = Number((result.ttftMs / 1000 + 1000 / result.tokensPerSec).toFixed(2));
      } else {
        result.spd = null;
      }
    }
    if (tokenCount === 0) result.status = 'NO_TOKENS';
    else if (result.ttftMs > BENCH_SLOW_TTFT_MS) result.status = 'SLOW';
    else if (result.tokensPerSec !== null && result.tokensPerSec < BENCH_SLOW_TOKENS_PER_SEC) result.status = 'SLOW';
  } catch (err) {
    result.totalMs = Date.now() - start;
    result.status = err.name === 'AbortError' ? 'TIMEOUT' : 'ERROR';
    result.error = err.message;
  } finally {
    clearTimeout(timer);
  }
  return result;
}

/** Merge a model row + benchmark result into a cache entry. */
function toCacheEntry(model, bench) {
  return {
    key: model.key,
    status: bench.status,
    ttftMs: bench.ttftMs,
    totalMs: bench.totalMs,
    tokens: bench.tokens,
    tokensPerSec: bench.tokensPerSec,
    spd: bench.spd ?? null,
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxOutputTokens,
    hasImageInput: model.hasImageInput,
    toolCalling: model.toolCalling,
    name: model.name,
    providerID: model.providerID,
    modelID: model.modelID,
    baseURL: model.baseURL,
    error: bench.error,
  };
}

module.exports = { benchmarkModel, toCacheEntry };
