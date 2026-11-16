'use strict';

const vscode = require('vscode');
const tokenStore = require('../../core/services/token-store');
const benchCache = require('../../core/services/bench-cache');
const registry = require('../../core/providers/registry');
const modelCatalogue = require('../../core/services/model-catalogue');
const { runPool } = require('../../core/utils');
const { benchmarkModel, toCacheEntry } = require('./benchmark');
const { BENCH_TIMEOUT_MS, BENCH_CONCURRENCY } = require('../../core/constants');
const logger = require('../../core/services/logger');
const modelResolver = require('../../core/services/model-resolver');

let running = false;
let statusBarItem = null;

function setStatusBarItem(item) { statusBarItem = item; }

function updateStatusBar() {
  if (!statusBarItem) return;
  const cache = benchCache.data();
  const commitModel = vscode.workspace.getConfiguration('openbyok').get('commitModel')?.toString().trim() || '';
  if (cache?.timestamp && Array.isArray(cache.results) && cache.results.length) {
    // Reflect the user's explicit selection when set, otherwise the fastest cached model.
    let chosen = null;
    if (commitModel) {
      chosen = cache.results.find((r) => r.modelID === commitModel) || null;
    }
    const fastest = modelResolver.bestCachedModel({ sortBy: 'spd' });
    const display = chosen || (!commitModel ? fastest : null);
    const name = display
      ? (display.name || display.modelID)
      : (commitModel || (fastest ? (fastest.name || fastest.modelID) : 'cached'));
    const spd = (display && (display.spd ?? null) != null) ? display.spd : (fastest?.spd ?? null);
    const spdLabel = spd != null ? `${spd}s/1k` : '';
    const ageMin = Math.round((Date.now() - cache.timestamp) / 60000);
    statusBarItem.text = `$(dashboard) OpenBYOK: ${name} ${spdLabel} (${ageMin}m)`.trim();
    statusBarItem.tooltip = `Benchmark cache: ${cache.results.length} models, ${ageMin} min ago. Click to view/select model.` +
      (commitModel ? `\nCommit model: ${commitModel}` : '\nCommit model: Auto (fastest)');
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

/**
 * Single deep module owning the benchmark pipeline:
 * list models per provider -> enumerate (filter non-free) -> runPool -> save cache -> update status bar.
 * `progress` (vscode progress) and `cancelToken` are optional (background mode passes null).
 * Returns the saved results array.
 */
async function runBenchmark({ providers, progress, cancelToken, token }) {
  const cat = await modelCatalogue.listAll(token, { providers, benchableOnly: true });
  const models = cat.models;
  if (models.length === 0) {
    if (progress) vscode.window.showWarningMessage('No chat models found.');
    return [];
  }
  if (progress) progress.report({ message: `0/${models.length} models…` });
  let done = 0;
  const { timeout, concurrency } = benchConfig();
  const results = await runPool(
    models,
    async (m) => {
      if (cancelToken && cancelToken.isCancellationRequested) return null;
      const r = await benchmarkModel(m, token, timeout);
      if (progress) {
        done++;
        progress.report({
          message: `${done}/${models.length} — ${m.key} → ${r.status}`,
          increment: 100 / models.length,
        });
      }
      return toCacheEntry(m, r);
    },
    concurrency
  );
  const toSave = cancelToken ? results.filter(Boolean) : results;
  benchCache.save(toSave);
  updateStatusBar();
  if (progress) {
    vscode.window.showInformationMessage(`Benchmark complete: ${toSave.length} models cached.`);
  }
  return toSave;
}

async function runBackgroundBenchmark() {
  if (running) return;
  running = true;
  try {
    const token = await tokenStore.getToken();
    await runBenchmark({ providers: registry.list(), progress: null, cancelToken: null, token });
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
        await runBenchmark({ providers, progress, cancelToken, token });
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

module.exports = { register, runBackgroundBenchmark, runBenchmarkWithProgress, runBenchmark, clearCache, setStatusBarItem, updateStatusBar, selectFromBenchmark };

