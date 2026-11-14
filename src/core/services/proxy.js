'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');
const { randomUUID } = require('crypto');

const PROXY_PORT = 18080;
const TARGET_HOST = 'opencode.ai';
const TARGET_PATH_PREFIX = '/inference/go/openai/v1';

let server = null;
const sessionMap = new Map();

function getSessionId(req) {
  // VS Code sends X-Interaction-Id per conversation
  const interactionId = req.headers['x-interaction-id'] || req.headers['x-request-id'];
  if (interactionId) return interactionId;
  // Fallback: stable UUID per client IP
  const key = req.socket.remoteAddress;
  if (!sessionMap.has(key)) sessionMap.set(key, randomUUID());
  return sessionMap.get(key);
}

function start() {
  if (server) return;
  server = http.createServer((req, res) => {
    const targetUrl = new URL(`https://${TARGET_HOST}${TARGET_PATH_PREFIX}${req.url}`);
    const sessionId = getSessionId(req);
    const headers = { ...req.headers, host: TARGET_HOST, 'x-opencode-session': sessionId };
    delete headers['content-length'];
    const proxyReq = https.request(targetUrl, { method: req.method, headers }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });
    proxyReq.on('error', (e) => {
      res.writeHead(502);
      res.end(JSON.stringify({ error: e.message }));
    });
    req.pipe(proxyReq);
  });
  server.listen(PROXY_PORT, '127.0.0.1');
}

function stop() {
  if (server) { server.close(); server = null; }
}

module.exports = { start, stop, PROXY_PORT };
