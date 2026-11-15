'use strict';

const { getJson } = require('../services/http');
const { sanitizeLimits } = require('../utils');
const tokenStore = require('../services/token-store');

const proxy = require('../services/proxy');
const GO_MODELS_URL = 'https://opencode.ai/inference/go/v1/models';
function goBaseUrl() { return `http://127.0.0.1:${proxy.proxyPort()}`; }

async function listModels() {
  const token = await tokenStore.getToken();
  const data = await getJson(GO_MODELS_URL, { Authorization: `Bearer ${token}` });
  const items = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
  const rows = [];
  for (const m of items) {
    const id = m?.id;
    if (typeof id !== 'string') continue;
    const caps = m?.capabilities ?? {};
    const modalities = m?.modalities ?? null;
    const hasImageInput = Array.isArray(modalities?.input) &&
      modalities.input.some((x) => String(x).startsWith('image'));
    const limits = sanitizeLimits(m?.limit?.context, m?.limit?.input, m?.limit?.output);
    const reasoningEfforts = Array.isArray(caps?.reasoning?.effort) ? caps.reasoning.effort : null;
    rows.push({
      provider: 'opencode-go',
      key: `opencode-go/${id}`,
      providerID: 'opencode-go',
      modelID: id,
      name: m?.name ?? id,
      description: m?.description ?? null,
      family: m?.family ?? null,
      releaseDate: m?.release_date ?? null,
      modalities,
      hasImageInput,
      toolCalling: caps?.tools?.supported === true,
      reasoning: caps?.reasoning?.supported === true,
      reasoningEfforts,
      contextWindow: limits.contextWindow,
      maxInputTokens: limits.maxInputTokens,
      maxOutputTokens: limits.maxOutputTokens,
      baseURL: goBaseUrl(),
      prompt: 'Réponds en une phrase courte : qu\'est-ce que la gravité ?',
    });
  }
  return rows.sort((a, b) => a.key.localeCompare(b.key));
}

async function findModelById(token, id) {
  const models = await listModels();
  const found = models.find((m) => m.modelID === id || m.key === id);
  if (!found) throw new Error(`Model "${id}" not found.`);
  return found;
}

module.exports = {
  id: 'opencode-go',
  label: 'OpenCode Go',
  listModels,
  findModelById,
};
