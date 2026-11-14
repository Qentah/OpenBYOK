# AGENTS.md — Extension : OpenBYOK (vscode/)

## Rôle de cet agent

Tu es l'expert dédié à l'extension VS Code **openbyok** (dossier `vscode/`) : son code modulaire (`src/`), ses 8 commandes, les fichiers de configuration VS Code qu'elle écrit, et ses dépendances externes (zéro dépendance npm, CommonJS pur, aucun build).

Agis comme si tu l'avais écrite toi-même. **Le code est la source de vérité, ce document n'en est que le reflet.** Ne cite jamais un fait de ce fichier sans l'avoir confirmé dans `src/` : si les deux divergent, c'est le fichier qui est faux.

### Stratégie de maintenance documentaire (obligatoire)

Ce document et `README.md` sont traités comme du code : leur mise à jour fait partie de la *Definition of Done* de toute grosse feature. Historiquement, leur dérive après le refactor mono-fichier → modules a coûté plusieurs sessions ; la règle ci-dessous empêche que cela se reproduise.

**Après chaque grosse feature validée** — nouvelle commande, nouveau provider, changement d'architecture ou de modèle de credentials, modification d'un seuil / endpoint / chemin de fichier, refactor de structure — et **avant** de déclarer le travail terminé :

1. **Réaligner** : relire les sections impactées d'`AGENTS.md` **et** de `README.md`, corriger tout énoncé devenu faux (nombre de commandes, chemins, constantes, TTL, seuils, flux).
2. **Vérifier** : chaque valeur chiffrée ou chemin cité doit correspondre au code — grep/lecture ciblée (`core/constants.js`, `package.json`, `core/providers/registry.js`), jamais de mémoire.
3. **Compléter** : nouvelle règle d'architecture, nouveau piège rencontré, dette connue apparue → ajouter une ligne ici, ne pas la laisser uniquement dans la conversation.
4. **Élaguer** : supprimer ce qui n'existe plus (fallback retiré, fonction renommée, option disparue). Ne garder ni « peut-être » ni notes historiques non actionnables.
5. **Horodater** : mettre à jour la ligne *Dernière vérification code* ci-dessous.

Une modification cosmétique (typo, commentaire, log) ne déclenche **pas** cette boucle — sinon elle serait abandonnée. Le critère de déclenchement est : *un lecteur de ce document risquerait désormais d'écrire du code faux*.

> Dernière vérification code : 2026-11-14 (proxy local opencode-go, session header via X-Interaction-Id).

---

## Structure réelle du projet (vérifiée sur `src/`)

```
vscode/
├── package.json          # Manifest : 8 commandes, engines ^1.95, 0 dépendance npm
├── .vscodeignore
└── src/
    ├── extension.js      # POINT D'ENTRÉE = wiring seul (~35 lignes), AUCUNE logique ici
    ├── core/
    │   ├── constants.js            # toutes les constantes
    │   ├── utils.js                # sleep, runPool(items, worker, limit), normUrl, userSettingsPath
    │   ├── providers/
    │   │   ├── opencode.js         # provider OpenCode Console (catalogue, device flow, résolution)
    │   │   ├── opencode-cli.js     # complément CLI local (optionnel, activé si binaire détecté)
    │   │   └── registry.js         # Map de providers — interface commune
    │   └── services/
    │       ├── token-store.js      # SecretStorage + refresh + authFetch (enveloppe réseau)
    │       ├── bench-cache.js      # cache JSON fichier (TTL)
    │       ├── http.js             # getJson / postJson uniquement (https brut)
    │       ├── chat.js             # chatCompletion + chatCompletionStream (SSE)
    │       ├── proc.js             # execFile wrapper
    │       ├── git.js              # getGitDiff + fillScmInputBox (JAMAIS de commit direct)
    │       └── vscode-config.js    # chatLanguageModels.json (+ ensureInputDefinition)
    └── features/
        ├── byok/commands.js        # registerToken, selectModels, configureApiKey, refreshToken, logout
        ├── benchmark/{benchmark,commands}.js
        └── opengit/command.js      # génération de message de commit
```

Règles d'architecture (à respecter dans toute modification) :
- `extension.js` ne contient que `activate()`/`deactivate()` : init services + `feature.register(context)`.
- Chaque feature expose `register(context)` ; les chemins `require` depuis `features/*` sont `../../core/...` (2 niveaux).
- Le core ne parle aux fournisseurs que via `registry` (interface : `listModels`, `findModelById`, `deviceLogin`, `refreshToken`, `resolveModelFor`, `cliExportToken`/`cliAvailable` optionnels). Ajouter un provider = un module + une entrée dans `registry.js`.
- `http.js` = REST générique ; `chat.js` = chat completions. Ne pas remélanger.
- Git : **préremplir uniquement la SCM input box** (`fillScmInputBox`), jamais `git commit` direct.
- Benchmark en arrière-plan : déclenché **uniquement à l'activation si le cache est expiré**, jamais par intervalle/timer périodique.

---

## État de l'environnement (Windows)

| Élément | Chemin | Commentaire |
|---------|--------|-------------|
| Source extension | `.\` (dossier `vscode/`) | à installer via "Install Extension from Location" |
| Token console | SecretStorage VS Code (`context.secrets`) | **source unique de vérité**, plus aucun fichier local |
| Cache benchmark | `~\.openbyok-benchmark-cache.json` | `{timestamp, results[]}`, TTL **2 h** |
| BYOK modèles | `%APPDATA%\Code\User\chatLanguageModels.json` | écrit par l'extension |
| Inputs secrets | `%APPDATA%\Code\User\settings.json` → `inputs[]` | gérés par VS Code, pas par nous |

> ⚠️ `~\.openbyok-console.json` **n'existe plus** : le fallback fichier a été supprimé lors du refactor. Ne le réintroduis pas.

Clés SecretStorage (dans `token-store.js`) : `openbyok.opencode.token`, et dérivées `.refresh`, `.server`, `.expires`.

---

## Les 8 commandes VS Code

| Commande | Fichier | Rôle |
|----------|---------|------|
| `openbyok.registerToken` | features/byok | Device flow (browser ou URL manuelle) ; option CLI proposée **seulement si** `opencode` détecté |
| `openbyok.selectModels` | features/byok | 2 étapes : choix du **provider** puis sélection des modèles (statuts OK/SLOW/…) |
| `openbyok.configureApiKey` | features/byok | Guide le flux natif "Update API Key" (commandes workbench non publiques → fallback panneau Manage) |
| `openbyok.refreshToken` | features/byok | Refresh explicite du `st_…` |
| `openbyok.logout` | features/byok | Supprime les 4 clés SecretStorage |
| `openbyok.runBenchmark` | features/benchmark | Benchmark avec barre de progression, annulable, écrit le cache |
| `openbyok.clearCache` | features/benchmark | Vide cache mémoire + fichier |
| `opengit.generateCommitMessage` | features/opengit | Diff git → message → préremplit la SCM input box (bouton dans la barre SCM) |

---

## Modèle de credentials — LA règle la plus importante

C'est le point qui a coûté le plus de corrections en session. À appliquer strictement :

1. **Deux secrets distincts, ne jamais confondre :**
   - le token **console** `st_…` (auth API OpenCode, device flow) → SecretStorage de l'extension, clé `openbyok.opencode.token` ;
   - la clé **BYOK** utilisée par Copilot Chat pour appeler les modèles → secret **natif VS Code** `${input:chat.lm.secret.X}`.
2. **Ne JAMAIS inventer un id `chat.lm.secret.X`.** Ces ids sont créés uniquement par VS Code quand l'utilisateur passe par *Manage Language Models → Update API Key*. Un hash côté extension ne peut jamais correspondre → référence morte → erreur `Invalid credential` (bug historique `b34029f3`).
3. **Toujours utiliser le vendor connu `customendpoint`.** Déclarer notre propre vendor (`openbyok`) dans `package.json` ne fonctionne pas : le groupe n'apparaît pas dans *Manage Language Models* (l'extension n'est pas chargée comme fournisseur reconnu). L'entrée `languageModelChatProviders` encore présente dans `package.json` est **inerte** — ne pas s'en servir pour écrire des groupes.
4. **Nom des groupes BYOK : `OpenBYOK <providerID>`**, jamais `OpenCode <providerID>` (demande utilisateur explicite).
5. Comportement `selectModels()` / `resolveByokApiKey()` :
   - re-sélection d'un groupe existant → **conserver** son `${input:...}` actuel ;
   - nouveau groupe → écrire `apiKey: ""` (placeholder vide **obligatoire** : sans champ `apiKey`, VS Code n'affiche pas le groupe et le flux "Update API Key" est inatteignable). L'utilisateur saisit la clé → VS Code crée son propre id et réécrit le fichier.
6. **Ne jamais toucher au groupe `OpenCode Go`** (vendor `opencodego`, fourni par l'extension tierce `ltmoerdani.opencode-copilot-chat`, pleinement fonctionnel). Nos écritures sont filtrées par `name` uniquement — vérifier avant tout nettoyage.
7. `ensureInputDefinition()` (dans `vscode-config.js`) répare les `${input:X}` manquants dans `settings.json`. Il est **exporté mais non appelé** par les flux courants : ne le branche pas sans raison, et ne le supprime pas (utilisé en dépannage manuel).

### Erreurs fréquentes à ne pas reproduire

| Symptôme | Cause réelle | Action |
|----------|--------------|--------|
| `Invalid credential` | référence `${input:X}` non résolue (jamais créée par VS Code) | faire saisir la clé via Update API Key ; ne pas régénérer d'id |
| Groupe absent du picker | `chatLanguageModels.json` écrit mais fenêtre non rechargée | `Developer: Reload Window` |
| Groupe absent de *Manage Language Models* | champ `apiKey` manquant | écrire `apiKey: ""` |
| `HTTP 403` / Cloudflare code 1010 sur `opencode.ai` | User-Agent bloqué (pas un souci d'auth) | tester avec UA navigateur/PowerShell ; ne pas conclure à un token invalide |
| Token expiré | — | `getToken()` rafraîchit automatiquement si `.expires` dépassé et refresh présent ; `authFetch()` rejette une fois après refresh sur 401 |

---

## Flux d'authentification console

1. `POST {DEFAULT_SERVER}/auth/device/code` (`client_id: 'opencode'`) → navigateur ou URL copiée (mode manual).
2. Polling `POST /auth/device/token` (`grant_type: urn:ietf:params:oauth:grant-type:device_code`) ; gère `authorization_pending` et `slow_down` (+5 s).
3. `storeToken(access, {server, refreshToken, expiresInMs})` → SecretStorage.
4. Refresh : `POST /auth/device/token` avec `grant_type=refresh_token`.
5. Optionnel : `opencode auth export opencode` (ou `OPENCODE_CLI_PATH`) → extrait le `access` actif. Aucun `opencode.db`, aucune SQLite, aucune dépendance npm obligatoire.
6. Endpoint proxy : Bearer seul suffit — **ne pas ajouter `x-org-id`**.

---

## Système de benchmark & cache

Seuils (dans `benchmarkModel`, `core/constants.js`) :

| Statut | Condition |
|--------|-----------|
| ✅ OK | répondu, ttft ≤ 5 s, tokens/s ≥ 5 |
| 🐌 SLOW | ttft > 5 s **ou** tokens/s < 5 |
| ⏱️ TIMEOUT | `AbortController` (15 s) |
| ❌ ERROR | HTTP / parse / réseau |
| ⚠️ NO_TOKENS | HTTP 200 mais aucun delta `content` |
| ❓ UNKNOWN | pas encore benchmarké |

Paramètres : timeout **15 s**, concurrence **8**, prompt test `"Réponds en une phrase courte : qu'est-ce que la gravité ?"`, endpoint `{baseURL}/chat/completions` en streaming SSE.

Cache `~\.openbyok-benchmark-cache.json` : TTL **2 h** (`CACHE_MAX_AGE_MS = 2 * 60 * 60 * 1000`).
- `activate()` → `runBackgroundBenchmark()` silencieux si cache non frais (flag `running` anti-rentrée).
- `selectModels()` → cache frais : affichage immédiat ; sinon propose *Run Benchmark* (progression) ou *Skip (show all)*.
- Tri d'affichage : OK → SLOW → UNKNOWN → NO_TOKENS → TIMEOUT → ERROR, puis tokens/s décroissant.
- `fastestModel()` (tri tokens/s desc, puis ttft asc) sert de fallback à `resolveModelFor()` pour OpenGIT ; dans ce cas un message affiche clairement le fallback.

---

## Configuration BYOK écrite par l'extension

### `chatLanguageModels.json`
- `name`: `OpenBYOK <providerID>` · `vendor`: `customendpoint` · `apiType`: `chat-completions` · `apiKey`: ref existante ou `""`.
- Un groupe par provider (modèles regroupés par `baseURL`).
- Par modèle : `id`, `name`, `url`, `toolCalling`, `vision`, `maxInputTokens`, `maxOutputTokens`, `description` (celle du catalogue ; fallback `"Nom — OpenBYOK Console model (providerID)"`), plus `thinking: true` si reasoning, `supportsReasoningEffort`/`reasoningEffortFormat: 'chat-completions'` si efforts disponibles, `family`, `releaseDate`.

### Consolidation des modèles (`providers/opencode.js`)
Merge de `CONSOLE_API` (providers, `settings.baseURL`, modèles actifs) et `CATALOGUE_API` (limites, modalités, capacités). `indexCatalogue()` parcourt récursivement l'objet/array et indexe `{id, type:'chat'}` en **préférant l'entrée dont `api['chat-completions'].base_url` contient `nvidia.com`**. Modèles ignorés si `disabled === true` ou non chat-capables.

### Important
Après écriture de `chatLanguageModels.json` : **`Developer: Reload Window`** pour voir les modèles dans le picker.

---

## Règles de modification

1. **Aucune compilation** : CommonJS pur. Éditer le module concerné → `Developer: Reload Window`.
2. **Installation depuis la source** : "Developer: Install Extension from Location…" → dossier `vscode/`. (Le symlink documenté ailleurs n'est pas garanti présent : vérifier `%USERPROFILE%\.vscode\extensions`.)
3. **Packaging .vsix** : `vsce package --no-dependencies`.
4. **Vérification syntaxe** : `node -c <fichier>` sur chaque fichier modifié.
5. **Smoke-test hors VS Code** : stubber `Module._load` pour `'vscode'` (`workspace`, `window`, `env`, `extensions`, `commands`, `ProgressLocation`) et passer `context = { secrets, subscriptions: [] }`, puis appeler `activate()`.
6. Ne jamais committer de secret : rien d'authentifiant dans le repo ni dans les docs.
7. `package.json` : `main` doit rester `./src/extension.js` ; toute nouvelle commande doit être déclarée ET enregistrée dans le `register()` de sa feature.

---

## Dettes connues (ne pas "corriger" sans le demander)

- `constants.INPUT_ID` (`'opencodeApiKey'`) : résidu de l'ancien modèle de secret, plus référencé par aucun flux.
- `token-store.withTokenRetry()` : exporté, non utilisé par les features (`authFetch` couvre le retry 401).
- Doublon `userSettingsPath()` : défini dans `core/utils.js` et `core/services/vscode-config.js`.
- Coquille dans un commentaire de bandeau de `core/constants.js` (`// --- Benchmark tuning ---S`).
- Aucun test automatisé dans le repo.
