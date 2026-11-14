'use strict';

const vscode = require('vscode');
const { getJson, postJson } = require('../services/http');
const tokenStore = require('../services/token-store');
const benchCache = require('../services/bench-cache');
const { CONSOLE_API, CATALOGUE_API, DEFAULT_SERVER, CLIENT_ID, BENCH_PROMPT } = require('../constants');
const { normUrl, sleep } = require('../utils');

/* ---------- Catalogue / config consolidation ---------- */

let _consoleCache = { data: null, ts: 0 };
let _catalogueCache = { data: null, ts: 0 };
const CACHE_TTL_MS = 5 * 60 * 1000;

async function fetchConsoleConfig(token) {
  if (_consoleCache.data && Date.now() - _consoleCache.ts < CACHE_TTL_MS) return _consoleCache.data;
  const data = await getJson(CONSOLE_API, { Authorization: `Bearer ${token}` });
  _consoleCache = { data, ts: Date.now() };
  return data;
}

async function fetchCatalogue() {
  if (_catalogueCache.data && Date.now() - _catalogueCache.ts < CACHE_TTL_MS) return _catalogueCache.data;
  const data = await getJson(CATALOGUE_API);
  _catalogueCache = { data, ts: Date.now() };
  return data;
}

function indexCatalogue(cat) {
  const index = new Map();
  function walk(obj) {
    if (typeof obj !== 'object' || obj === null) return;
    if (Array.isArray(obj)) { obj.forEach(walk); return; }
    if (typeof obj.id === 'string' && obj.type === 'chat') {
      const baseUrl = obj?.api?.['chat-completions']?.base_url ?? '';
      const isNvidia = baseUrl.includes('nvidia.com');
      if (isNvidia || !index.has(obj.id)) index.set(obj.id, obj);
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
      ? p.models.map((m) => [m.id, m])
      : Object.entries(p.models ?? {});
    for (const [mid, m] of entries) {
      if (m?.disabled === true) continue;
      const caps = m?.capabilities;
      const chatCapable = !caps || (caps.input?.includes('text') && caps.output?.includes('text'));
      if (!chatCapable) continue;

      const c = catIndex.get(mid);
      const modalities = c?.modalities ?? null;
      const hasImageInput = Array.isArray(modalities?.input) &&
        modalities.input.some((x) => String(x).startsWith('image'));
      const catCaps = c?.capabilities ?? {};
      const contextWindow = c?.limit?.context ?? null;
      const maxOutput = c?.limit?.output ?? null;
      const maxInput = c?.limit?.input ?? (contextWindow && maxOutput ? contextWindow - maxOutput : null);

      rows.push({
        provider: 'opencode',
        key: `${pid}/${mid}`,
        providerID: pid,
        modelID: mid,
        name: m?.name ?? c?.name ?? mid,
        description: c?.description ?? null,
        family: c?.family ?? null,
        releaseDate: m?.releaseDate ?? c?.release_date ?? null,
        modalities,
        hasImageInput,
        toolCalling: catCaps?.tools?.supported === true,
        reasoning: catCaps?.reasoning?.supported === true,
        reasoningEfforts: Array.isArray(catCaps?.reasoning?.effort) ? catCaps.reasoning.effort : null,
        contextWindow,
        maxInputTokens: maxInput ?? 128000,
        maxOutputTokens: maxOutput ?? 16384,
        baseURL: p.settings.baseURL,
        prompt: BENCH_PROMPT,
      });
    }
  }
  return rows.sort((a, b) => a.key.localeCompare(b.key));
}

async function listModels(token) {
  const [config, catalogue] = await Promise.all([fetchConsoleConfig(token), fetchCatalogue()]);
  return collectChatModels(config, indexCatalogue(catalogue));
}

/** Find one model by "provider/model" or bare model id in the console config. */
async function findModelById(token, id) {
  const models = await listModels(token);
  const found = models.find((m) => m.modelID === id || m.key === id);
  if (!found) throw new Error(`Model "${id}" not found.`);
  return found;
}

/* ---------- Auth: device flow + refresh ---------- */

async function deviceLogin(noBrowser = false) {
  const server = normUrl(DEFAULT_SERVER);
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
    vscode.window.showInformationMessage(`Confirm code ${dc.user_code} in your browser.`);
  } else {
    await vscode.env.clipboard.writeText(verifyUrl);
    vscode.window.showInformationMessage(
      `Open this URL in your browser:\n${verifyUrl}\n\nCode to confirm: ${dc.user_code}\n(URL copied to clipboard.)`
    );
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
      await tokenStore.storeToken(j.access_token, {
        server, refreshToken: j.refresh_token ?? '', expiresInMs: (j.expires_in ?? 0) * 1000,
      });
      vscode.window.showInformationMessage('OpenCode token registered successfully.');
      return j.access_token;
    }
    if (j.error === 'authorization_pending') continue;
    if (j.error === 'slow_down') { interval += 5000; continue; }
    throw new Error(`Auth failed: ${j.error ?? `HTTP ${tok.status}`}`);
  }
  throw new Error('Authorization timed out.');
}

async function refreshToken() {
  _consoleCache = { data: null, ts: 0 };
  _catalogueCache = { data: null, ts: 0 };
  await tokenStore.refreshToken();
  vscode.window.showInformationMessage('Token refreshed.');
}

/* ---------- Model resolution for features (e.g. OpenGIT) ---------- */

/** Setting openbyok.commitModel > best cached benchmark > error. */
async function resolveModelFor(token, settingId) {
  if (settingId) return findModelById(token, settingId);
  const bench = benchCache.fastestModel();
  if (bench) {
    try { return await findModelById(token, bench.modelID); }
    catch { return { baseURL: bench.baseURL, modelID: bench.modelID, name: bench.name, prompt: BENCH_PROMPT }; }
  }
  throw new Error('No model configured and no benchmark cache. Run "OpenBYOK: Run Benchmark (with progress)".');
}

const cli = require('./opencode-cli');

/* ---------- Optional complement: local OpenCode CLI ---------- */
const cliExportToken = cli.cliExportToken;
const cliAvailable = cli.cliAvailable;

module.exports = {
  id: 'opencode',
  label: 'OpenCode Console',
  fetchConsoleConfig,
  fetchCatalogue,
  listModels,
  findModelById,
  deviceLogin,
  refreshToken,
  resolveModelFor,
  cliExportToken,
  cliAvailable,
};
