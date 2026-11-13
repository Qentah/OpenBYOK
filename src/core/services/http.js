'use strict';

const https = require('https');

/** GET a URL with headers, parse JSON. Rejects on non-200 or bad JSON. */
function getJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { headers: { Accept: 'application/json', ...headers } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} on ${url}`));
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/** POST JSON body, returns { status, json } (never rejects on HTTP error status). */
function postJson(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let json; try { json = JSON.parse(data); } catch { json = {}; }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

module.exports = { getJson, postJson };
