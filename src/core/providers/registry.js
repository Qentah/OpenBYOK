'use strict';

const opencode = require('./opencode');
const opencodeGo = require('./opencode-go');

/**
 * Provider registry. The extension core only talks to providers through this
 * interface, so OpenCode stays fully optional at the architecture level:
 * adding a provider = one module + one entry here.
 *
 * Provider interface:
 *   id, label
 *   listModels(token)            -> Model[]  ({ key, providerID, modelID, baseURL, … })
 *   findModelById(token, id)     -> Model
 *   deviceLogin(noBrowser)       -> token    (optional, auth capability)
 *   refreshToken()               -> void     (optional)
 *   resolveModelFor(token, id)   -> Model    (optional, feature-level resolution)
 *   cliExportToken()/cliAvailable() -> optional local-CLI complement
 */
const providers = new Map([[opencode.id, opencode], [opencodeGo.id, opencodeGo]]);

function register(provider) {
  providers.set(provider.id, provider);
}

function get(id) {
  const p = providers.get(id);
  if (!p) throw new Error(`Unknown provider "${id}".`);
  return p;
}

function getDefault() {
  return get('opencode');
}

function list() {
  return [...providers.values()];
}

module.exports = { register, get, getDefault, list };
