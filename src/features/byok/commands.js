'use strict';

const vscode = require('vscode');
const tokenStore = require('../../core/services/token-store');
const benchCache = require('../../core/services/bench-cache');
const vsConfig = require('../../core/services/vscode-config');
const registry = require('../../core/providers/registry');
const { normUrl } = require('../../core/utils');
const benchmark = require('../benchmark/commands');

/**
 * Native BYOK credential id for our group, mirroring what VS Code's
 * "Update API Key" generates: apiKey = ${input:chat.lm.secret.XXXX} with the
 * secret stored in VS Code's own SecretStorage. Reuse the id already present
 * on an existing OpenBYOK group so the stored secret survives re-selection;
 * otherwise derive a stable id from the provider name.
 */
function resolveByokInputId(existingEntry, providerID) {
  const m = typeof existingEntry?.apiKey === 'string'
    ? existingEntry.apiKey.match(/\$\{input:(chat\.lm\.secret\.[^}]+)\}/)
    : null;
  if (m) return m[1];
  let h = 5381;
  for (const c of `openbyok:${providerID}`) h = ((h * 33) ^ c.charCodeAt(0)) >>> 0;
  return `chat.lm.secret.${h.toString(16).padStart(8, '0').slice(0, 8)}`;
}

/* ---------- Auth commands ---------- */

async function registerToken() {
  const provider = registry.getDefault();
  const cliAvailable = await provider.cliAvailable();

  const items = [
    { label: 'Device flow (browser login)', pick: 'device' },
  ];
  if (cliAvailable) {
    items.push({
      label: 'Retrieve token from OpenCode CLI',
      pick: 'cli',
      detail: 'Option — CLI OpenCode détecté sur ce PC.',
    });
  }

  const choice = await vscode.window.showQuickPick(items, {
    placeHolder: 'How do you want to register your OpenCode token?',
  });
  if (!choice) return;
  try {
    if (choice.pick === 'device') {
      const mode = await vscode.window.showQuickPick(
        ['Open browser automatically', 'Show URL only (manual / no-browser)'],
        { placeHolder: 'Device flow mode' }
      );
      if (!mode) return;
      await provider.deviceLogin(mode.startsWith('Show'));
    } else {
      const token = await provider.cliExportToken();
      await tokenStore.storeToken(token);
      vscode.window.showInformationMessage('Token retrieved from OpenCode CLI and stored securely.');
    }
  } catch (e) {
    vscode.window.showErrorMessage(e.message);
  }
}

async function refreshToken() {
  try {
    await registry.getDefault().refreshToken();
  } catch (e) {
    vscode.window.showErrorMessage(e.message);
  }
}

async function logout() {
  await tokenStore.deleteToken();
  vscode.window.showInformationMessage('Logged out.');
}

/* ---------- selectModels ---------- */

async function selectModels() {
  let models;
  let token;
  try {
    token = await tokenStore.getToken();
    models = await registry.getDefault().listModels(token);
  } catch (e) {
    vscode.window.showErrorMessage(e.message);
    return;
  }
  if (models.length === 0) {
    vscode.window.showWarningMessage('No chat models found.');
    return;
  }

  // Use cached benchmark results if fresh; otherwise offer a live benchmark first.
  const cacheAgeStr = benchCache.ageLabel();
  const useCache = benchCache.isFresh();
  if (!useCache) {
    const runNow = await vscode.window.showInformationMessage(
      `No fresh benchmark cache (${cacheAgeStr}). Run benchmark now?`,
      'Run Benchmark', 'Skip (show all)'
    );
    if (runNow === 'Run Benchmark') {
      if (await benchmark.runBenchmarkWithProgress()) benchCache.load();
    } else if (runNow !== 'Skip (show all)') {
      return; // user dismissed
    }
  }

  const benchMap = new Map();
  if (benchCache.isFresh() && benchCache.data()?.results) {
    for (const r of benchCache.data().results) benchMap.set(r.key, r);
  }

  // Group models by provider
  const providers = new Map();
  for (const m of models) {
    if (!providers.has(m.providerID)) {
      providers.set(m.providerID, { providerID: m.providerID, baseURL: m.baseURL, models: [] });
    }
    providers.get(m.providerID).models.push(m);
  }

  // ---------- Step 1: choose a provider ----------
  const providerChoice = await vscode.window.showQuickPick(
    [...providers.values()].map((g) => ({
      label: g.providerID,
      description: `${g.models.length} model(s)`,
      detail: g.baseURL,
      alwaysShow: true,
    })),
    {
      canPickMany: false,
      placeHolder: 'Choose the provider whose models you want to add to BYOK',
      title: 'OpenBYOK — Select Provider',
    }
  );
  if (!providerChoice) return;
  const group = providers.get(providerChoice.label);

  // ---------- Step 2: choose models of that provider ----------
  const statusOrder = { OK: 0, SLOW: 1, UNKNOWN: 2, NO_TOKENS: 3, TIMEOUT: 4, ERROR: 5 };
  const statusIcon = { OK: '✅', SLOW: '🐌', TIMEOUT: '⏱️', ERROR: '❌', NO_TOKENS: '⚠️', UNKNOWN: '❓' };

  const benchResults = group.models.map((m) => {
    const cached = benchMap.get(m.key);
    const bench = cached
      ? { status: cached.status, ttftMs: cached.ttftMs, tokensPerSec: cached.tokensPerSec, error: cached.error }
      : { status: 'UNKNOWN', ttftMs: null, tokensPerSec: null, error: null };
    return { model: m, bench };
  });

  benchResults.sort((a, b) => {
    const sa = statusOrder[a.bench.status] ?? 6;
    const sb = statusOrder[b.bench.status] ?? 6;
    if (sa !== sb) return sa - sb;
    const ta = a.bench.tokensPerSec ?? 0;
    const tb = b.bench.tokensPerSec ?? 0;
    if (ta !== tb) return tb - ta;
    return a.model.key.localeCompare(b.model.key);
  });

  const items = benchResults.map(({ model: m, bench: b }) => {
    const ctx = m.contextWindow ? `${Math.round(m.contextWindow / 1000)}k ctx` : '? ctx';
    const toks = b.tokensPerSec !== null ? `${b.tokensPerSec} tok/s` : '— tok/s';
    const ttft = b.ttftMs !== null ? `TTFT ${b.ttftMs}ms` : '';
    const errInfo = b.error ? ` — ${b.error.slice(0, 60)}` : '';
    const cacheInfo = useCache ? ` [cache ${cacheAgeStr}]` : '';
    return {
      label: `${statusIcon[b.status] ?? '❓'}  ${m.modelID}`,
      description: `${ctx}  |  ${toks}  |  ${ttft}${errInfo}${cacheInfo}`.trim(),
      picked: b.status === 'OK' || b.status === 'UNKNOWN',
      model: m,
    };
  });

  const selected = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    placeHolder: `Select models from ${providerChoice.label} to add to VS Code BYOK (cache: ${cacheAgeStr})`,
    title: `OpenBYOK Console — ${providerChoice.label}`,
  });
  if (!selected || selected.length === 0) return;

  // Build the BYOK entry for this provider and merge it into chatLanguageModels.json.
  const url = `${normUrl(group.baseURL)}/chat/completions`;
  const existingEntry = (vsConfig.readChatLanguageModels() ?? []).find(
    (e) => String(e?.name ?? '') === `OpenBYOK ${providerChoice.label}`
  );
  const inputId = resolveByokInputId(existingEntry, providerChoice.label);
  const byokEntry = {
    name: `OpenBYOK ${providerChoice.label}`,
    vendor: 'customendpoint',
    apiKey: `\${input:${inputId}}`,
    apiType: 'chat-completions',
    models: selected.map((s) => {
      const m = s.model;
      const entry = {
        id: m.modelID,
        name: m.name,
        url,
        toolCalling: m.toolCalling,
        vision: m.hasImageInput,
        maxInputTokens: m.maxInputTokens,
        maxOutputTokens: m.maxOutputTokens,
      };
      if (m.reasoning) entry.thinking = true;
      if (Array.isArray(m.reasoningEfforts) && m.reasoningEfforts.length > 0) {
        entry.supportsReasoningEffort = m.reasoningEfforts;
        entry.reasoningEffortFormat = 'chat-completions';
      }
      entry.description = m.description ?? `${m.name} — OpenBYOK Console model (${m.providerID})`;
      if (m.family) entry.family = m.family;
      if (m.releaseDate) entry.releaseDate = m.releaseDate;
      return entry;
    }),
  };

  vsConfig.upsertChatLanguageModel(byokEntry);

  // The ${input:chat.lm.secret.X} reference is resolved by VS Code itself:
  // on first use it prompts for the key once and stores it in its own secret
  // storage (same mechanism as "Update API Key"). No extension-side sync needed.

  vscode.window.showInformationMessage(
    `Added ${selected.length} model(s) from "${providerChoice.label}" to BYOK. Reload VS Code, then enter your OpenCode key when prompted — it will be saved natively.`
  );
}

function register(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('openbyok.registerToken', () => registerToken()),
    vscode.commands.registerCommand('openbyok.selectModels', () => selectModels()),
    vscode.commands.registerCommand('openbyok.refreshToken', () => refreshToken()),
    vscode.commands.registerCommand('openbyok.logout', () => logout()),
  );
}

module.exports = { register, registerToken, selectModels, refreshToken, logout };
