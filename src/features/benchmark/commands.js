'use strict';

const vscode = require('vscode');
const tokenStore = require('../../core/services/token-store');
const benchCache = require('../../core/services/bench-cache');
const registry = require('../../core/providers/registry');
const { runPool } = require('../../core/utils');
const { benchmarkModel, toCacheEntry } = require('./benchmark');
const { BENCH_TIMEOUT_MS, BENCH_CONCURRENCY } = require('../../core/constants');
const logger = require('../../core/services/logger');
const modelResolver = require('../../core/services/model-resolver');

/** Enumerate benchmarkable chat models for the given providers (drops opencode-go non-free). */
function enumerateModels(providers, listResults) {
  const all = [];
  for (const provider of providers) {
    const pm = Array.isArray(listResults.get(provider.id)) ? listResults.get(provider.id) : [];
    for (const m of pm) {
      if (provider.id === 'opencode-go' && !/-free$/i.test(m.modelID)) continue;
      all.push(m);
    }
  }
  return all;
}

let running = false;
let statusBarItem = null;

function setStatusBarItem(item) { statusBarItem = item; }

function updateStatusBar() {
  if (!statusBarItem) return;
  const cache = benchCache.data();
  if (cache?.timestamp && Array.isArray(cache.results) && cache.results.length) {
    const fastest = modelResolver.bestCachedModel({ sortBy: 'spd' });
    const ageMin = Math.round((Date.now() - cache.timestamp) / 60000);
    const spdLabel = fastest?.spd != null ? `${fastest.spd}s/1k` : '';
    statusBarItem.text = `$(dashboard) OpenBYOK: ${fastest ? (fastest.name || fastest.modelID) : 'cached'} ${spdLabel} (${ageMin}m)`.trim();
    statusBarItem.tooltip = `Benchmark cache: ${cache.results.length} models, ${ageMin} min ago. Click to view/select model.`;
  } else {
    statusBarItem.text = '$(dashboard) OpenBYOK: no cache';
    statusBarItem.tooltip = 'Click to run benchmark.';
  }
}

function benchConfig() {
  const cfg = vscode.workspace.getConfiguration('openbyok');
  return {
    timeout: Number(cfg.get('benchTimeoutMs')) || BENCH_TIMEOUT_MS,
    concurrency: Number(cfg.get('benchConcurrency')) || BENCH_CONCURRENCY,
  };
}

async function runBackgroundBenchmark() {
  if (running) return;
  running = true;
  try {
    const token = await tokenStore.getToken();
    const resultsByProvider = new Map();
    for (const provider of registry.list()) {
      try {
        const pm = await provider.listModels(token);
        resultsByProvider.set(provider.id, Array.isArray(pm) ? pm : []);
      } catch (e) { logger.warn('provider listModels failed', e); /* skip provider */ resultsByProvider.set(provider.id, []); }
    }
    const models = enumerateModels(registry.list(), resultsByProvider);
    if (models.length === 0) return;
    const { timeout, concurrency } = benchConfig();
    const results = await runPool(
      models,
      (m) => benchmarkModel(m, token, timeout).then((r) => toCacheEntry(m, r)),
      concurrency
    );
    benchCache.save(results);
    updateStatusBar();
  } catch (e) { logger.warn('background benchmark failed', e); /* silent in background */ }
  finally { running = false; }
}

/**
 * Select the best model for inline suggestion.
 * Delegated to model-resolver (single selection implementation).
 */
// selectBestModelForCommit removed: commit model = fastest model (bestCachedModel spd).

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
        const providerChoice = await vscode.window.showQuickPick(
          ['All providers', ...registry.list().map((p) => p.id)],
          { placeHolder: 'Which provider to benchmark?' }
        );
        if (!providerChoice) return;
        const providers = providerChoice === 'All providers'
          ? registry.list()
          : [registry.get(providerChoice)];
        const resultsByProvider = new Map();
        for (const provider of providers) {
          try {
            const pm = await provider.listModels(token);
            resultsByProvider.set(provider.id, Array.isArray(pm) ? pm : []);
          } catch (e) { logger.warn('provider listModels failed', e); /* skip provider */ resultsByProvider.set(provider.id, []); }
        }
        const models = enumerateModels(providers, resultsByProvider);
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
            const { timeout } = benchConfig();
            const r = await benchmarkModel(m, token, timeout);
            done++;
            progress.report({
              message: `${done}/${models.length} — ${m.key} → ${r.status}`,
              increment: 100 / models.length,
            });
            return toCacheEntry(m, r);
          },
          benchConfig().concurrency
        );
        const valid = results.filter(Boolean);
        benchCache.save(valid);
        updateStatusBar();
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
  updateStatusBar();
  vscode.window.showInformationMessage('Benchmark cache cleared.');
}

async function selectFromBenchmark() {
  let cache = benchCache.data();
  if (!cache?.results?.length) {
    const run = await vscode.window.showInformationMessage('No benchmark cache. Run benchmark now?', 'Run Benchmark');
    if (run === 'Run Benchmark') {
      const ok = await runBenchmarkWithProgress();
      if (!ok) return;
      cache = benchCache.data();
    } else {
      return;
    }
  }
  const items = [];
  const fastest = modelResolver.bestCachedModel({ sortBy: 'spd' });
  items.push({
    label: '⚡ Auto (fastest)',
    description: fastest ? `${fastest.name || fastest.modelID} · ${fastest.spd != null ? fastest.spd + 's/1k' : ''}` : 'no cache',
    modelID: '',
  });
  for (const r of (cache?.results || []).slice().sort((a, b) => (a.spd ?? Infinity) - (b.spd ?? Infinity))) {
    items.push({
      label: `${r.name || r.modelID}`,
      description: `${r.providerID} · spd ${r.spd != null ? r.spd + 's/1k' : '—'} · ${r.tokensPerSec ?? '?'} tok/s · TTFT ${r.ttftMs ?? '?'}ms`,
      modelID: r.modelID,
    });
  }
  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: 'Benchmark global — select model to use (Auto = fastest)',
    title: 'OpenBYOK — Benchmark',
  });
  if (!pick) return;
  const cfg = vscode.workspace.getConfiguration('openbyok');
  await cfg.update('commitModel', pick.modelID, vscode.ConfigurationTarget.Global);
  if (pick.modelID === '') {
    vscode.window.showInformationMessage(`Commit model set to Auto (fastest${fastest ? ': ' + (fastest.name || fastest.modelID) : ''}).`);
  } else {
    vscode.window.showInformationMessage(`Commit model set to ${pick.label} (${pick.modelID}).`);
  }
  updateStatusBar();
}

function register(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('openbyok.runBenchmark', () => runBenchmarkWithProgress()),
    vscode.commands.registerCommand('openbyok.clearCache', () => clearCache()),
    vscode.commands.registerCommand('openbyok.selectFromBenchmark', () => selectFromBenchmark()),
  );
}

module.exports = { register, runBackgroundBenchmark, runBenchmarkWithProgress, clearCache, setStatusBarItem, updateStatusBar, selectFromBenchmark };
