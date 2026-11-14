'use strict';

const https = require('https');
const { SECRET_KEY, DEFAULT_SERVER, CLIENT_ID } = require('../constants');

// SecretStorage keys — VS Code SecretStorage is the single source of truth
// (OS-encrypted, removed on uninstall).
const KEY_REFRESH = `${SECRET_KEY}.refresh`;
const KEY_SERVER = `${SECRET_KEY}.server`;
const KEY_EXPIRES = `${SECRET_KEY}.expires`;

let secretStorage; // injected by init()

async function init(secrets) {
  secretStorage = secrets;
}

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
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

/** Refresh the access token using the stored refresh_token. Throws on failure. */
async function refreshToken() {
  const refresh = await secretStorage.get(KEY_REFRESH);
  if (!refresh) throw new Error('No refresh token. Re-register.');
  const serverRaw = (await secretStorage.get(KEY_SERVER)) || DEFAULT_SERVER;
  const server = String(serverRaw).replace(/\/+$/, '');
  const tok = await postJson(`${server}/auth/device/token`, {
    grant_type: 'refresh_token', refresh_token: refresh, client_id: CLIENT_ID,
  });
  const j = tok.json;
  if (!j.access_token) throw new Error(`Refresh refused: ${j.error ?? tok.status}`);
  await secretStorage.store(SECRET_KEY, j.access_token);
  if (j.refresh_token) await secretStorage.store(KEY_REFRESH, j.refresh_token);
  await secretStorage.store(KEY_EXPIRES, String(Date.now() + (j.expires_in ?? 0) * 1000));
  return j.access_token;
}

/**
 * Read the access token from SecretStorage (single source of truth).
 * Auto-refreshes when the stored token is expired and a refresh_token exists.
 */
async function getToken() {
  const token = await secretStorage.get(SECRET_KEY);
  if (!token) throw new Error('No token found. Run "OpenBYOK: Register API Token" first.');
  const expires = Number(await secretStorage.get(KEY_EXPIRES)) || 0;
  const refresh = await secretStorage.get(KEY_REFRESH);
  if (refresh && expires && Date.now() >= expires) {
    try { return await refreshToken(); } catch { /* fall through to stored token */ }
  }
  return token;
}

async function storeToken(accessToken, { server, refreshToken, expiresInMs } = {}) {
  await secretStorage.store(SECRET_KEY, accessToken);
  if (server !== undefined) await secretStorage.store(KEY_SERVER, server);
  if (refreshToken !== undefined) await secretStorage.store(KEY_REFRESH, refreshToken);
  await secretStorage.store(KEY_EXPIRES, String(Date.now() + (expiresInMs ?? 0)));
}

async function deleteToken() {
  for (const key of [SECRET_KEY, KEY_REFRESH, KEY_SERVER, KEY_EXPIRES]) {
    await secretStorage.delete(key);
  }
}

/**
 * Global network wrapper: fetch with automatic Bearer token injection
 * and single retry after a token refresh on 401.
 */
async function authFetch(url, init = {}) {
  const doFetch = async () => {
    const token = await getToken();
    const headers = { ...(init.headers || {}), Authorization: `Bearer ${token}` };
    return fetch(url, { ...init, headers });
  };
  let res = await doFetch();
  if (res.status === 401) {
    try { await refreshToken(); } catch { return res; }
    res = await doFetch();
  }
  return res;
}

module.exports = { init, getToken, storeToken, deleteToken, refreshToken, authFetch };
