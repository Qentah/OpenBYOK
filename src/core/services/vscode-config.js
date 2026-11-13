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

/**
 * Merge a BYOK provider entry into chatLanguageModels.json, replacing any
 * existing entry with the same name. Returns the merged array.
 */
function upsertChatLanguageModel(entry) {
  const clmPath = getChatLanguageModelsPath();
  let existing = readJsonSafe(clmPath, []);
  if (!Array.isArray(existing)) existing = [];
  const filtered = existing.filter((e) => String(e?.name ?? '') !== String(entry?.name ?? ''));
  const merged = [...filtered, entry];
  fs.writeFileSync(clmPath, JSON.stringify(merged, null, 2));
  return merged;
}

/**
 * Ensure settings.json declares every ${input:X} referenced by
 * chatLanguageModels.json (VS Code fails with "Invalid credential" otherwise).
 */
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

/** Read the current chatLanguageModels.json array (or [] if missing/invalid). */
function readChatLanguageModels() {
  const clm = readJsonSafe(getChatLanguageModelsPath(), []);
  return Array.isArray(clm) ? clm : [];
}

module.exports = { userSettingsPath, getChatLanguageModelsPath, readJsonSafe, upsertChatLanguageModel, ensureInputDefinition, readChatLanguageModels };
