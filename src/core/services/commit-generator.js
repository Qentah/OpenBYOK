'use strict';

const { chatCompletion } = require('./chat');
const modelResolver = require('./model-resolver');
const { BENCH_PROMPT } = require('../constants');

const MAX_DIFF_CHARS = 12000;

const COMMIT_PROMPT = `You are a git expert. Generate a concise commit message in English (conventional commits style: feat/fix/chore/refactor/docs/test/...) for the following diff. Reply ONLY with the commit message, no explanation, no markdown code block.

Recent commit history (for style consistency):
{history}

Diff:`;

async function resolveModel({ token, settingId }) {
  if (typeof modelResolver.resolveModel === 'function') {
    const m = await modelResolver.resolveModel({ settingId });
    if (m && m.baseURL && m.modelID) return m;
    throw new Error(
      settingId
        ? `Model "${settingId}" not found.`
        : 'No model configured and no benchmark cache. Run "OpenBYOK: Run Benchmark (with progress)".'
    );
  }
  if (settingId) {
    return await modelResolver.resolveModelFor(token, settingId);
  }
  const best = (typeof modelResolver.bestCachedModel === 'function')
    ? modelResolver.bestCachedModel({ sortBy: 'spd' })
    : null;
  if (!best) {
    throw new Error('No model configured and no benchmark cache. Run "OpenBYOK: Run Benchmark (with progress)".');
  }
  try {
    return await modelResolver.resolveModelFor(token, best.key ?? best.modelID);
  } catch {
    return { baseURL: best.baseURL, modelID: best.modelID, name: best.name, prompt: BENCH_PROMPT };
  }
}

/**
 * Deep module owning commit-message generation:
 * diff truncation, prompt template resolution, model resolution, chatCompletion.
 * Returns the generated message string; throws on failure.
 */
async function generateCommitMessage({ token, diff, history, settingId, customPrompt } = {}) {
  let d = (diff == null) ? '' : String(diff);
  if (d.length > MAX_DIFF_CHARS) {
    d = d.slice(0, MAX_DIFF_CHARS) + '\n\n[... diff truncated ...]';
  }

  const template = (typeof customPrompt === 'string' && customPrompt.trim())
    ? customPrompt.trim()
    : COMMIT_PROMPT;
  const prompt = template.replace('{history}', history || '(none)');

  const model = await resolveModel({ token, settingId });
  if (!model || !model.baseURL || !model.modelID) {
    throw new Error('No model available to generate a commit message.');
  }

  const message = await chatCompletion(model.baseURL, model.modelID, token, `${prompt}\n${d}`);
  return message;
}

module.exports = generateCommitMessage;
// Allow property-style access for deep module consumers expecting an object export.
module.exports.generateCommitMessage = generateCommitMessage;
module.exports.MAX_DIFF_CHARS = MAX_DIFF_CHARS;
module.exports.COMMIT_PROMPT = COMMIT_PROMPT;
