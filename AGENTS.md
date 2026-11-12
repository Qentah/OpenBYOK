# AGENTS.md — Extension : BYOK (vscode/)

## Rôle de cet agent

Tu es l'expert dedicado à l'extension VS Code **openbyok** (dossier `vscode/`). Tu dois la maîtriser complètement : son code (`src/extension.js`), ses commandes, son environnement de configuration VS Code (fichiers utilisateurs), et ses dépendances externes (zéro dépendance npm, pure CommonJS).

Quand on te demande une modification, un débogage ou une explication sur cette extension, tu dois agir comme si tu l'avais écrite toi-même.

---

## Structure du projet (vscode/)

```
vscode/
├── package.json          # Manifest VS Code (6 commandes, engines ^1.95, aucune dépendance)
├── .vscodeignore         # Exclusions pour vsce package
├── src/
│   └── extension.js      # ~590 lignes, CommonJS, point d'entrée "main"
└── README.md             # Documentation utilisation
```

**Fichier clé** : `vscode/src/extension.js` — tout y est : auth, fetch, benchmark, cache, écriture `chatLanguageModels.json`, `settings.json`.

---

## État de l'environnement (Windows)

| Élément | Chemin | Commentaire |
|---------|--------|-------------|
| Extension | `.\` | Dossier à ouvrir/installer dans VS Code |
| Token stocké (extension) | `~\.openbyok-console.json` | {server, access, refresh, expires} |
| Cache benchmark | `~\.openbyok-benchmark-cache.json` | {timestamp, results[]}, TTL 24h |
| BYOK modèles | `%APPDATA%\Code\User\chatLanguageModels.json` | Écrit par l'extension |
| Inputs secrets | `%APPDATA%\Code\User\settings.json` → `inputs[]` | `opencodeApiKey` + éventuels `chat.lm.secret.*` |
| SecretStorage VS Code | `context.secrets` (chiffré OS) | Clé `openbyok.opencode.token` |

Vérifier le token actuel :
```powershell
type $env:USERPROFILE\.openbyok-console.json
```

---

## Les 6 commandes VS Code

| Commande | Titre | Rôle |
|----------|-------|------|
| `openbyok.registerToken` | OpenBYOK: Register API Token (st_…) | Device flow (browser / manuel) ou récupération CLI |
| `openbyok.selectModels` | OpenBYOK: Select Models for BYOK | Sélection multi-modèles avec statut OK/SLOW/KO (depuis cache ou benchmark live) |
| `openbyok.refreshToken` | OpenBYOK: Refresh Token | Rafraîchit `st_…` via refresh_token |
| `openbyok.logout` | OpenBYOK: Logout | Supprime token SecretStorage + fichier local |
| `openbyok.runBenchmark` | OpenBYOK: Run Benchmark (with progress) | Benchmark avec barre de progression, annulable, écrit le cache |
| `openbyok.clearCache` | OpenBYOK: Clear Benchmark Cache | Vide le cache mémoire + fichier |

---

## Flux d'authentification (zéro dépendance OpenCode local)

1. **Device flow** : `POST /auth/device/code` → navigateur → polling `POST /auth/device/token` → stocke `access` (st_…) dans `SecretStorage` + `~\.openbyok-console.json`.
2. **CLI OpenCode** (optionnel) : `opencode auth export opencode` → extrait le `access` actif → stocke dans SecretStorage.
3. **Lecture du token** : `getToken()` → SecretStorage d'abord, sinon `~\.openbyok-console.json`, sinon erreur.
4. **Refresh** : `POST /auth/device/token` avec `grant_type:refresh_token` → met à jour SecretStorage + fichier local.
5. **Pas de SQLite, pas de `@opencode/cli` obligatoire, pas de lecture de `opencode.db`.**

---

## Système de benchmark & cache

### Seuils de statut (dans `benchmarkModel`)
| Statut | Condition |
|--------|-----------|
| ✅ OK | répondu, ttft ≤ 5s, tokens/s ≥ 5 |
| 🐌 SLOW | ttft > 5s **ou** ttft > 30% du timeout **ou** tokens/s < 5 |
| ⏱️ TIMEOUT | AbortController (15s) |
| ❌ ERROR | HTTP / parse / réseau |
| ⚠️ NO_TOKENS | réponse HTTP 200 mais aucun `content` émis |
| ❓ UNKNOWN | pas encore benchmarké |

### Paramètres
- Timeout par modèle : **15s**
- Concurrence : **8** requêtes parallèles
- Prompt test : `"Réponds en une phrase courte : qu'est-ce que la gravité ?"`
- Endpoint appelé : `{baseURL}/chat/completions` (Bearer `st_…`, content-type JSON, **pas de `x-org-id`**)

### Cache (`~\.openbyok-benchmark-cache.json`)
- TTL : **24 heures**
- `activate()` lance `runBackgroundBenchmark()` après 5s si le cache est périmé (silencieux, sans UI)
- `selectModels()` : si cache frais → affichage immédiat ; sinon propose "Run Benchmark" (avec progression) avant l'ouverture du sélecteur
- Ordre d'affichage : OK → SLOW → UNKNOWN → NO_TOKENS → TIMEOUT → ERROR ; puis tokens/s décroissant

---

## Configuration BYOK écrite par l'extension

### `chatLanguageModels.json`
- Vendor : `customendpoint`
- `apiKey` : `"${input:opencodeApiKey}"` (référence le secret VS Code)
- `apiType` : `chat-completions`
- Une entrée par provider OpenCode (regroupe les modèles sélectionnés par `baseURL`)
- Chaque modèle : `id`, `name`, `url`, `toolCalling`, `vision`, `maxInputTokens`, `maxOutputTokens`, `thinking` (si reasoning), `supportsReasoningEffort`/`reasoningEffortFormat`, `description` (fallback : `"Nom — OpenCode Console model (providerID)"`)

### `settings.json` → `inputs[]`
L'extension garantit la présence de :
```json
{ "type": "promptString", "id": "opencodeApiKey", "description": "OpenCode Console API token (st_…)", "password": true }
```
Et déclare automatiquement tout `${input:X}` manquant référencé dans `chatLanguageModels.json` (évite l'erreur VS Code "Invalid credential" si un autre provider référencie un input non déclaré).

### Important
Après écriture de `chatLanguageModels.json`, **recharger la fenêtre VS Code** (`Developer: Reload Window`) pour que les modèles apparaissent dans le picker.

---

## Règles de modification

1. **Aucune compilation** : CommonJS pur, `require('vscode')` fourni par le runtime. Éditer `src/extension.js` → `Developer: Reload Window` pour appliquer.
2. **Installation depuis la source** : "Developer: Install Extension from Location..." → sélectionner le dossier `vscode/`. Ou symlink dans `%USERPROFILE%\.vscode\extensions\openbyok`.
3. **Packaging .vsix** : `vsce package --no-dependencies` (pas de build TS).
4. **Vérification syntaxe** : `node -c src/extension.js` (doit retourner "Syntax OK").
5. **Ne jamais committer le token** : `~\.openbyok-console.json` et `~\.openbyok-benchmark-cache.json` sont locaux, hors repo.

---

## Débogage courant

| Symptôme | Cause probable | Action |
|----------|---------------|--------|
| "Invalid credential" | `${input:X}` dans `chatLanguageModels.json` non déclaré dans `settings.json` → `inputs` | L'extension répare automatiquement via `ensureInputDefinition()`, sinon ajouter manuellement |
| Modèles absents dans le picker | `chatLanguageModels.json` écrit mais VS Code pas rechargé | `Developer: Reload Window` |
| Pas de token | `getToken()` lève | Exécuter "OpenBYOK: Register API Token" |
| Cache pas utilisé | `~\.openbyok-benchmark-cache.json` absent ou > 24h | "OpenBYOK: Run Benchmark (with progress)" ou attendre le background |
| `x-org-id` manquant | Nécessaire ? Non — le proxy accepte Bearer seul | Ne pas ajouter |

---

## Exemples de prompts pour cet agent

- "Ajoute une 7ème commande `openbyok.exportReport` qui écrit le cache benchmark dans un fichier CSV."
- "Pourquoi `selectModels()` ne trie pas par provider avant par statut ? Corrige."
- "Modifie le texte de descrîption par défaut pour inclure le `baseURL`."
- "L'extension rate si le token est expiré — ajoute un test de validité avant `fetchConsolidatedModels`."
- "Crée une version TypeScript de `src/extension.js` avec `tsc`."

---

## Fichiers à ne pas toucher sans raison

- `package.json` : `main` doit rester `./src/extension.js` ; `activationEvents` doivent couvrir toutes les commandes ajoutées.
- `SECRET_KEY` et `INPUT_ID` : changés ici → impactent `chatLanguageModels.json` (`${input:${INPUT_ID}}`) et `settings.json`.
- `CACHE_FILE` / `CACHE_MAX_AGE_MS` : comportement background et sélection.
