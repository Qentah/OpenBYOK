'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const vscode = require('vscode');

function userSettingsPath() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'Code', 'User', 'settings.json');
}

function getChatLanguageModelsPath() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'Code', 'User', 'chatLanguageModels.json');
}

function readJsonSafe(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeChatLanguageModels(entries) {
  const clmPath = getChatLanguageModelsPath();
  const tmp = clmPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2));
  fs.renameSync(tmp, clmPath);
  return entries;
}

function upsertChatLanguageModel(entry) {
  const existing = readChatLanguageModels();
  const filtered = existing.filter((e) => String(e?.name ?? '') !== String(entry?.name ?? ''));
  return writeChatLanguageModels([...filtered, entry]);
}

function removeChatLanguageModel(name) {
  const existing = readChatLanguageModels();
  const filtered = existing.filter((e) => String(e?.name ?? '') !== String(name ?? ''));
  return writeChatLanguageModels(filtered);
}

function listOpenByokGroups() {
  return readChatLanguageModels().filter((e) => String(e?.name ?? '').startsWith('OpenBYOK '));
}

function ensureInputDefinition() {
  const settingsPath = userSettingsPath();
  let settings = readJsonSafe(settingsPath, {});
  if (typeof settings !== 'object' || settings === null) settings = {};
  if (!Array.isArray(settings.inputs)) settings.inputs = [];

  const validTypes = ['promptString', 'secretInput', 'secretPrompt', 'pickString'];
  settings.inputs = settings.inputs.filter(
    (i) => i && typeof i.id === 'string' && validTypes.includes(i.type)
  );

  const clm = readJsonSafe(getChatLanguageModelsPath(), []);
  const refs = new Set();
  for (const entry of Array.isArray(clm) ? clm : []) {
    for (const val of [entry.apiKey, ...(entry.models ?? []).map((m) => m?.apiKey)]) {
      const m = typeof val === 'string' ? val.match(/\$\{input:([^}]+)\}/) : null;
      if (m) refs.add(m[1]);
    }
  }
  settings.inputs = settings.inputs.filter((i) => refs.has(i.id));
  const missing = [...refs].filter((id) => !settings.inputs.some((i) => i.id === id));
  for (const id of missing) {
    settings.inputs.push({ type: 'promptString', id, description: id, password: true });
  }
  if (missing.length) {
    vscode.window.showWarningMessage(
      `Fixed BYOK config: added missing input declaration(s) for ${missing.join(', ')}. Reload the window.`
    );
  }

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 4));
}

function syncByokConfig() {
  // Consolidated BYOK config sync pass: repair input definitions first
  // (so `${input:...}` references resolve), then model limits (so context
  // budgets are valid). Single entry point for callers.
  try { ensureInputDefinition(); } catch (e) { /* best effort */ }
  try { repairModelLimits(); } catch (e) { /* best effort */ }
}

function repairModelLimits() {
  const clmPath = getChatLanguageModelsPath();
  let clm = readJsonSafe(clmPath, []);
  if (!Array.isArray(clm)) return;
  let changed = false;
  for (const entry of clm) {
    for (const m of (entry?.models ?? [])) {
      const out = Number(m?.maxOutputTokens);
      let inp = Number(m?.maxInputTokens);
      if (!Number.isFinite(out) || out <= 0) continue;
      if (m.maxOutputTokens > 200000) { m.maxOutputTokens = 131072; changed = true; out = 131072; }
      // VS Code treats context = maxInputTokens + maxOutputTokens and rejects
      // configs where the output reservation leaves no room. A missing/zero
      // (or too small) input makes the context window too small for the large
      // static system prompts Copilot sends -> "exceed context budget".
      if (!Number.isFinite(inp) || inp < 32768) {
        m.maxInputTokens = Math.max(out, 65536);
        changed = true;
      }
    }
  }
  if (changed) {
    const tmp = clmPath + '.tmp';
    try { fs.writeFileSync(tmp, JSON.stringify(clm, null, 2)); fs.renameSync(tmp, clmPath); } catch { /* best effort */ }
  }
}

function readChatLanguageModels() {
  const clm = readJsonSafe(getChatLanguageModelsPath(), []);
  return Array.isArray(clm) ? clm : [];
}

module.exports = { userSettingsPath, getChatLanguageModelsPath, readJsonSafe, writeChatLanguageModels, upsertChatLanguageModel, removeChatLanguageModel, listOpenByokGroups, ensureInputDefinition, readChatLanguageModels, repairModelLimits, syncByokConfig };
