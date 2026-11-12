'use strict';

const vscode = require('vscode');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const SECRET_KEY = 'openbyok.opencode.token';
const INPUT_ID = 'opencodeApiKey';
const CONSOLE_API = 'https://opencode.ai/console/api/v2/config';
const CATALOGUE_API = 'https://models.opencode.ai/experimental/v2.0/api.json';
const DEFAULT_SERVER = 'https://opencode.ai/console';
const CLIENT_ID = 'opencode';
const CACHE_FILE = path.join(os.homedir(), '.openbyok-benchmark-cache.json');
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

let secretStorage;
let benchmarkCache = null;
let benchmarkRunning = false;
let benchmarkProgress = null;

// ---------- Cache helpers ----------

function loadCache() {
  try {
    const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (data?.timestamp && Array.isArray(data.results)) {
      benchmarkCache = data;
      return data;
    }
  } catch {}
  return null;
}

function saveCache(results) {
  const data = { timestamp: Date.now(), results };
  benchmarkCache = data;
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2)); } catch {}
}

function isCacheFresh() {
  if (!benchmarkCache?.timestamp) return false;
  return (Date.now() - benchmarkCache.timestamp) < CACHE_MAX_AGE_MS;
}

function getCachedBench(key) {
  if (!benchmarkCache?.results) return null;
  return benchmarkCache.results.find(r => r.key === key) ?? null;
}
function activate(context) {
  secretStorage = context.secrets;
  loadCache();

  // Auto-refresh cache in background if stale (once per day)
  if (!isCacheFresh()) {
    setTimeout(() => {
      runBackgroundBenchmark().catch(() => {});
    }, 5000);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('openbyok.registerToken', () => registerToken()),
    vscode.commands.registerCommand('openbyok.selectModels', () => selectModels()),
    vscode.commands.registerCommand('openbyok.refreshToken', () => refreshToken()),
    vscode.commands.registerCommand('openbyok.logout', () => logout()),
    vscode.commands.registerCommand('openbyok.runBenchmark', () => runBenchmarkWithProgress()),
    vscode.commands.registerCommand('openbyok.clearCache', () => clearCache()),
  );
}

// ---------- Token registration (device flow, no local OpenCode) ----------

async function deviceLogin(server = DEFAULT_SERVER, noBrowser = false) {
  server = server.replace(/\/+$/, '');
  const codeRes = await postJson(`${server}/auth/device/code`, {
    client_id: CLIENT_ID, supports_org_scope: true,
  });
  if (codeRes.status !== 200 || !codeRes.json.device_code) {
    throw new Error(`Device code refused (HTTP ${codeRes.status})`);
  }
  const dc = codeRes.json;
  const verifyUrl = new URL(dc.verification_uri_complete, `${server}/`).href;
  if (!noBrowser) {
    await vscode.env.openExternal(vscode.Uri.parse(verifyUrl));
  }
  const msg = noBrowser
    ? `Open this URL in your browser:\n${verifyUrl}\n\nCode to confirm: ${dc.user_code}`
    : `Confirm code ${dc.user_code} in your browser.`;
  vscode.window.showInformationMessage(msg);
  if (noBrowser) {
    // Also copy URL to clipboard for convenience
    await vscode.env.clipboard.writeText(verifyUrl);
    vscode.window.showInformationMessage('Verification URL copied to clipboard.');
  }

  const deadline = Date.now() + (dc.expires_in ?? 600) * 1000;
  let interval = Math.max(dc.interval ?? 5, 1) * 1000;
  while (Date.now() < deadline) {
    await sleep(interval);
    const tok = await postJson(`${server}/auth/device/token`, {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: dc.device_code, client_id: CLIENT_ID,
    });
    const j = tok.json;
    if (j.access_token) {
      await secretStorage.store(SECRET_KEY, j.access_token);
      const storePath = path.join(os.homedir(), '.openbyok-console.json');
      const store = {
        server, access: j.access_token, refresh: j.refresh_token ?? '',
        expires: Date.now() + (j.expires_in ?? 0) * 1000,
      };
      fs.writeFileSync(storePath, JSON.stringify(store, null, 2), { mode: 0o600 });
      vscode.window.showInformationMessage('OpenCode token registered successfully.');
      return j.access_token;
    }
    if (j.error === 'authorization_pending') continue;
    if (j.error === 'slow_down') { interval += 5000; continue; }
    throw new Error(`Auth failed: ${j.error ?? `HTTP ${tok.status}`}`);
  }
  throw new Error('Authorization timed out.');
}

async function registerToken() {
  const choice = await vscode.window.showQuickPick(
    ['Device flow (browser login)', 'Retrieve token from OpenCode CLI (if installed)'],
    { placeHolder: 'How do you want to register your OpenCode token?' }
  );
  if (!choice) return;
  if (choice.startsWith('Device')) {
    const mode = await vscode.window.showQuickPick(
      ['Open browser automatically', 'Show URL only (manual / no-browser)'],
      { placeHolder: 'Device flow mode' }
    );
    if (!mode) return;
    const noBrowser = mode.startsWith('Show');
    try { await deviceLogin(DEFAULT_SERVER, noBrowser); }
    catch (e) { vscode.window.showErrorMessage(e.message); }
  } else {
    try {
      const token = await getTokenFromCli();
      if (token) {
        await secretStorage.store(SECRET_KEY, token);
        vscode.window.showInformationMessage('Token retrieved from OpenCode CLI and stored securely.');
      }
    } catch (e) {
      vscode.window.showErrorMessage(`Could not retrieve token from CLI: ${e.message}`);
    }
  }
}

async function getToken() {
  const t = await secretStorage.get(SECRET_KEY);
  if (t) return t;
  try {
    const store = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.openbyok-console.json'), 'utf8'));
    if (store?.access) return store.access;
  } catch {}
  throw new Error('No token found. Run "OpenBYOK: Register API Token" first.');
}

async function getTokenFromCli() {
  const exeCandidates = [
    process.env.OPENCODE_CLI_PATH,
    path.join(process.cwd(), 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe'),
    path.join(os.homedir(), 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe'),
  ].filter(Boolean);

  // Also try 'opencode' on PATH
  exeCandidates.push('opencode');

  for (const exe of exeCandidates) {
    try {
      const { stdout } = await execFileAsync(exe, ['auth', 'export', 'opencode'], {
        encoding: 'utf8',
        timeout: 15000,
        windowsHide: true,
      });
      const creds = JSON.parse(stdout);
      const active = creds.find((c) => c.active && c.value?.access) ?? creds[0];
      if (active?.value?.access) return active.value.access;
    } catch {
      /* try next candidate */
    }
  }
  throw new Error('OpenCode CLI not found or no token available. Install @opencode/cli or use device flow.');
}

async function refreshToken() {
  try {
    const store = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.openbyok-console.json'), 'utf8'));
    if (!store?.refresh) throw new Error('No refresh token. Re-register.');
    const server = store.server.replace(/\/+$/, '');
    const tok = await postJson(`${server}/auth/device/token`, {
      grant_type: 'refresh_token', refresh_token: store.refresh, client_id: CLIENT_ID,
    });
    const j = tok.json;
    if (!j.access_token) throw new Error(`Refresh refused: ${j.error}`);
    await secretStorage.store(SECRET_KEY, j.access_token);
    store.access = j.access_token;
    store.refresh = j.refresh_token || store.refresh;
    store.expires = Date.now() + (j.expires_in ?? 0) * 1000;
    fs.writeFileSync(path.join(os.homedir(), '.openbyok-console.json'), JSON.stringify(store, null, 2));
    vscode.window.showInformationMessage('Token refreshed.');
  } catch (e) { vscode.window.showErrorMessage(e.message); }
}

async function logout() {
  await secretStorage.delete(SECRET_KEY);
  try { fs.unlinkSync(path.join(os.homedir(), '.openbyok-console.json')); } catch {}
  vscode.window.showInformationMessage('Logged out.');
}

// ---------- Fetch helpers (shared) ----------

async function fetchConsoleConfig(token) {
  return new Promise((resolve, reject) => {
    const url = new URL(CONSOLE_API);
    const req = https.request(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} on console config`));
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function fetchCatalogue() {
  return new Promise((resolve, reject) => {
    const url = new URL(CATALOGUE_API);
    const req = https.request(url, { headers: { Accept: 'application/json' } }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} on catalogue`));
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// Fetch console config + catalogue and return consolidated models
async function fetchConsolidatedModels(token) {
  const [config, catalogue] = await Promise.all([
    fetchConsoleConfig(token),
    fetchCatalogue(),
  ]);
  const catIndex = indexCatalogue(catalogue);
  return collectChatModels(config, catIndex);
}

// Map a benchmark result to a cache entry
function toCacheEntry(model, bench) {
  return {
    key: model.key,
    status: bench.status,
    ttftMs: bench.ttftMs,
    totalMs: bench.totalMs,
    tokens: bench.tokens,
    tokensPerSec: bench.tokensPerSec,
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

function indexCatalogue(cat) {
  const index = new Map();
  function walk(obj) {
    if (typeof obj !== 'object' || obj === null) return;
    if (Array.isArray(obj)) { obj.forEach(walk); return; }
    if (typeof obj.id === 'string' && obj.type === 'chat') {
      const baseUrl = obj?.api?.['chat-completions']?.base_url ?? '';
      const isNvidia = baseUrl.includes('nvidia.com');
      if (!index.has(obj.id) || isNvidia) {
        if (isNvidia || !index.has(obj.id)) index.set(obj.id, obj);
      }
    }
    for (const v of Object.values(obj)) walk(v);
  }
  walk(cat);
  return index;
}

function collectChatModels(config, catIndex) {
  const rows = [];
  for (const [pid, p] of Object.entries(config?.providers ?? {})) {
    if (!p?.settings?.baseURL) continue;
    const entries = Array.isArray(p.models)
      ? p.models.map(m => [m.id, m])
      : Object.entries(p.models ?? {});
    for (const [mid, m] of entries) {
      if (m?.disabled === true) continue;
      const caps = m?.capabilities;
      const chatCapable = !caps || (caps.input?.includes('text') && caps.output?.includes('text'));
      if (!chatCapable) continue;

      const c = catIndex.get(mid);
      const modalities = c?.modalities ?? null;
      const hasImageInput = Array.isArray(modalities?.input) &&
        modalities.input.some(x => String(x).startsWith('image'));
      const catCaps = c?.capabilities ?? {};
      const toolCalling = catCaps?.tools?.supported === true;
      const reasoning = catCaps?.reasoning?.supported === true;
      const reasoningEfforts = Array.isArray(catCaps?.reasoning?.effort) ? catCaps.reasoning.effort : null;
      const contextWindow = c?.limit?.context ?? null;
      const maxOutput = c?.limit?.output ?? null;
      const maxInput = c?.limit?.input ?? (contextWindow && maxOutput ? contextWindow - maxOutput : null);

      rows.push({
        key: `${pid}/${mid}`,
        providerID: pid,
        modelID: mid,
        name: m?.name ?? c?.name ?? mid,
        description: c?.description ?? null,
        family: c?.family ?? null,
        releaseDate: m?.releaseDate ?? c?.release_date ?? null,
        modalities,
        hasImageInput,
        toolCalling,
        reasoning,
        reasoningEfforts,
        contextWindow,
        maxInputTokens: maxInput ?? 128000,
        maxOutputTokens: maxOutput ?? 16384,
        baseURL: p.settings.baseURL,
      });
    }
  }
  return rows.sort((a, b) => a.key.localeCompare(b.key));
}

// ---------- Benchmark a single model ----------

async function benchmarkModel(model, token, timeoutMs = 30000) {
  const result = {
    status: 'OK',
    ttftMs: null,
    totalMs: null,
    tokens: 0,
    tokensPerSec: null,
    error: null,
  };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const start = Date.now();
  let firstTokenAt = null;
  let tokenCount = 0;
  try {
    const res = await fetch(`${model.baseURL.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      signal: ac.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: model.modelID,
        messages: [{ role: 'user', content: 'Réponds en une phrase courte : qu\'est-ce que la gravité ?' }],
        stream: true,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} — ${text.slice(0, 120)}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') break;
        let chunk;
        try { chunk = JSON.parse(payload); } catch { continue; }
        const delta = chunk.choices?.[0]?.delta ?? {};
        const text = delta.content ?? '';
        if (text) {
          tokenCount++;
          if (firstTokenAt === null) firstTokenAt = Date.now();
        }
      }
    }
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
    }
    if (tokenCount === 0) result.status = 'NO_TOKENS';
    else if (result.ttftMs !== null && result.ttftMs > 5000) result.status = 'SLOW';
    else if (result.tokensPerSec !== null && result.tokensPerSec < 5) result.status = 'SLOW';
  } catch (err) {
    const end = Date.now();
    result.totalMs = end - start;
    if (err.name === 'AbortError') result.status = 'TIMEOUT';
    else result.status = 'ERROR';
    result.error = err.message;
  } finally {
    clearTimeout(timer);
  }
  return result;
}

// ---------- Run pool with concurrency ----------

async function runPool(items, worker, limit) {
  const results = new Array(items.length);
  let cursor = 0;
  async function runner() {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await worker(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
  return results;
}

// ---------- Background benchmark (no UI) ----------

async function runBackgroundBenchmark() {
  if (benchmarkRunning) return;
  benchmarkRunning = true;
  try {
    const token = await getToken();
    const models = await fetchConsolidatedModels(token);
    if (models.length === 0) return;

    const results = await runPool(
      models,
      (m) => benchmarkModel(m, token, 15000).then(r => toCacheEntry(m, r)),
      8
    );
    saveCache(results);
  } catch (e) {
    // Silent failure in background
  } finally {
    benchmarkRunning = false;
  }
}

// ---------- Benchmark with progress UI ----------

async function runBenchmarkWithProgress() {
  if (benchmarkRunning) {
    vscode.window.showInformationMessage('Benchmark already running…');
    return;
  }
  benchmarkRunning = true;
  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Benchmarking OpenCode models',
        cancellable: true,
      },
      async (progress, cancelToken) => {
        const consoleToken = await getToken();
        const models = await fetchConsolidatedModels(consoleToken);
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
            const r = await benchmarkModel(m, consoleToken, 15000);
            done++;
            progress.report({
              message: `${done}/${models.length} — ${m.key} → ${r.status}`,
              increment: (100 / models.length),
            });
            return toCacheEntry(m, r);
          },
          8
        );
        const valid = results.filter(Boolean);
        saveCache(valid);
        vscode.window.showInformationMessage(`Benchmark complete: ${valid.length} models cached.`);
      }
    );
  } catch (e) {
    vscode.window.showErrorMessage(`Benchmark failed: ${e.message}`);
  } finally {
    benchmarkRunning = false;
  }
}

// ---------- Helper: fetch console config (returns {config}) ----------

async function fetchConsoleConfigRaw(token) {
  return { config: await fetchConsoleConfig(token) };
}

async function selectModels() {
  let models;
  try {
    const token = await getToken();
    models = await fetchConsolidatedModels(token);
  } catch (e) {
    vscode.window.showErrorMessage(e.message);
    return;
  }
  if (models.length === 0) {
    vscode.window.showWarningMessage('No chat models found.');
    return;
  }

  // Use cached benchmark results if fresh; otherwise offer a live benchmark first
  const cacheAge = benchmarkCache?.timestamp ? Date.now() - benchmarkCache.timestamp : null;
  const cacheAgeStr = cacheAge !== null ? `${Math.round(cacheAge / 3600000)}h ago` : 'no cache';
  const useCache = isCacheFresh();

  if (!useCache) {
    const runNow = await vscode.window.showInformationMessage(
      `No fresh benchmark cache (${cacheAgeStr}). Run benchmark now?`,
      'Run Benchmark', 'Skip (show all)'
    );
    if (runNow === 'Run Benchmark') {
      await runBenchmarkWithProgress();
      loadCache();
    } else if (runNow !== 'Skip (show all)') {
      return; // user dismissed
    }
  }

  let benchMap = new Map();
  if (isCacheFresh() && benchmarkCache?.results) {
    for (const r of benchmarkCache.results) benchMap.set(r.key, r);
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
  const providerItems = [...providers.values()].map(g => ({
    label: g.providerID,
    description: `${g.models.length} model(s)`,
    detail: g.baseURL,
    alwaysShow: true,
  }));
  const providerChoice = await vscode.window.showQuickPick(providerItems, {
    canPickMany: false,
    placeHolder: 'Choose the provider whose models you want to add to BYOK',
    title: 'OpenBYOK — Select Provider',
  });
  if (!providerChoice) return;
  const group = providers.get(providerChoice.label);

  // ---------- Step 2: choose models of that provider ----------
  const statusOrder = { OK: 0, SLOW: 1, UNKNOWN: 2, NO_TOKENS: 3, TIMEOUT: 4, ERROR: 5 };

  const benchResults = group.models.map(m => {
    const cached = benchMap.get(m.key);
    const bench = cached ? {
      status: cached.status,
      ttftMs: cached.ttftMs,
      tokensPerSec: cached.tokensPerSec,
      error: cached.error,
    } : { status: 'UNKNOWN', ttftMs: null, tokensPerSec: null, error: null };
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
    const statusLabel = b.status === 'OK' ? '✅'
      : b.status === 'SLOW' ? '🐌'
      : b.status === 'TIMEOUT' ? '⏱️'
      : b.status === 'ERROR' ? '❌'
      : b.status === 'NO_TOKENS' ? '⚠️'
      : '❓';
    const ctx = m.contextWindow ? `${Math.round(m.contextWindow / 1000)}k ctx` : '? ctx';
    const toks = b.tokensPerSec !== null ? `${b.tokensPerSec} tok/s` : '— tok/s';
    const ttft = b.ttftMs !== null ? `TTFT ${b.ttftMs}ms` : '';
    const errInfo = b.error ? ` — ${b.error.slice(0, 60)}` : '';
    const cacheInfo = useCache ? ` [cache ${cacheAgeStr}]` : '';
    return {
      label: `${statusLabel}  ${m.modelID}`,
      description: `${ctx}  |  ${toks}  |  ${ttft}${errInfo}${cacheInfo}`.trim(),
      picked: b.status === 'OK' || b.status === 'UNKNOWN',
      model: m,
      bench: b,
    };
  });

  const selected = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    placeHolder: `Select models from ${providerChoice.label} to add to VS Code BYOK (cache: ${cacheAgeStr})`,
    title: `OpenCode Console — ${providerChoice.label}`,
  });
  if (!selected || selected.length === 0) return;

  // Build consolidated chatLanguageModels.json entry for this provider only
  const byokEntry = {
    name: `OpenCode ${providerChoice.label}`,
    vendor: 'customendpoint',
    apiKey: `\${input:${INPUT_ID}}`,
    apiType: 'chat-completions',
    models: selected.map(s => {
      const m = s.model;
      const entry = {
        id: m.modelID,
        name: m.name,
        url: `${group.baseURL.replace(/\/+$/, '')}/chat/completions`,
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
      if (m.description) entry.description = m.description;
      else entry.description = `${m.name} — OpenCode Console model (${m.providerID})`;
      if (m.family) entry.family = m.family;
      if (m.releaseDate) entry.releaseDate = m.releaseDate;
      return entry;
    }),
  };

  // Merge with existing chatLanguageModels.json: replace only this provider's entry,
  // keep entries for other providers intact.
  const clmPath = getChatLanguageModelsPath();
  let existing = [];
  try { existing = JSON.parse(fs.readFileSync(clmPath, 'utf8')); } catch {}
  if (!Array.isArray(existing)) existing = [];

  const filtered = existing.filter(e => String(e?.name ?? '') !== `OpenCode ${providerChoice.label}`);
  const merged = [...filtered, byokEntry];
  fs.writeFileSync(clmPath, JSON.stringify(merged, null, 2));

  await ensureInputDefinition();

  vscode.window.showInformationMessage(
    `Added ${selected.length} model(s) from "${providerChoice.label}" to BYOK. Reload VS Code to see them in the model picker.`
  );
}

function getChatLanguageModelsPath() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'Code', 'User', 'chatLanguageModels.json');
}

async function ensureInputDefinition() {
  const settingsPath = path.join(
    process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    'Code', 'User', 'settings.json'
  );
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch {}
  if (!settings.inputs) settings.inputs = [];

  // Validate existing entries: VS Code fails with "Invalid credential" when an
  // ${input:...} referenced by chatLanguageModels.json is missing or malformed.
  const validTypes = ['promptString', 'secretInput', 'secretPrompt', 'pickString'];
  settings.inputs = settings.inputs.filter(i => i && typeof i.id === 'string' && validTypes.includes(i.type));

  if (!settings.inputs.some(i => i.id === INPUT_ID)) {
    settings.inputs.push({
      type: 'promptString', id: INPUT_ID,
      description: 'OpenCode Console API token (st_…)', password: true,
    });
  }

  // Cross-check chatLanguageModels.json: every ${input:X} used there must be declared.
  try {
    const clm = JSON.parse(fs.readFileSync(getChatLanguageModelsPath(), 'utf8'));
    const refs = new Set();
    for (const entry of Array.isArray(clm) ? clm : []) {
      for (const val of [entry.apiKey, ...(entry.models ?? []).map(m => m?.apiKey)]) {
        const m = typeof val === 'string' ? val.match(/\$\{input:([^}]+)\}/) : null;
        if (m) refs.add(m[1]);
      }
    }
    const missing = [...refs].filter(id => !settings.inputs.some(i => i.id === id));
    for (const id of missing) {
      settings.inputs.push({ type: 'promptString', id, description: id, password: true });
    }
    if (missing.length) {
      vscode.window.showWarningMessage(
        `Fixed BYOK config: added missing input declaration(s) for ${missing.join(', ')}. Reload the window.`
      );
    }
  } catch { /* no chatLanguageModels.json */ }

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 4));
}

// ---------- Clear cache ----------

function clearCache() {
  benchmarkCache = null;
  try { fs.unlinkSync(CACHE_FILE); } catch {}
  vscode.window.showInformationMessage('Benchmark cache cleared.');
}

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(u, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        let json; try { json = JSON.parse(data); } catch { json = {}; }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function deactivate() {}

module.exports = { activate, deactivate };