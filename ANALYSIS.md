# ANALYSIS — `src/` (OpenBYOK VS Code extension)

> Analyse basée **uniquement** sur le code source présent dans `src/`. Aucune référence à `AGENTS.md` ou `README.md`.

---

## 1. Vue d'ensemble

Extension VS Code (CommonJS, zéro dépendance npm) qui expose des modèles OpenCode Console comme fournisseur BYOK (`customendpoint`) dans VS Code Copilot Chat, avec multi-provider (OpenCode Console + OpenCode Go via proxy local), benchmark, cache, authentification device-flow, logging, télémétrie opt-in et génération de messages de commit.

Point d'entrée : `src/extension.js` → `activate(context)`.

---

## 2. Arborescence

```
src/
├── extension.js                 # wiring : init services + enregistrement commandes
├── core/
│   ├── constants.js             # constantes (endpoints, clés, tuning benchmark/cache)
│   ├── utils.js                 # sleep, runPool, normUrl, userSettingsPath
│   ├── providers/
│   │   ├── opencode.js          # provider OpenCode Console (catalogue, auth, résolution modèle)
│   │   ├── opencode-cli.js      # complément CLI local (export token via `opencode auth export`)
│   │   ├── opencode-go.js       # provider OpenCode Go (modèles via endpoint inference, via proxy local)
│   │   └── registry.js          # registre de providers (Map) — interface commune
│   └── services/
│       ├── token-store.js       # SecretStorage + refresh token + authFetch (retry 401)
│       ├── bench-cache.js       # cache fichier JSON (TTL 2h, écriture atomique)
│       ├── http.js              # getJson / postJson (https, timeout, retry transitoire 429/5xx)
│       ├── proc.js              # execFile wrapper (utf8, timeout 15s, windowsHide)
│       ├── git.js               # diff + log + remplissage SCM input box (JAMAIS commit direct)
│       ├── chat.js              # chatCompletion + chatCompletionStream (SSE, retry 401)
│       ├── vscode-config.js     # chatLanguageModels.json + settings.json inputs (ensureInputDefinition)
│       ├── proxy.js             # proxy HTTP local 127.0.0.1 (session header injection pour OpenCode Go)
│       ├── logger.js            # OutputChannel "OpenBYOK" + hook télémétrie best-effort (opt-in)
│       └── telemetry.js         # module {enabled, logEvent} — présent mais non branché dans les flux
└── features/
    ├── byok/commands.js         # registerToken, selectModels, configureApiKey, refreshToken, logout, removeGroup
    ├── benchmark/
    │   ├── benchmark.js         # benchmarkModel + toCacheEntry
    │   └── commands.js          # runBackgroundBenchmark, runBenchmarkWithProgress, clearCache, status bar, selectFromBenchmark
    └── opengit/command.js       # generateCommitMessage, selectCommitModel
```

---

## 3. Flux d'activation (`extension.js`)

1. `logger.init()` — crée `OutputChannel("OpenBYOK")`.
2. `proxy.start()` — démarre le proxy local (`127.0.0.1:${openbyok.proxyPort}`, défaut 18080) pour OpenCode Go.
3. `tokenStore.init(context.secrets)` — injecte le SecretStorage VS Code.
4. `benchCache.load()` — charge `~/.openbyok-benchmark-cache.json`.
5. Crée un `statusBarItem` (alignement Right, priorité 100), commande `openbyok.selectFromBenchmark`, l'injecte dans `context.subscriptions`, puis `benchmark.setStatusBarItem` / `benchmark.updateStatusBar()` / `show()`.
6. Si le cache n'est pas frais (`!isFresh()`), déclenche `runBackgroundBenchmark()` en arrière-plan (silencieux, flag `running` anti-rentrée) **après** avoir récupéré un token (`tokenStore.getToken()`) ; erreur silencieuse si pas de token.
7. Enregistre les commandes des 3 features (`byok.register`, `benchmark.register`, `opengit.register`).

`deactivate()` → `proxy.stop()`.

---

## 4. Constantes (`core/constants.js`)

- Auth/stockage : `SECRET_KEY = 'openbyok.opencode.token'`, clés dérivées `.refresh`, `.server`, `.expires` dans `token-store.js`.
- Endpoints : 
  - `CONSOLE_API = 'https://opencode.ai/console/api/v2/config'`
  - `CATALOGUE_API = 'https://models.opencode.ai/experimental/v2.0/api.json'`
  - `DEFAULT_SERVER = 'https://opencode.ai/console'`
  - `CLIENT_ID = 'opencode'`
  - `GO_MODELS_URL = 'https://opencode.ai/inference/go/v1/models'` (utilisé par `opencode-go.js`)
- Proxy : `TARGET_HOST = 'opencode.ai'`, `TARGET_PATH_PREFIX = '/inference/go/openai/v1'`, `MAX_SESSIONS = 1000`.
- Cache : `CACHE_FILE = ~/.openbyok-benchmark-cache.json`, `CACHE_MAX_AGE_MS = 2 * 60 * 60 * 1000` (2 h).
- Benchmark : `BENCH_TIMEOUT_MS = 15000`, `BENCH_CONCURRENCY = 8`, `BENCH_PROMPT = "Réponds en une phrase courte : qu'est-ce que la gravité ?"`, `BENCH_SLOW_TTFT_MS = 5000`, `BENCH_SLOW_TOKENS_PER_SEC = 5`.
- Catalogue cache TTL : `CACHE_TTL_MS = 5 * 60 * 1000` (5 min) dans `opencode.js`.

---

## 5. Utilitaires (`core/utils.js`)

- `sleep(ms)` — promesse setTimeout.
- `runPool(items, worker, limit)` — pool de concurrence bornée, préserve l'ordre des résultats.
- `normUrl(url)` — retire les slashes finaux.
- `userSettingsPath()` — chemin `settings.json` utilisateur (APPDATA/Code/User).

---

## 6. Services

### 6.1 `token-store.js` — authentification

- Clés SecretStorage : `openbyok.opencode.token` (access), dérivées `.refresh`, `.server`, `.expires` (epoch ms).
- `init(secrets)` injecte le storage.
- `postJson` local pour le refresh (https, même logique retry que `http.js`).
- `refreshToken()` : POST `/auth/device/token` (`grant_type=refresh_token`), met à jour access/refresh/expires.
- `getToken()` : lit l'access token ; **auto-refresh** si expiré et refresh_token présent.
- `withTokenRetry(action)` : exécute, sur erreur 401/expired, refresh puis retry **une fois**.
- `storeToken(accessToken, {server, refreshToken, expiresInMs})`.
- `deleteToken()` : supprime les 4 clés.
- `authFetch(url, init)` : fetch avec injection Bearer (depuis `getToken()`) + **retry 401 unique** (refresh + re-fetch). Utilisé par `chat.js`.

### 6.2 `bench-cache.js` — cache benchmark

- Cache en mémoire `{timestamp, results[]}` + fichier JSON.
- `load()`, `save(results)` — écriture **atomique** (`.tmp` + `chmod 0o600` + `renameSync`).
- `isFresh()` (TTL `CACHE_MAX_AGE_MS = 2h`), `ageLabel()` (ex: `3h ago`), `getEntry(key)`, `data()`.
- `fastestModel()` : filtre entrées valides, trie par `spd` asc (sec/1k tokens = latence simple) puis `ttftMs` asc ; retourne `{baseURL, modelID, name, spd}` ou `null`.
- `clear()` : vide mémoire + `unlinkSync` fichier.

### 6.3 `http.js` — REST générique

- `getJson(url, headers, timeoutMs)` — GET https, parse JSON, **reject si status ≠ 200**. Retry (max 3, backoff 500ms*2^attempt) sur 429/502/503/504.
- `postJson(url, body, headers, timeoutMs)` — POST, **ne reject pas** sur erreur HTTP, retourne `{status, json}` ; même retry transitoire.
- `DEFAULT_TIMEOUT_MS = 30000`.

### 6.4 `proc.js`

- `execFileAsync(cmd, args, opts)` : wrapper promisify (utf8, timeout 15s, windowsHide).
- `commandExists(cmd, args)` : test existence binaire.

### 6.5 `git.js`

- `workspaceFolder()` : premier dossier workspace (active editor ou 1er dossier).
- `getGitDiff()` : diff staged puis unstaged, retourne `''` si rien.
- `fillScmInputBox(message)` : préremplit l'input box SCM via l'extension Git VS Code (`vscode.git` API). Returns `true`/`false`.
- `getGitLog(n = 5)` : derniers sujets de commit (`git log -n --pretty=format:%s`).

### 6.6 `chat.js` — Chat completions

- `chatCompletion(baseURL, modelID, token, prompt, timeoutMs=60000)` : non-streaming, retourne texte assistant ; throw avec body tronqué sur erreur HTTP. Injection header `x-opencode-session` (UUID session partagé).
- `chatCompletionStream(baseURL, modelID, token, prompt, onToken, signal)` : SSE streaming, appelle `onToken(delta)` ; **retry une fois après refresh** sur 401. Header `x-opencode-session`. Gère `data: ...` et `[DONE]`.

### 6.7 `vscode-config.js` — Configuration VS Code

- `userSettingsPath()`, `getChatLanguageModelsPath()`.
- `readJsonSafe(file, fallback)`.
- `upsertChatLanguageModel(entry)` : merge dans `chatLanguageModels.json` par `name` (remplace existant), écriture atomique (`.tmp` + rename).
- `ensureInputDefinition()` : 
  - Lit `settings.json`, nettoie `inputs[]` (garde `promptString`/`secretPrompt`/`pickString` avec ids valides).
  - Scanne `chatLanguageModels.json` pour collecter tous les `${input:X}` référencés (group `apiKey` + modèles `apiKey`).
  - Ajoute les manquants en `promptString` (password=true).
  - Affiche warning si ajouts (reload requis).
  - Écrit `settings.json` (indentation 4).
- `readChatLanguageModels()` : retourne tableau (ou `[]`).

### 6.8 `proxy.js` — Proxy HTTP local (OpenCode Go)

- Écoute sur `127.0.0.1:${openbyok.proxyPort}` (défaut 18080).
- Forward vers `https://opencode.ai/inference/go/openai/v1${req.url}`.
- Injection header `x-opencode-session` : soit `x-interaction-id`/`x-request-id` de la requête entrante, soit fallback par IP client (Map LRU 1000 entrées, UUID random).
- Request body JSON : si `messages[]` contient `.reasoning`, **supprime** ce champ avant forward.
- Réponse : propage status/headers/body upstream ; erreur upstream → `502` + JSON `{error}`.
- Logs via `logger` (info/error). Démarré à l'activate, arrêté à deactivate.

### 6.9 `logger.js` — OutputChannel + télémétrie best-effort

- `init()` → crée `OutputChannel("OpenBYOK")`.
- `line(level, msg, err)` : timestamp ISO + niveau + message + stack si erreur.
- Si `openbyok.telemetryEnabled === true` : tente `vscode.telemetry.sendEvent('OpenBYOK', {type, message, timestamp, channel})` (best-effort, ignoré si API unavailable).
- Export : `init`, `info`, `warn`, `error`, `show`, `channel`, `isTelemetryEnabled()`.

### 6.10 `telemetry.js` — Module autonome (non utilisé)

- `enabled()` : lit `openbyok.telemetryEnabled`.
- `logEvent(name, data)` : si enabled, écrit dans un `OutputChannel("OpenBYOK Telemetry")` (nouveau channel à chaque appel).
- **Non importé** nulle part dans `src/` (le logger a son propre hook).

---

## 7. Providers (`core/providers/`)

### 7.1 `registry.js` — Interface commune

- `Map` de providers, init avec `opencode` + `opencode-go`.
- Interface requise par provider :
  - `id`, `label`
  - `listModels(token) → Model[]`
  - `findModelById(token, id) → Model`
  - `deviceLogin(noBrowser) → token` (optionnel, auth capability)
  - `refreshToken() → void` (optionnel)
  - `resolveModelFor(token, id) → Model` (optionnel, feature-level)
  - `cliExportToken() / cliAvailable()` (optionnel, CLI locale)
- `register(provider)`, `get(id)`, `getDefault()` (→ `'opencode'`), `list()`.

### 7.2 `opencode.js` — OpenCode Console

- **Catalogue combine** : `fetchConsoleConfig(token)` (API console, providers/baseURL/modèles actifs) + `fetchCatalogue()` (limites/modalités/capacités). Cache 5 min chacun (`_consoleCache`, `_catalogueCache`).
- `indexCatalogue(cat)` : walk récursif, indexe `{id, type:'chat'}` par id ; **préférence NVIDIA** (base_url contient `nvidia.com`).
- `collectChatModels(config, catIndex)` : pour chaque provider/config avec `settings.baseURL`, modèles non désactivés + chat-capable → row consolidée :
  - Capacités: `toolCalling`, `vision` (`modalities.input` contient `image`), `reasoning` (`thinking`), `reasoningEfforts`, `contextWindow`, `maxInputTokens`, `maxOutputTokens`, `family`, `releaseDate`.
  - `key = `${providerID}/${modelID}``, `baseURL = p.settings.baseURL`, `prompt = BENCH_PROMPT`.
- `listModels(token)` : parallel fetch config + catalogue → `collectChatModels` → tri par `key`.
- `findModelById(token, id)` : par `modelID` ou `key`.
- **Auth device flow** (`deviceLogin(noBrowser)`):
  1. `POST /auth/device/code` (`client_id: 'opencode'`) → `device_code`, `user_code`, `verification_uri_complete`, `expires_in`, `interval`.
  2. Ouvre navigateur (`!noBrowser`) ou copie URL dans presse-papiers.
  3. Polling `POST /auth/device/token` (`grant_type=urn:ietf:params:oauth:grant-type:device_code`) ; gère `authorization_pending` (continue) et `slow_down` (+5s interval).
  4. `storeToken(access, {server, refreshToken, expiresInMs})`.
- `refreshToken()` : invalide caches + délègue à `tokenStore.refreshToken()`.
- `resolveModelFor(token, settingId)` : 
  - Si `settingId` → `findModelById`.
  - Sinon `benchCache.fastestModel()` → essaie `findModelById(token, bench.modelID)` ; catch → fallback objet minimal `{baseURL, modelID, name, prompt}`.
  - Sinon throw explicite.

### 7.3 `opencode-cli.js` — Complément CLI locale

- `cliExportToken()` : exécute `opencode auth export opencode` (ou `OPENCODE_CLI_PATH`), parse JSON stdout, retourne `access` actif. Gère erreur binaire absent → return `null`.
- `cliAvailable()` : `true` si `cliExportToken()` réussit.
- Utilisé par `byok/commands.js` pour proposer l'option CLI dans `registerToken` (seulement si détecté).

### 7.4 `opencode-go.js` — OpenCode Go

- `listModels(token)` : GET `GO_MODELS_URL` (`https://opencode.ai/inference/go/v1/models`) avec Bearer token ; parse `data[]` (ou array root) → mapping :
  - `providerID: 'opencode-go'`, `key = \`opencode-go/${id}\``,
  - `baseURL = \`http://127.0.0.1:${proxy.proxyPort()}\`` (proxy local),
  - Capabilités: `hasImageInput` (modalities.input), `toolCalling` (caps.tools.supported), `reasoning` (caps.reasoning.supported), `reasoningEfforts` (array), limites context/output/input.
  - Exclu du benchmark côté client (`!/-free$/i.test(modelID)` dans `benchmark/commands.js`).
- `findModelById(token, id)` : délègue à `listModels()` puis find.

---

## 8. Features (`features/`)

### 8.1 `byok/commands.js` — 6 commandes BYOK

| Commande | Fonction | Détail |
|----------|----------|--------|
| `openbyok.registerToken` | `registerToken()` | QuickPick: Device flow (browser ou manual) **ou** CLI (`opencode auth export`) si `cliAvailable()`. Device flow délègue à `provider.deviceLogin()`. |
| `openbyok.selectModels` | `selectModels()` | 1) Token + `listModels` **tous providers** (registry.list). 2) Si cache non frais → propose "Run Benchmark" / "Skip". 3) Construit `benchMap` depuis cache. 4) Groupe modèles par `providerID`. 5) QuickPick provider (1 choix). 6) QuickPick modèles (multi-sélect, tri `spd` asc puis statut OK→SLOW→UNKNOWN→NO_TOKENS→TIMEOUT→ERROR, puis clé). 7) Construit groupe BYOK `OpenBYOK <providerID>` (vendor `customendpoint`, apiType `chat-completions`, `apiKey = ref existante ? ref : ''`). 8) `upsertChatLanguageModel(byokEntry)` + `ensureInputDefinition()` (best-effort). 9) Info : clé conservée ou à configurer (propose "Configure API Key" / "Reload Window"). |
| `openbyok.configureApiKey` | `configureApiKey(targetGroupName?)` | Liste groupes `OpenBYOK *` (vendors `customendpoint` + `openbyok` pour compat). Si `targetGroupName` fourni → ce groupe. Sinon QuickPick. Tente `vscode.updateLanguageModelsProviderGroupApiKey(vendor, name)` puis `vscode.configureLanguageModelsProviderGroup(vendor, name)` ; fallback → guidance + `workbench.action.chat.manageLanguageModels`. |
| `openbyok.refreshToken` | `refreshToken()` | `provider.refreshToken()`. |
| `openbyok.logout` | `logout()` | `tokenStore.deleteToken()`. |
| `openbyok.removeGroup` | `removeGroup()` | QuickPick groupes `OpenBYOK *` → filtre `chatLanguageModels.json` → écriture atomique + `ensureInputDefinition()` (nettoyage orphelins). Info + reload. |

**Clé logique `resolveByokApiKey(existingEntry)`** :
- Re-sélection groupe existant → conserve `${input:...}` actuel.
- Nouveau groupe → `undefined` → `apiKey: ''` (placeholder vide **obligatoire** pour que VS Code liste le groupe et permette "Update API Key").

### 8.2 `benchmark/benchmark.js`

- `benchmarkModel(model, token, timeoutMs)` : streaming (`chatCompletionStream`), mesure `ttftMs` (premier delta), `totalMs`, compte tokens (deltas `content`), `tokensPerSec = tokens / (totalMs/1000)`.
  - Status :
    - ✅ OK : répondu, `ttftMs ≤ 5000` **et** `tokensPerSec ≥ 5`
    - 🐌 SLOW : `ttftMs > 5000` **ou** `tokensPerSec < 5`
    - ⏱️ TIMEOUT : `AbortController` (timeout)
    - ❌ ERROR : HTTP / parse / réseau
    - ⚠️ NO_TOKENS : HTTP 200 mais 0 delta `content`
    - ❓ UNKNOWN : pas benchmarké
  - `spd = totalMs / tokens * 1000` (sec/1k tokens, latence simple) — **utilisé pour tri** (asc).
- `toCacheEntry(model, bench)` : fusion row modèle + resultat bench → entrée cache (`key`, `modelID`, `name`, `providerID`, `baseURL`, `status`, `ttftMs`, `tokensPerSec`, `spd`, `error`, `contextWindow`, `maxInputTokens`, `maxOutputTokens`, `toolCalling`, `vision`, `thinking`, `reasoningEfforts`, `family`, `releaseDate`).

### 8.3 `benchmark/commands.js` — 3 commandes + status bar

- `runBackgroundBenchmark()` : silencieux, flag `running` anti-rentrée. Récupère token, `listModels` **tous providers**, **exclut** `opencode-go` non `-free`. `runPool` (concurrency config `openbyok.benchConcurrency` ou 8, timeout `openbyok.benchTimeoutMs` ou 15s). Sauve cache (`benchCache.save(results)`) + `updateStatusBar()`.
- `runBenchmarkWithProgress()` : `vscode.window.withProgress` (Notification, cancellable). QuickPick provider : `['All providers', ...registry.list().map(p=>p.id)]`. Même logique modèles/filtrage. Affichage progression + status finale. `benchCache.save(valid)` + `updateStatusBar()`. Retourne `true`/`false`.
- `clearCache()` : `benchCache.clear()` + `updateStatusBar()`.
- `selectFromBenchmark()` : status-bar click → QuickPick global cache :
  - Item 1 : `⚡ Auto (fastest)` → `pick.modelID = ''` (défaut = `fastestModel()`).
  - Items modèles triés par `spd` asc.
  - Sélection → `openbyok.commitModel = pick.modelID` (global) + info message.
- `updateStatusBar()` : si cache frais → `$(dashboard) OpenBYOK: <fastest name> <spd>s/1k (<age>m)` ; sinon `no cache`. Tooltip avec nb modèles + âge.

### 8.4 `opengit/command.js` — 2 commandes commit

- `generateCommitMessage(context)` :
  1. Token + diff git (`getGitDiff`) → si vide warning.
  2. Tronque diff > 12000 chars.
  3. Historique récent `getGitLog(5)`.
  4. Prompt : config `openbyok.commitPrompt` (placeholder `{history}`) ou défaut `COMMIT_PROMPT`.
  5. Résolution modèle : `settingId = openbyok.commitModel` (peut être vide) → `registry.getDefault().resolveModelFor(token, settingId)`.
     - Si `!settingId` et fallback `fastestModel()` → **info message** explicite : "aucun commitModel configuré — utilisation du modèle le plus rapide (X)".
  6. `chatCompletion(model.baseURL, model.modelID, token, prompt + '\n' + diff)` avec progress Window.
  7. `fillScmInputBox(message)` → si succès info "inserted in commit box" ; sinon affiche message pour copie.
- `selectCommitModel()` : QuickPick depuis cache benchmark (filtre `modelID` présent), tri par défaut cache order. Sélection → `openbyok.commitModel = pick.modelID` (global) + info.

---

## 9. Commandes VS Code enregistrées (d'après `package.json` + code)

| Commande | Fichier |
|----------|---------|
| `openbyok.registerToken` | `features/byok/commands.js` |
| `openbyok.selectModels` | `features/byok/commands.js` |
| `openbyok.configureApiKey` | `features/byok/commands.js` |
| `openbyok.refreshToken` | `features/byok/commands.js` |
| `openbyok.logout` | `features/byok/commands.js` |
| `openbyok.removeGroup` | `features/byok/commands.js` |
| `openbyok.runBenchmark` | `features/benchmark/commands.js` |
| `openbyok.clearCache` | `features/benchmark/commands.js` |
| `openbyok.selectFromBenchmark` | `features/benchmark/commands.js` |
| `openbyok.generateCommitMessage` | `features/opengit/command.js` |
| `openbyok.selectCommitModel` | `features/opengit/command.js` |

→ **11 commandes** (menu SCM title pour `generateCommitMessage` avec icône `$(git-commit)`).

---

## 10. Configuration contribuée (`package.json` → `contributes.configuration`)

| Setting | Type | Défaut | Description |
|---------|------|--------|-------------|
| `openbyok.commitModel` | string | `""` | Modèle commit (ex: `poolside/laguna-xs-2.1`) ; vide = Auto (fastest cached). |
| `openbyok.commitPrompt` | string | `""` | Prompt custom commit ; `{history}` placeholder ; vide = défaut. |
| `openbyok.proxyPort` | number | `18080` | Port proxy local OpenCode Go. |
| `openbyok.benchTimeoutMs` | number | `15000` | Timeout par modèle lors du benchmark (ms). |
| `openbyok.benchConcurrency` | number | `8` | Concurrence benchmark (modèles en parallèle). |
| `openbyok.telemetryEnabled` | boolean | `false` | Opt-in télémétrie anonyme (hook logger). |

---

## 11. Dépendances externes

- Runtime VS Code (`require('vscode')`).
- Node built-ins : `https`, `http`, `fs`, `path`, `os`, `child_process`, `url`, `crypto`.
- **Aucune dépendance npm** (package.json : `dependencies: {}`).

---

## 12. Points notables / risques observés dans le code

| Sujet | Constat |
|-------|---------|
| `CACHE_MAX_AGE_MS` | 2h dans le code (`constants.js:17`), cohérent partout. |
| `ensureInputDefinition` | **Appelé** en best-effort après `selectModels()` et `removeGroup()` (plus "non appelé"). |
| `withTokenRetry` | Exporté mais **peu/pas utilisé** dans features observées (où `authFetch` gère le retry 401). |
| `telemetry.js` | Module **non importé** ; le logger a son propre hook best-effort (`sendEvent`) conditionné à `openbyok.telemetryEnabled`. |
| `configureApiKey` | Tente commandes workbench non documentées (`vscode.updateLanguageModelsProviderGroupApiKey`, `vscode.configureLanguageModelsProviderGroup`) ; fallback guidance. |
| `languageModelChatProviders` | Déclaré dans `package.json` (vendor `openbyok`) → **inerte** pour le flux BYOK (`customendpoint`). |
| Cache catalogue | TTL 5 min dans `opencode.js` (variables module `_consoleCache`/`_catalogueCache`). |
| Benchmark `opencode-go` | Modèles non `-free` exclus côté client dans `benchmark/commands.js`. |
| Tri sélection modèles | `spd` asc (sec/1k tokens = latence) comme clé primaire, puis ordre statut, puis clé. `selectFromBenchmark` trie par `spd` asc. |
| `fastestModel()` | Trie `spd` asc puis `ttftMs` asc ; fallback `resolveModelFor` (OpenGIT). |
| Fichiers écrits | `chatLanguageModels.json`, `settings.json` → `%APPDATA%/Code/User/` ; cache → `~/.openbyok-benchmark-cache.json`. |
| Pas de tests unitaires | Dans `src/` ; `scripts/smoke.js` hors périmètre `src/`. |

---

*Généré le 2026-11-14 à partir de `src/` uniquement.*