'use strict';

const vscode = require('vscode');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const SECRET_KEY = 'openbyok.opencode.token';
const CONSOLE_API = 'https://opencode.ai/console/api/v2/config';
const CLIENT_ID = 'opencode';

let secretStorage;

/* ---------- Token (même logique qu'extension.js) ---------- */

async function getToken() {
  const t = await secretStorage.get(SECRET_KEY);
  if (t) return t;
  try {
    const store = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.openbyok-console.json'), 'utf8'));
    if (store?.access) return store.access;
  } catch {}
  throw new Error('Aucun token trouvé. Exécutez "OpenBYOK: Register API Token" d\'abord.');
}

/* ---------- Helpers réseau ---------- */

function fetchConsoleConfig(token) {
  return new Promise((resolve, reject) => {
    const url = new URL(CONSOLE_API);
    const req = https.request(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} sur la config console`));
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/* Recherche un modèle par son identifiant exact dans la config OpenCode Console */
async function findModelById(token, modelId) {
  const config = await fetchConsoleConfig(token);
  const providers = config?.providers ?? {};
  for (const [, p] of Object.entries(providers)) {
    if (!p?.settings?.baseURL) continue;
    const entries = Array.isArray(p.models)
      ? p.models.map(m => [m.id, m])
      : Object.entries(p.models ?? {});
    for (const [mid, m] of entries) {
      if (m?.disabled === true) continue;
      const id = m?.id ?? mid;
      const name = m?.name ?? id;
      if (id === modelId || mid === modelId) {
        return {
          baseURL: p.settings.baseURL.replace(/\/+$/, ''),
          modelID: id,
          name,
        };
      }
    }
  }
  throw new Error(`Modèle "${modelId}" introuvable dans la configuration OpenCode Console.`);
}

/* Lit le résultat du benchmark cache le plus rapide (meilleur tokens/s, puis plus bas TTFT) */
function getFastestBenchmarkModel() {
  const cacheFile = path.join(os.homedir(), '.openbyok-benchmark-cache.json');
  try {
    const data = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    const results = data?.results;
    if (!Array.isArray(results) || results.length === 0) return null;

    // Garde seulement les résultats qui ont des infos exploitables
    const valid = results.filter(r => r && r.baseURL && r.modelID);

    // Trie : tokens/s décroissant, puis ttftMs croissant (le plus rapide d'abord)
    valid.sort((a, b) => {
      const fa = a.tokensPerSec ?? 0;
      const fb = b.tokensPerSec ?? 0;
      if (fb !== fa) return fb - fa;
      const ta = a.ttftMs ?? Infinity;
      const tb = b.ttftMs ?? Infinity;
      return ta - tb;
    });

    const r = valid[0];
    return {
      baseURL: r.baseURL,
      modelID: r.modelID,
      name: r.name || r.modelID,
    };
  } catch {}
  return null;
}

/* Résout le modèle à utiliser pour le commit : setting openbyok.commitModel, ou le plus rapide du benchmark */
async function resolveCommitModel(token) {
  const configured = vscode.workspace.getConfiguration('openbyok').get('commitModel');
  if (configured && String(configured).trim()) {
    return findModelById(token, String(configured).trim());
  }

  const bench = getFastestBenchmarkModel();
  if (bench) {
    return bench;
  }

  throw new Error(
    'Aucun modèle configuré (openbyok.commitModel) et aucun résultat de benchmark disponible. ' +
    'Lancez "OpenBYOK: Run Benchmark (with progress)" d\'abord.'
  );
}

/* ---------- Git ---------- */

async function getGitDiff() {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!folder) throw new Error('Aucun dossier de workspace ouvert.');
  for (const args of [['diff', '--cached'], ['diff']]) {
    try {
      const { stdout } = await execFileAsync('git', args, {
        encoding: 'utf8', timeout: 15000, windowsHide: true, cwd: folder,
      });
      if (stdout && stdout.trim()) return stdout;
    } catch {}
  }
  return '';
}

/* ---------- Appel au modèle laguna ---------- */

async function callCommitModel(token, baseURL, modelID, diff) {
  const prompt = `You are a git expert. Generate a concise commit message in English (conventional commits style: feat/fix/chore/refactor/docs/test/...) for the following diff. Reply ONLY with the commit message, no explanation, no markdown code block.

Diff:
${diff}`;

  const res = await fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      model: modelID,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} — ${text.slice(0, 200)}`);
  }
  const json = await res.json();
  return (json.choices?.[0]?.message?.content ?? '').trim();
}

/* ---------- Commande ---------- */

function register(context) {
  secretStorage = context.secrets;

  context.subscriptions.push(
    vscode.commands.registerCommand('opengit.generateCommitMessage', async () => {
      let token;
      try {
        token = await getToken();
      } catch (e) {
        vscode.window.showErrorMessage(`OpenGIT: ${e.message}`);
        return;
      }

      let diff;
      try {
        diff = await getGitDiff();
      } catch (e) {
        vscode.window.showErrorMessage(`OpenGIT: ${e.message}`);
        return;
      }

      if (!diff || !diff.trim()) {
        vscode.window.showWarningMessage('OpenGIT: Aucun changement détecté dans le dépôt git.');
        return;
      }

      try {
        const { baseURL, modelID, name } = await resolveCommitModel(token);
        vscode.window.showInformationMessage(`OpenGIT: Génération du message de commit avec le modèle ${name || modelID}…`);
        const message = await callCommitModel(token, baseURL, modelID, diff);

        // Pré-remplir la zone de message du Source Control (Git intégré)
        const gitExt = vscode.extensions.getExtension('vscode.git');
        if (gitExt && gitExt.isActive) {
          const gitApi = await gitExt.exports.getAPI(1);
          const repo = gitApi.repositories.find(r => r.rootUri.fsPath === vscode.workspace.workspaceFolders?.[0]?.uri.fsPath) ?? gitApi.repositories[0];
          if (repo) {
            repo.inputBox.value = message;
            vscode.window.showInformationMessage(`Message généré par ${name || modelID} — inséré dans la zone de commit.`);
          } else {
            vscode.window.showWarningMessage('Dépôt Git non trouvé pour insérer le message.');
          }
        } else {
          // Fallback si l'extension Git n'est pas encore activée
          const choice = await vscode.window.showInputBox({
            value: message,
            prompt: `Message de commit généré par ${name || modelID}. Modifiez si besoin, puis validez.`,
            title: 'OpenGIT — Commit Message',
          });
          if (choice === undefined) return;

          const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          if (!folder) {
            vscode.window.showWarningMessage('OpenGIT: Aucun dossier de workspace pour effectuer le commit.');
            return;
          }

          await execFileAsync('git', ['commit', '-m', choice], {
            encoding: 'utf8', timeout: 30000, windowsHide: true, cwd: folder,
          });
          vscode.window.showInformationMessage('Commit effectué avec succès.');
        }
      } catch (e) {
        vscode.window.showErrorMessage(`OpenGIT: Échec — ${e.message}`);
      }
    })
  );
}

module.exports = { register };
