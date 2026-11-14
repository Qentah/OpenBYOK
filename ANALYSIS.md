# ANALYSIS — `src/` (OpenBYOK VS Code extension)

> Analyse basée uniquement sur le code source présent dans `src/`. Aucune référence à `AGENTS.md` ou `README.md`.

## 1. Vue d'ensemble

Extension VS Code (CommonJS, zéro dépendance npm) qui expose des modèles OpenCode Console comme fournisseur BYOK (`customendpoint`) dans VS Code Copilot Chat, avec benchmark, cache, authentification device-flow et génération de messages de commit.

Point d'entrée : `src/extension.js` → `activate(context)`.

## 2. Arborescence

```
src/
├── extension.js                 # wiring : init services + enregistrement commandes
├── core/
│   ├── constants.js             # constantes (endpoints, clés, tuning benchmark)
│   ├── utils.js                 # sleep, runPool, normUrl, userSettingsPath
│   ├── providers/
│   │   ├── opencode.js          # provider OpenCode (catalogue, auth, résolution modèle)
│   │   ├── opencode-cli.js      # complément CLI local (export token)
│   │   └── registry.js          # registre de providers (Map)
│   └── services/
│       ├── token-store.js       # SecretStorage + refresh token + authFetch
│       ├── bench-cache.js       # cache fichier JSON (TTL)
│       ├── http.js              # getJson / postJson (https)
│       ├── proc.js              # execFile wrapper
│       ├── git.js               # diff + remplissage SCM input box
│       ├── chat.js              # chat completions (streaming + non-streaming)
│       └── vscode-config.js     # chatLanguageModels.json + settings.json inputs
└── features/
    ├── byok/commands.js         # commandes auth + selectModels + configureApiKey
    ├── benchmark/
    │   ├── benchmark.js         # benchmarkModel + toCacheEntry
    │   └── commands.js          # runBenchmarkWithProgress, runBackgroundBenchmark, clearCache
    └── opengit/command.js       # génération de message de commit
```

## 3. Flux d'activation (`extension.js`)

1. `tokenStore.init(context.secrets)` — injecte le SecretStorage VS Code.
2. `benchCache.load()` — charge `~/.openbyok-benchmark-cache.json`.
3. Si le cache n'est pas frais (`!isFresh()`), lance `runBackgroundBenchmark()` en arrière-plan (silencieux, `.catch(() => {})`).
4. Enregistre les commandes des 3 features (`byok`, `benchmark`, `opengit`).

`deactivate()` est vide.

## 4. Constantes (`core/constants.js`)

- Auth/stockage : `SECRET_KEY = 'openbyok.opencode.token'`, `INPUT_ID = 'opencodeApiKey'`.
- Endpoints : `CONSOLE_API`, `CATALOGUE_API`, `DEFAULT_SERVER`, `CLIENT_ID = 'opencode'`.
- Cache : `CACHE_FILE = ~/.openbyok-benchmark-cache.json`, `CACHE_MAX_AGE_MS = 2h` (7 200 000 ms).
- Benchmark : `BENCH_TIMEOUT_MS = 15000`, `BENCH_CONCURRENCY = 8`, `BENCH_PROMPT`, `BENCH_SLOW_TTFT_MS = 5000`, `BENCH_SLOW_TOKENS_PER_SEC = 5`.

## 5. Utilitaires (`core/utils.js`)

- `sleep(ms)` — promesse setTimeout.
- `runPool(items, worker, limit)` — pool de concurrence bornée, préserve l'ordre des résultats.
- `normUrl(url)` — retire les slashes finaux.
- `userSettingsPath()` — chemin `settings.json` utilisateur (APPDATA/Code/User).

## 6. Services

### 6.1 `token-store.js` — authentification

- Clés SecretStorage dérivées : `SECRET_KEY`, `KEY_REFRESH`, `KEY_SERVER`, `KEY_EXPIRES`.
- `init(secrets)` injecte le storage.
- `postJson` local (https) pour le refresh.
- `refreshToken()` : POST `/auth/device/token` avec `grant_type=refresh_token`, met à jour access/refresh/expires dans SecretStorage.
- `getToken()` : lit l'access token ; auto-refresh si expiré et refresh_token présent.
- `withTokenRetry(action)` : exécute, sur erreur 401/expired, refresh puis retry.
- `storeToken(accessToken, {server, refreshToken, expiresInMs})`.
- `deleteToken()` : supprime les 4 clés.
- `authFetch(url, init)` : fetch avec injection Bearer + retry 401.

### 6.2 `bench-cache.js` — cache benchmark

- Cache en mémoire `{timestamp, results[]}` + fichier JSON.
- `load()`, `save(results)`, `isFresh()` (TTL 2h), `ageLabel()`, `getEntry(key)`, `fastestModel()` (tri tokens/s desc puis ttft asc), `clear()`, `data()`.

### 6.3 `http.js`

- `getJson(url, headers)` : GET https, parse JSON, reject si status ≠ 200.
- `postJson(url, body, headers)` : POST, retourne `{status, json}`, ne reject pas sur erreur HTTP.

### 6.4 `proc.js`

- `execFileAsync(cmd, args, opts)` : wrapper promisify avec utf8, timeout 15s, windowsHide.
- `commandExists(cmd, args)`.

### 6.5 `git.js`

- `workspaceFolder()` : premier dossier workspace.
- `getGitDiff()` : diff staged puis unstaged, retourne '' si rien.
- `fillScmInputBox(message)` : préremplit l'input box SCM via l'extension Git.

### 6.6 `chat.js`

- `chatCompletion(baseURL, modelID, token, prompt)` : non-streaming, retourne le texte assistant ; throw avec body tronqué sur erreur HTTP.
- `chatCompletionStream(baseURL, modelID, token, prompt, onToken, signal)` : SSE, appelle onToken par delta, retry une fois après refresh sur 401.

### 6.7 `vscode-config.js`

- `userSettingsPath()`, `getChatLanguageModelsPath()`.
- `readJsonSafe(file, fallback)`.
- `upsertChatLanguageModel(entry)` : merge dans `chatLanguageModels.json` par `name`, écrit le fichier.
- `ensureInputDefinition()` : garantit que `settings.json` déclare chaque `${input:X}` référencé dans `chatLanguageModels.json` ; ajoute les manquants en `promptString` password.
- `readChatLanguageModels()` : retourne le tableau (ou []).

## 7. Providers

### 7.1 `opencode.js`

- `fetchConsoleConfig(token)` → GET `CONSOLE_API` avec Bearer.
- `fetchCatalogue()` → GET `CATALOGUE_API`.
- `indexCatalogue(cat)` : walk récursif, indexe les objets `{id, type:'chat'}` par id (priorité Nvidia).
- `collectChatModels(config, catIndex)` : pour chaque provider avec `settings.baseURL`, pour chaque modèle non désactivé et chat-capable, construit une row avec capacités (image, tools, reasoning, context window, tokens). Tri par key.
- `listModels(token)` : fetch config + catalogue en parallèle, collecte.
- `findModelById(token, id)` : cherche par modelID ou key.
- `deviceLogin(noBrowser)` : device flow OAuth (code → polling token → storeToken).
- `refreshToken()` : délègue à tokenStore.
- `resolveModelFor(token, settingId)` : settingId → findModelById ; sinon fastestModel du cache ; sinon erreur.
- `cliExportToken` / `cliAvailable` : réexportés depuis `opencode-cli`.

### 7.2 `opencode-cli.js`

- `cliExportToken()` : tente `opencode auth export opencode` (ou `OPENCODE_CLI_PATH`), parse JSON, retourne le access actif.
- `cliAvailable()` : true si cliExportToken réussit.

### 7.3 `registry.js`

- Map de providers, init avec `opencode`.
- `register`, `get`, `getDefault` (opencode), `list`.

## 8. Features

### 8.1 `byok/commands.js`

Commandes enregistrées :
- `openbyok.registerToken` → `registerToken()` : quick pick device flow / CLI.
- `openbyok.selectModels` → `selectModels()` : sélection provider puis modèles, écriture BYOK.
- `openbyok.configureApiKey` → `configureApiKey()` : tente commandes natives VS Code, sinon guidance.
- `openbyok.refreshToken` → `refreshToken()`.
- `openbyok.logout` → `logout()`.

`resolveByokApiKey(existingEntry)` : conserve un `${input:...}` existant, sinon `undefined` (champ omis → placeholder vide).

`selectModels()` :
1. Récupère token + modèles.
2. Si cache non frais, propose benchmark live.
3. Construit benchMap depuis le cache.
4. Groupe les modèles par providerID.
5. Quick pick provider.
6. Quick pick modèles (tri par statut puis tokens/s).
7. Construit `byokEntry` (vendor customendpoint, apiType chat-completions, models avec capacités).
8. `apiKey = apiKeyRef ?? ''`.
9. `upsertChatLanguageModel(byokEntry)`.
10. Message d'info (clé conservée ou à configurer).

### 8.2 `benchmark/benchmark.js`

- `benchmarkModel(model, token, timeoutMs)` : streaming, mesure TTFT, totalMs, tokens, tokensPerSec ; statuts OK/SLOW/TIMEOUT/ERROR/NO_TOKENS.
- `toCacheEntry(model, bench)` : fusionne row + résultat en entrée cache.

### 8.3 `benchmark/commands.js`

- `runBackgroundBenchmark()` : benchmark silencieux de tous les modèles, sauvegarde cache.
- `runBenchmarkWithProgress()` : avec barre de progression, annulable.
- `clearCache()` : vide cache mémoire + fichier.
- `register()` : enregistre `openbyok.runBenchmark` et `openbyok.clearCache`.

### 8.4 `opengit/command.js`

- `generateCommitMessage(context)` : récupère token, diff git, résout le modèle (setting `openbyok.commitModel` ou fastest cached), génère le message via `chatCompletion`, préremplit le SCM input box.
- Enregistre `opengit.generateCommitMessage`.

## 9. Commandes VS Code enregistrées (selon le code)

| Commande | Fichier |
|----------|---------|
| `openbyok.registerToken` | byok/commands.js |
| `openbyok.selectModels` | byok/commands.js |
| `openbyok.configureApiKey` | byok/commands.js |
| `openbyok.refreshToken` | byok/commands.js |
| `openbyok.logout` | byok/commands.js |
| `openbyok.runBenchmark` | benchmark/commands.js |
| `openbyok.clearCache` | benchmark/commands.js |
| `opengit.generateCommitMessage` | opengit/command.js |

## 10. Dépendances externes

- Runtime VS Code (`require('vscode')`).
- Node built-ins : `https`, `fs`, `path`, `os`, `child_process`.
- Aucune dépendance npm.

## 11. Points notables / risques observés dans le code

- `CACHE_MAX_AGE_MS` = 2h dans le code (constante), alors que la doc externe mentionne 24h — divergence.
- `ensureInputDefinition` est défini mais non appelé dans `extension.js` ni dans `byok/commands.js` (non invoqué dans le flux observé).
- `withTokenRetry` défini mais non utilisé dans les features observées.
- `configureApiKey` tente des commandes VS Code non documentées (`vscode.updateLanguageModelsProviderGroupApiKey`, `vscode.configureLanguageModelsProviderGroup`).
- `fastestModel()` trie par tokens/s desc puis ttft asc ; `resolveModelFor` l'utilise comme fallback.
- Le cache est écrit dans le home utilisateur (`~/.openbyok-benchmark-cache.json`), hors workspace.
- `chatLanguageModels.json` et `settings.json` sont écrits dans `%APPDATA%/Code/User/`.
- Pas de tests unitaires dans `src/`.