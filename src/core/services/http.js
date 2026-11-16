'use strict';

const https = require('https');
const { URL } = require('url');

const DEFAULT_TIMEOUT_MS = 30000;

const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 500;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function isTransient(status) {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

/** GET a URL with headers, parse JSON. Rejects on non-200 or bad JSON or timeout. Retries on 429/5xx with backoff. */
async function getJson(url, headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const u = new URL(url);
      const res = await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search,
          method: 'GET', headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', ...headers },
        }, (r) => {
          let data = '';
          r.on('data', (c) => (data += c));
          r.on('end', () => resolve({ status: r.statusCode, data }));
        });
        req.on('error', reject);
        req.setTimeout(timeoutMs, () => { req.destroy(new Error(`Timeout after ${timeoutMs}ms on ${url}`)); });
        req.end();
      });
      if (isTransient(res.status) && attempt < MAX_RETRIES) {
        await sleep(BASE_BACKOFF_MS * Math.pow(2, attempt));
        continue;
      }
      if (res.status !== 200) throw new Error(`HTTP ${res.status} on ${url}`);
      try { return JSON.parse(res.data); } catch (e) { throw e; }
    } catch (e) {
      lastErr = e;
      if (attempt < MAX_RETRIES) { await sleep(BASE_BACKOFF_MS * Math.pow(2, attempt)); continue; }
      throw e;
    }
  }
  throw lastErr;
}

async function postJson(url, body, headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const payload = JSON.stringify(body);
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const u = new URL(url);
      const res = await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'Content-Length': Buffer.byteLength(payload), 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', ...headers },
        }, (r) => {
          let data = '';
          r.on('data', (c) => (data += c));
          r.on('end', () => {
            let json; try { json = JSON.parse(data); } catch { json = {}; }
            resolve({ status: r.statusCode, json, data });
          });
        });
        req.on('error', reject);
        req.setTimeout(timeoutMs, () => { req.destroy(new Error(`Timeout after ${timeoutMs}ms on ${url}`)); });
        req.write(payload);
        req.end();
      });
      if (isTransient(res.status) && attempt < MAX_RETRIES) {
        await sleep(BASE_BACKOFF_MS * Math.pow(2, attempt));
        continue;
      }
      return { status: res.status, json: res.json };
    } catch (e) {
      lastErr = e;
      if (attempt < MAX_RETRIES) { await sleep(BASE_BACKOFF_MS * Math.pow(2, attempt)); continue; }
      throw e;
    }
  }
  throw lastErr;
}

module.exports = { getJson, postJson, DEFAULT_TIMEOUT_MS };
