'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');
const { randomUUID } = require('crypto');
const vscode = require('vscode');
const logger = require('./logger');

const TARGET_HOST = 'opencode.ai';
const TARGET_PATH_PREFIX = '/inference/go/openai/v1';
const MAX_SESSIONS = 1000;

let server = null;
const sessionMap = new Map();

function getSessionId(req) {
  const interactionId = req.headers['x-interaction-id'] || req.headers['x-request-id'];
  if (interactionId) return interactionId;
  const key = req.socket.remoteAddress;
  if (!sessionMap.has(key)) {
    if (sessionMap.size >= MAX_SESSIONS) {
      const oldest = sessionMap.keys().next().value;
      sessionMap.delete(oldest);
    }
    sessionMap.set(key, randomUUID());
  }
  return sessionMap.get(key);
}

function proxyPort() {
  try { return Number(vscode.workspace.getConfiguration('openbyok').get('proxyPort')) || 18080; }
  catch { return 18080; }
}

function start() {
  if (server) return;
  const port = proxyPort();
  server = http.createServer((req, res) => {
    let targetUrl;
    try { targetUrl = new URL(`https://${TARGET_HOST}${TARGET_PATH_PREFIX}${req.url}`); }
    catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); return; }
    const sessionId = getSessionId(req);
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = Buffer.concat(chunks);
      try {
        const json = JSON.parse(body.toString());
        // VS Code Copilot Chat attaches non-standard fields (reasoning traces,
        // chain-of-thought ids/summaries, etc.) to messages that upstream
        // rejects as unsupported parameters. Keep only OpenAI-standard fields.
        const ALLOWED_TOP_LEVEL = new Set(['model','messages','stream','temperature','top_p','max_tokens','max_completion_tokens','n','stop','presence_penalty','frequency_penalty','logit_bias','user','seed','tools','tool_choice','response_format','logprobs','top_logprobs','stream_options','parallel_tool_calls','reasoning_effort']);
                const ALLOWED_MSG_FIELDS = new Set(['role','content','name','tool_calls','tool_call_id','function_call','refusal','audio']);
                // Only keep OpenAI-standard fields at both top level and per message.
                for (const k of Object.keys(json)) { if (!ALLOWED_TOP_LEVEL.has(k)) delete json[k]; }
        if (Array.isArray(json.messages)) {
          for (const m of json.messages) {
                    if (m && typeof m === 'object' && !Array.isArray(m)) {
                      for (const k of Object.keys(m)) { if (!ALLOWED_MSG_FIELDS.has(k)) delete m[k]; }
            }
          }
        }
        body = Buffer.from(JSON.stringify(json));
      } catch { /* not JSON, pass through */ }
      const headers = { ...req.headers, host: TARGET_HOST, 'x-opencode-session': sessionId, 'content-length': body.length };
      const proxyReq = https.request(targetUrl, { method: req.method, headers }, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
      });
      proxyReq.on('error', (e) => {
        logger.error('proxy upstream error', e);
        if (!res.headersSent) res.writeHead(502);
        res.end(JSON.stringify({ error: e.message }));
      });
      proxyReq.write(body);
      proxyReq.end();
    });
    req.on('error', (e) => { logger.error('proxy request error', e); });
  });
  server.on('error', (e) => {
    logger.error(`proxy failed to listen on ${port}`, e);
    server = null;
  });
  server.listen(port, '127.0.0.1', () => {
    logger.info(`OpenBYOK proxy listening on 127.0.0.1:${port}`);
  });
}

function stop() {
  if (server) { try { server.close(); } catch {} server = null; }
}

module.exports = { start, stop, proxyPort, TARGET_PATH_PREFIX };
