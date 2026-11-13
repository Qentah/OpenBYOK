'use strict';

const vscode = require('vscode');
const tokenStore = require('../../core/services/token-store');
const benchCache = require('../../core/services/bench-cache');
const registry = require('../../core/providers/registry');
const { runPool } = require('../../core/utils');
const { benchmarkModel, toCacheEntry } = require('./benchmark');
const { BENCH_TIMEOUT_MS, BENCH_CONCURRENCY } = require('../../core/constants');

let running = false;

async function runBackgroundBenchmark() {
  if (running) return;
  running = true;
  try {
    const token = await tokenStore.getToken();
    const models = await registry.getDefault().listModels(token);
    if (models.length === 0) return;
    const results = await runPool(
      models,
      (m) => benchmarkModel(m, token, BENCH_TIMEOUT_MS).then((r) => toCacheEntry(m, r)),
      BENCH_CONCURRENCY
    );
    benchCache.save(results);
  } catch { /* silent in background */ }
  finally { running = false; }
}

async function runBenchmarkWithProgress() {
  if (running) {
    vscode.window.showInformationMessage('Benchmark already running…');
    return false;
  }
  running = true;
  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Benchmarking OpenCode models',
        cancellable: true,
      },
      async (progress, cancelToken) => {
        const token = await tokenStore.getToken();
        const models = await registry.getDefault().listModels(token);
        if (models.length === 0) {
          vscode.window.showWarningMessage('No chat models found.');
          return;
        }
        progress.report({ message: `0/${models.length} models…` });
        let done = 0;
        const results = await runPool(
          models,
          async (m) => {
            if (cancelToken.isCancellationRequested) return null;
            const r = await benchmarkModel(m, token, BENCH_TIMEOUT_MS);
            done++;
            progress.report({
              message: `${done}/${models.length} — ${m.key} → ${r.status}`,
              increment: 100 / models.length,
            });
            return toCacheEntry(m, r);
          },
          BENCH_CONCURRENCY
        );
        const valid = results.filter(Boolean);
        benchCache.save(valid);
        vscode.window.showInformationMessage(`Benchmark complete: ${valid.length} models cached.`);
      }
    );
    return true;
  } catch (e) {
    vscode.window.showErrorMessage(`Benchmark failed: ${e.message}`);
    return false;
  } finally {
    running = false;
  }
}

function clearCache() {
  benchCache.clear();
  vscode.window.showInformationMessage('Benchmark cache cleared.');
}

function register(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('openbyok.runBenchmark', () => runBenchmarkWithProgress()),
    vscode.commands.registerCommand('openbyok.clearCache', () => clearCache()),
  );
}

module.exports = { register, runBackgroundBenchmark, runBenchmarkWithProgress, clearCache };
