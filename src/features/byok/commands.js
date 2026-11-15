'use strict';

const vscode = require('vscode');
const tokenStore = require('../../core/services/token-store');
const benchCache = require('../../core/services/bench-cache');
const vsConfig = require('../../core/services/vscode-config');
const registry = require('../../core/providers/registry');
const { normUrl } = require('../../core/utils');
const benchmark = require('../benchmark/commands');

/**
 * Native BYOK credential reference for our group. We NEVER invent a
 * `chat.lm.secret.X` id ourselves: those ids belong to VS Code's own secret
 * storage and are created only when the user configures a key through the
 * native "Manage Language Models → Update API Key" flow (the same mechanism
 * the opencode-copilot-chat reference extension relies on). An extension-side
 * hash can never match a VS Code-generated id, so it produces a dead
 * reference that resolves to nothing.
 *
 * Correct-by-the-spec behaviour:
 *   - Re-selecting an existing group keeps its current `${input:...}` so the
 *     already-stored secret survives.
 *   - A brand-new group is written with an EMPTY apiKey placeholder. VS Code
 *     only lists a group in Manage Language Models when an apiKey field is
 *     present; without it the "Update API Key" flow can never be reached. The
 *     empty value makes the group appear, and once the user sets the key VS
 *     Code generates its own chat.lm.secret.X id, stores the value natively,
 *     and rewrites chatLanguageModels.json with that reference. No
 *     extension-side secret sync, no invented ids.
 */
function resolveByokApiKey(existingEntry) {
  const m = typeof existingEntry?.apiKey === 'string'
    ? existingEntry.apiKey.match(/\$\{input:[^}]+\}/)
    : null;
  return m ? m[0] : undefined; // undefined => omit the field entirely
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
  let models = [];
  let token;
  try {
    token = await tokenStore.getToken();
    for (const provider of registry.list()) {
      try {
        const pm = await provider.listModels(token);
        if (Array.isArray(pm)) models = models.concat(pm);
      } catch (e) {
        vscode.window.showWarningMessage(`Provider ${provider.id}: ${e.message}`);
      }
    }
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
      ? { status: cached.status, ttftMs: cached.ttftMs, tokensPerSec: cached.tokensPerSec, spd: cached.spd, error: cached.error }
      : { status: 'UNKNOWN', ttftMs: null, tokensPerSec: null, spd: null, error: null };
    return { model: m, bench };
  });

  benchResults.sort((a, b) => {
    const spa = a.bench.spd ?? Infinity;
    const spb = b.bench.spd ?? Infinity;
    if (spa !== spb) return spa - spb;
    const sa = statusOrder[a.bench.status] ?? 6;
    const sb = statusOrder[b.bench.status] ?? 6;
    if (sa !== sb) return sa - sb;
    return a.model.key.localeCompare(b.model.key);
  });

  const items = benchResults.map(({ model: m, bench: b }) => {
    const ctx = m.contextWindow ? `${Math.round(m.contextWindow / 1000)}k ctx` : '? ctx';
    const spd = b.spd !== null ? `${b.spd}s/1k` : '— s/1k';
    const toks = b.tokensPerSec !== null ? `${b.tokensPerSec} tok/s` : '— tok/s';
    const ttft = b.ttftMs !== null ? `TTFT ${b.ttftMs}ms` : '';
    const errInfo = b.error ? ` — ${b.error.slice(0, 60)}` : '';
    const cacheInfo = useCache ? ` [cache ${cacheAgeStr}]` : '';
    return {
      label: `${statusIcon[b.status] ?? '❓'}  ${m.modelID}`,
      description: `${ctx}  |  spd ${spd}  |  ${toks}  |  ${ttft}${errInfo}${cacheInfo}`.trim(),
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
  const apiKeyRef = resolveByokApiKey(existingEntry);
  const byokEntry = {
    name: `OpenBYOK ${providerChoice.label}`,
    vendor: 'customendpoint',
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

  // Preserve an existing native credential reference so a stored secret
  // survives re-selection. A brand-new group gets an EMPTY apiKey placeholder
  // so VS Code lists it in Manage Language Models and the user can set the key
  // (VS Code then replaces this with its own ${input:chat.lm.secret.X} id).
  byokEntry.apiKey = apiKeyRef ?? '';

  vsConfig.upsertChatLanguageModel(byokEntry);
  try { vsConfig.ensureInputDefinition(); } catch (e) { /* best effort */ }

  if (apiKeyRef) {
    const reload = await vscode.window.showInformationMessage(
      `Updated ${selected.length} model(s) from "${providerChoice.label}" in BYOK. Existing API key kept. Reload the window to see the models.`,
      'Reload Window'
    );
    if (reload === 'Reload Window') {
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
    return;
  }

  let action = await vscode.window.showInformationMessage(
    `Added ${selected.length} model(s) from "${providerChoice.label}" to BYOK. Configure the API key now (VS Code stores it natively), then reload the window to see the models.`,
    'Configure API Key',
    'Reload Window'
  );
  while (action === 'Configure API Key') {
    await configureApiKey(byokEntry.name);
    action = await vscode.window.showInformationMessage(
      `Group "${byokEntry.name}" updated. Reload the window to see the models.`,
      'Reload Window',
      'Configure API Key Again'
    );
    if (action === 'Configure API Key Again') action = 'Configure API Key';
  }
  if (action === 'Reload Window') {
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
  }
}

/* ---------- configureApiKey (native prompt, no extension-side secret) ---------- */

/**
 * Drive VS Code's native "Update API Key" flow for a specific BYOK group.
 * We never invent chat.lm.secret.X ids: VS Code creates/stores them when the
 * user sets the key through Manage Language Models. Workbench credential
 * commands are not always public, so we fall back to opening the Manage panel.
 */
async function promptConfigureApiKeyForGroup(name, vendor = 'customendpoint') {
  try {
    await vscode.commands.executeCommand('vscode.updateLanguageModelsProviderGroupApiKey', vendor, name);
    return;
  } catch { /* command not exposed — use the generic configure entry point */ }
  try {
    await vscode.commands.executeCommand('vscode.configureLanguageModelsProviderGroup', vendor, name);
    return;
  } catch { /* fall through to guidance */ }
  const choice = await vscode.window.showInformationMessage(
    `Open "Manage Language Models", find "${name}", click the gear → "Update API Key", and paste your OpenCode key.`,
    'Open Manage Language Models'
  );
  if (choice) await vscode.commands.executeCommand('workbench.action.chat.manageLanguageModels');
}

async function configureApiKey(targetGroupName) {
  const groups = vsConfig.readChatLanguageModels().filter(
    (e) => String(e?.name ?? '').startsWith('OpenBYOK ')
      && ['customendpoint', 'openbyok'].includes(String(e?.vendor ?? ''))
  );
  if (groups.length === 0) {
    vscode.window.showWarningMessage('No OpenBYOK group found. Run "OpenBYOK: Select Models for BYOK" first.');
    return;
  }

  let entry;
  if (targetGroupName) {
    entry = groups.find((g) => g.name === targetGroupName);
  }
  if (!entry) {
    const pick = groups.length === 1
      ? groups[0]
      : await vscode.window.showQuickPick(
          groups.map((g) => ({ label: g.name, detail: `${(g.models ?? []).length} model(s)` })),
          { placeHolder: 'Which OpenBYOK group needs its API key?' }
        );
    if (!pick) return;
    entry = pick.name ? pick : groups.find((g) => g.name === pick.label);
  }
  const name = entry?.name ?? targetGroupName;
  const vendor = String(entry?.vendor ?? 'customendpoint');
  await promptConfigureApiKeyForGroup(name, vendor);
}

async function removeGroup() {
  const groups = vsConfig.readChatLanguageModels().filter(
    (e) => String(e?.name ?? '').startsWith('OpenBYOK ')
  );
  if (groups.length === 0) {
    vscode.window.showWarningMessage('No OpenBYOK group found.');
    return;
  }
  const pick = await vscode.window.showQuickPick(
    groups.map((g) => ({ label: g.name, detail: `${(g.models ?? []).length} model(s)` })),
    { placeHolder: 'Which OpenBYOK group to remove?' }
  );
  if (!pick) return;
  const all = vsConfig.readChatLanguageModels();
  const filtered = all.filter((e) => String(e?.name ?? '') !== pick.label);
  const clmPath = vsConfig.getChatLanguageModelsPath();
  const fs = require('fs');
  fs.writeFileSync(clmPath + '.tmp', JSON.stringify(filtered, null, 2));
  fs.renameSync(clmPath + '.tmp', clmPath);
  // Remove orphaned input declarations that no longer referenced.
  try { vsConfig.ensureInputDefinition(); } catch {}
  vscode.window.showInformationMessage(`Removed group "${pick.label}". Reload the window to apply.`);
}

function register(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('openbyok.registerToken', () => registerToken()),
    vscode.commands.registerCommand('openbyok.selectModels', () => selectModels()),
    vscode.commands.registerCommand('openbyok.configureApiKey', () => configureApiKey()),
    vscode.commands.registerCommand('openbyok.refreshToken', () => refreshToken()),
    vscode.commands.registerCommand('openbyok.logout', () => logout()),
    vscode.commands.registerCommand('openbyok.removeGroup', () => removeGroup()),
  );
}

module.exports = { register, registerToken, selectModels, configureApiKey, refreshToken, logout, removeGroup };

