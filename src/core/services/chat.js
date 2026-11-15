'use strict';

const { randomUUID } = require('crypto');
const tokenStore = require('./token-store');
const { normUrl } = require('../utils');

const SESSION_ID = randomUUID();

function sessionId() {
  return SESSION_ID;
}

/**
 * Non-streaming chat completion. Returns the assistant text.
 * Throws with a truncated response body on HTTP error.
 */
async function chatCompletion(baseURL, modelID, token, prompt, timeoutMs = 60000) {
  const url = `${normUrl(baseURL)}/chat/completions`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const body = JSON.stringify({
    model: modelID,
    messages: [{ role: 'user', content: prompt }],
    stream: false,
  });
  const init = {
    method: 'POST',
    signal: ac.signal,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'x-opencode-session': sessionId(),
    },
    body,
  };
  try {
    const res = await tokenStore.authFetch(url, init);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} — ${text.slice(0, 200)}`);
    }
    const json = await res.json();
    return (json.choices?.[0]?.message?.content ?? '').trim();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Streaming chat completion (SSE). Calls onToken(textChunk) for each content delta.
 * Resolves when the stream is done or [DONE]. Caller handles abort via signal.
 * Retries once after a token refresh on 401.
 */
async function chatCompletionStream(baseURL, modelID, token, prompt, onToken, signal) {
  const url = `${normUrl(baseURL)}/chat/completions`;
  const body = JSON.stringify({
    model: modelID,
    messages: [{ role: 'user', content: prompt }],
    stream: true,
  });
  // Single retry-on-401 transport: authFetch handles token injection + refresh.
  // authFetch uses fetch internally; stream reads from res.body.
  const res = await tokenStore.authFetch(url, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'x-opencode-session': sessionId(),
    },
    body,
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
      if (payload === '[DONE]') return;
      let chunk;
      try { chunk = JSON.parse(payload); } catch { continue; }
      const text = chunk.choices?.[0]?.delta?.content ?? '';
      if (text) onToken(text);
    }
  }
}

module.exports = { chatCompletion, chatCompletionStream };
