'use strict';

const vscode = require('vscode');
const tokenStore = require('../../core/services/token-store');
const benchCache = require('../../core/services/bench-cache');
const registry = require('../../core/providers/registry');
const { chatCompletion } = require('../../core/services/chat');
const logger = require('../../core/services/logger');

const MAX_PREFIX_CHARS = 4000;
const MAX_SUFFIX_CHARS = 600;
const COMPLETION_TIMEOUT_MS = 8000;

let lastRequestAt = 0;
const MIN_INTERVAL_MS = 150;

async function resolveModel() {
  const cfg = vscode.workspace.getConfiguration('openbyok');
  const settingId = cfg.get('commitModel')?.toString().trim();
  if (settingId) {
    try {
      const token = await tokenStore.getToken();
      const m = await registry.getDefault().resolveModelFor(token, settingId);
      if (m?.baseURL && m?.modelID) return m;
    } catch { /* fall through */ }
  }
  const fastest = benchCache.fastestModel();
  if (fastest?.baseURL && fastest?.modelID) {
    return { baseURL: fastest.baseURL, modelID: fastest.modelID, name: fastest.name };
  }
  return null;
}

function buildPrompt(document, position) {
  const start = new vscode.Position(0, 0);
  const fullPrefix = document.getText(new vscode.Range(start, position));
  const endPos = new vscode.Position(document.lineCount - 1, document.lineAt(document.lineCount - 1).text.length);
  const fullSuffix = document.getText(new vscode.Range(position, endPos));

  const prefix = fullPrefix.length > MAX_PREFIX_CHARS ? fullPrefix.slice(-MAX_PREFIX_CHARS) : fullPrefix;
  const suffix = fullSuffix.length > MAX_SUFFIX_CHARS ? fullSuffix.slice(0, MAX_SUFFIX_CHARS) : fullSuffix;

  return `Your name is OpenBYOK, you are an inline code completion engine. Complete the code at the cursor. Output ONLY the code to insert, no markdown fences, no explanation, no commentary. If nothing should be inserted, output an empty string.

Language: ${document.languageId}

Code before cursor:
${prefix}

Code after cursor:
${suffix}

Completion:`;
}

async function provideInlineCompletionItems(document, position, context, token) {
  const now = Date.now();
  if (now - lastRequestAt < MIN_INTERVAL_MS) return [];
  lastRequestAt = now;

  if (token?.isCancellationRequested) return [];

  let model;
  try {
    model = await resolveModel();
  } catch { return []; }
  if (!model) return [];

  if (token?.isCancellationRequested) return [];

  const prompt = buildPrompt(document, position);
  let completion;
  try {
    const token = await tokenStore.getToken();
    completion = await chatCompletion(model.baseURL, model.modelID, token, prompt, COMPLETION_TIMEOUT_MS);
  } catch (e) {
    logger.warn('inline completion failed', e);
    return [];
  }

  if (token?.isCancellationRequested) return [];

  if (!completion || !completion.trim()) return [];

  // Strip accidental markdown fences
  let text = completion.trim();
  const fenceMatch = text.match(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/);
  if (fenceMatch) text = fenceMatch[1];

  const item = new vscode.InlineCompletionItem(text);
  try { item.isInlineEdit = true; } catch { /* optional */ }
  return [item];
}

function register(context) {
  const provider = { provideInlineCompletionItems };
  const disposable = vscode.languages.registerInlineCompletionItemProvider('*', provider);
  context.subscriptions.push(disposable);
}

module.exports = { register, provideInlineCompletionItems };