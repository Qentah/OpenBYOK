'use strict';

const { getJson } = require('../services/http');
const tokenStore = require('../services/token-store');

const GO_MODELS_URL = 'https://opencode.ai/inference/go/v1/models';
const GO_BASE_URL = 'https://opencode.ai/inference/go/openai/v1';

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
    const contextWindow = m?.limit?.context ?? 128000;
    const maxOutput = m?.limit?.output ?? 16384;
    const maxInput = m?.limit?.input ?? (contextWindow && maxOutput ? contextWindow - maxOutput : contextWindow);
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
      contextWindow,
      maxInputTokens: maxInput,
      maxOutputTokens: maxOutput,
      baseURL: GO_BASE_URL,
      prompt: 'Réponds en une phrase courte : qu\'est-ce que la gravité ?',
    });
  }
  return rows.sort((a, b) => a.key.localeCompare(b.key));
}

async function findModelById(token, id) {
  const models = await listModels();
  return models.find((m) => m.modelID === id || m.key === id) ?? null;
}

module.exports = {
  id: 'opencode-go',
  label: 'OpenCode Go',
  listModels,
  findModelById,
};
