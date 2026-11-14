# OpenBYOK — Mermaid Diagrams

> Diagrammes Mermaid générés depuis l'analyse du code source `src/` (2026-11-15).
> À visualiser dans VS Code (extensión **Markdown Preview Mermaid Support**) ou tout viewer Mermaid.

---

## 1. Architecture Globale

```mermaid
graph TB
    subgraph VSCode[VS Code Extension Host]
        direction TB
        Ext[extension.js\nactivate/deactivate]
        
        subgraph Core[core/]
            Const[constants.js]
            Utils[utils.js]
            
            subgraph Providers[providers/]
                Registry[registry.js\nMap<id, Provider>]
                OCode[opencode.js\nOpenCode Console]
                OCLI[opencode-cli.js\nCLI local]
                OGo[opencode-go.js\nOpenCode Go]
            end
            
            subgraph Services[services/]
                Token[token-store.js\nSecretStorage + authFetch]
                Bench[bench-cache.js\nJSON file + TTL 2h]
                HTTP[http.js\ngetJson/postJson + retry]
                Proc[proc.js\nexecFileAsync]
                Git[git.js\ndiff + SCM input]
                Chat[chat.js\ncompletion + stream SSE]
                VSC[vscode-config.js\nchatLanguageModels.json]
                Proxy[proxy.js\n127.0.0.1:18080]
                Log[logger.js\nOutputChannel OpenBYOK]
                Tele[telemetry.js\nmodule orphelin]
            end
        end
        
        subgraph Features[features/]
            BYOK[byok/commands.js\n6 commandes]
            BenchCmd[benchmark/commands.js\n3 cmd + status bar]
            OGit[opengit/command.js\n2 commandes commit]
        end
    end
    
    %% Wiring
    Ext --> Log
    Ext --> Proxy
    Ext --> Token
    Ext --> Bench
    Ext --> BYOK
    Ext --> BenchCmd
    Ext --> OGit
    
    %% Core internal
    Registry --> OCode
    Registry --> OGo
    OCode --> Token
    OCode --> Bench
    OCode --> HTTP
    OCode --> Chat
    OCode --> OCLI
    OGo --> Token
    OGo --> HTTP
    OGo --> Proxy
    BYOK --> Registry
    BYOK --> Bench
    BYOK --> VSC
    BYOK --> Token
    BenchCmd --> Registry
    BenchCmd --> Token
    BenchCmd --> Bench
    BenchCmd --> Chat
    OGit --> Registry
    OGit --> Token
    OGit --> Git
    OGit --> Chat
    OGit --> Bench
    
    %% External
    Token -->|SecretStorage| VSCodeSecrets[(VS Code\nSecretStorage)]
    VSC -->|chatLanguageModels.json| CLM[(%APPDATA%/Code/User\nchatLanguageModels.json)]
    VSC -->|settings.json inputs| Settings[(%APPDATA%/Code/User\nsettings.json)]
    Bench -->|~/.openbyok-benchmark-cache.json| BenchFile[(~/.openbyok-benchmark-cache.json)]
    Proxy -->|HTTPS| OAI[(opencode.ai)]
    OCode -->|HTTPS| OAI
    OGo -->|HTTPS| OAI
    Git -->|git CLI| Repo[(Workspace Git)]
    
    classDef ext fill:#1e1e1e,color:#d4d4d4,stroke:#007acc;
    classDef core fill:#2d2d2d,color:#d4d4d4,stroke:#4ec9b0;
    classDef feat fill:#2d2d2d,color:#d4d4d4,stroke:#ce9178;
    classDef extSys fill:#0e1a2b,color:#9cdcfe,stroke:#569cd6;
    
    class Ext ext;
    class Const,Utils,Registry,OCode,OCLI,OGo,Token,Bench,HTTP,Proc,Git,Chat,VSC,Proxy,Log,Tele core;
    class BYOK,BenchCmd,OGit feat;
    class VSCodeSecrets,CLM,Settings,BenchFile,OAI,Repo extSys;
```

---

## 2. Flux d'Activation (`extension.js`)

```mermaid
flowchart TD
    Start(["activate(context)"]) --> LogInit["logger.init()\nOutputChannel OpenBYOK"]
    LogInit --> ProxyStart["proxy.start()\n127.0.0.1:openbyok.proxyPort"]
    ProxyStart --> TokenInit["tokenStore.init(context.secrets)"]
    TokenInit --> BenchLoad["benchCache.load()\n~/.openbyok-benchmark-cache.json"]
    BenchLoad --> SBar["Create StatusBarItem\ncommand: openbyok.selectFromBenchmark"]
    SBar --> BenchSet["benchmark.setStatusBarItem"]
    BenchSet --> BenchUpdate["benchmark.updateStatusBar()"]
    BenchUpdate --> SBarShow["statusBarItem.show()"]
    
    SBarShow --> CacheCheck{"benchCache.isFresh?"}
    CacheCheck -- Non --> TokenGet["tokenStore.getToken()"]
    CacheCheck -- Oui --> RegisterFeats
    
    TokenGet -- Token OK --> BGRun["benchmark.runBackgroundBenchmark()\nflag running anti-rentree"]
    TokenGet -- Pas de token --> RegisterFeats
    BGRun --> BGUpdate["benchmark.updateStatusBar\n.catch(logger.warn)"]
    BGUpdate --> RegisterFeats
    
    RegisterFeats --> ByokReg["byok.register(context)"]
    ByokReg --> BenchReg["benchmark.register(context)"]
    BenchReg --> GitReg["opengit.register(context)"]
    GitReg --> End(["Extension active"])
    
    Deactivate(["deactivate()"]) --> ProxyStop["proxy.stop()"]
```

---

## 3. Registre des Providers — Interface Commune

```mermaid
classDiagram
    class ProviderRegistry {
        +Map~string, Provider~ providers
        +register(provider)
        +get(id) Provider
        +getDefault() Provider
        +list() Provider[]
    }
    
    class ProviderInterface {
        <<interface>>
        +id: string
        +label: string
        +listModels(token) Model[]
        +findModelById(token, id) Model
        +deviceLogin(noBrowser) token
        +refreshToken()
        +resolveModelFor(token, id) Model
        +cliExportToken() token
        +cliAvailable() boolean
    }
    
    class OpenCodeProvider {
        +id = "opencode"
        +label = "OpenCode Console"
        +fetchConsoleConfig(token)
        +fetchCatalogue()
        +indexCatalogue(cat)
        +collectChatModels(config, catIndex)
        +listModels(token)
        +findModelById(token, id)
        +deviceLogin(noBrowser)
        +refreshToken()
        +resolveModelFor(token, settingId)
        +cliExportToken
        +cliAvailable
    }
    
    class OpenCodeGoProvider {
        +id = "opencode-go"
        +label = "OpenCode Go"
        +listModels(token)
        +findModelById(token, id)
    }
    
    class OpenCodeCLI {
        +cliExportToken() token
        +cliAvailable() boolean
    }
    
    ProviderRegistry --> ProviderInterface : manages
    OpenCodeProvider ..|> ProviderInterface
    OpenCodeGoProvider ..|> ProviderInterface
    OpenCodeProvider --> OpenCodeCLI : uses
```

---

## 4. Flux d'Authentification Device Flow (OpenCode Console)

```mermaid
sequenceDiagram
    actor User
    participant BYOK as byok/commands.js
    participant Provider as opencode.js
    participant TokenStore as token-store.js
    participant OAI as opencode.ai
    participant Browser as Navigateur
    
    User->>BYOK: OpenBYOK: Register API Token
    BYOK->>User: QuickPick: Device flow / CLI
    User->>BYOK: Choisi "Device flow (browser login)"
    BYOK->>User: QuickPick: Auto browser / Manual URL
    User->>BYOK: Choisi mode
    
    alt Browser auto
        Provider->>OAI: POST /auth/device/code {client_id:opencode}
        OAI-->>Provider: {device_code, user_code, verification_uri_complete, expires_in, interval}
        Provider->>Browser: openExternal(verification_uri_complete)
        Provider->>User: showInfo "Confirm code XXXX"
    else Manual
        Provider->>OAI: POST /auth/device/code
        OAI-->>Provider: {device_code, user_code, verification_uri_complete...}
        Provider->>User: showInfo + copy URL to clipboard
    end
    
    loop Polling (jusqu'à deadline)
        Provider->>Provider: sleep(interval)
        Provider->>OAI: POST /auth/device/token {grant_type:device_code, device_code, client_id}
        OAI-->>Provider: {access_token?, refresh_token?, expires_in?} ou {error}
        
        alt access_token reçu
            Provider->>TokenStore: storeToken(access, {server, refreshToken, expiresInMs})
            TokenStore-->>Provider: OK
            Provider->>User: showInfo "Token registered successfully"
            break
        else pas de token
            Note right of Provider: Traiter réponse erreur...
        end
        
        opt authorization_pending
            Note right of Provider: Continuer le polling
        end
        
        opt slow_down
            Provider->>Provider: interval += 5000ms
        end
        
        opt error
            Provider->>User: showError "Auth failed: error"
            break
        end
    end
    
    alt Timeout (deadline dépassé)
        Provider->>User: showError "Authorization timed out"
    end
```

---

## 5. Système de Benchmark & Cache

```mermaid
flowchart TD
    subgraph Benchmark[benchmark/]
        direction TB
        
        Model["Model\n{key, modelID, baseURL...}"]
        Token["Token st_..."]
        Config["benchConfig()\ntimeout/concurrence"]
        
        BenchModel["benchmarkModel(model, token, timeout)"]
        ToCache["toCacheEntry(model, bench)"]
        
        RunPool["runPool(models, worker, concurrency)"]
        
        BG["runBackgroundBenchmark()\nflag running"]
        Progress["runBenchmarkWithProgress()\nwithProgress + cancellable"]
        Clear["clearCache()"]
        Select["selectFromBenchmark()\nstatusBar click"]
        
        Fastest["benchCache.fastestModel()\nspd asc, ttftMs asc"]
    end
    
    subgraph Cache[bench-cache.js]
        Load["load()"]
        Save["save(results)\natomic .tmp+rename"]
        Fresh["isFresh()\nTTL 2h"]
        Age["ageLabel()"]
        Get["getEntry(key)"]
        Data["data()"]
        Clr["clear()\nunlinkSync"]
    end
    
    %% BenchmarkModel internals
    BenchModel --> ChatStream["chatCompletionStream\nSSE + onToken delta"]
    ChatStream --> Measure["Measure:\n- ttftMs (premier delta)\n- totalMs\n- tokens count\n- tokensPerSec"]
    Measure --> Status{Status}
    Status -- OK --> OK["✅ OK\nttft≤5s ∧ tok/s≥5"]
    Status -- Slow --> Slow["🐌 SLOW\nttft>5s ∨ tok/s<5"]
    Status -- Timeout --> TO["⏱️ TIMEOUT"]
    Status -- Error --> Err["❌ ERROR"]
    Status -- NoTokens --> NT["⚠️ NO_TOKENS"]
    
    OK --> CalcSPD["spd = totalMs/tokens*1000\nsec/1k tokens"]
    Slow --> CalcSPD
    TO --> CalcSPD
    Err --> CalcSPD
    NT --> CalcSPD
    
    CalcSPD --> BenchResult["BenchResult\n{status, ttftMs, tokensPerSec, spd, error}"]
    BenchResult --> ToCache
    ToCache --> CacheEntry["CacheEntry\n{key, modelID, name, providerID, baseURL,\nstatus, ttftMs, tokensPerSec, spd, error,\ncontextWindow, maxInputTokens...}"]
    
    %% Flux principaux
    BG --> Token
    BG --> Registry["registry.list()"]
    Registry --> ListModels["provider.listModels(token)"]
    ListModels --> Filter["Filter: exclure opencode-go non -free"]
    Filter --> RunPool
    RunPool --> BenchModel
    BenchModel --> ToCache
    ToCache --> Save
    Save --> UpdateSB["updateStatusBar()"]
    
    Progress --> ProviderPick["QuickPick: All providers / provider.id"]
    ProviderPick --> ListModels
    
    Select --> CacheData{"Cache results?"}
    CacheData -- Non --> Progress
    CacheData -- Oui --> BuildItems["Build QuickPick items"]
    BuildItems --> AutoItem["⚡ Auto (fastest)\nmodelID=''"]
    BuildItems --> ModelItems["Models triés par spd asc"]
    AutoItem --> UserPick["User QuickPick"]
    ModelItems --> UserPick
    UserPick --> SetConfig["openbyok.commitModel = pick.modelID"]
    
    subgraph StatusBar[Status Bar Item]
        UpdateSB --> SBText{"Cache frais?"}
        SBText -- Oui --> SBOK["$(dashboard) OpenBYOK: name spds/1k (Xm)"]
        SBText -- Non --> SBEmpty["$(dashboard) OpenBYOK: no cache"]
        SBOK --> Tooltip["Tooltip: N models, X min ago"]
        SBEmpty --> Tooltip2["Tooltip: Click to run benchmark"]
    end
    
    style BenchModel fill:#3a3a2e,stroke:#dcdcaa
    style CacheEntry fill:#2e3a3a,stroke:#4ec9b0
    style RunPool fill:#3a2e3a,stroke:#ce9178
```

---

## 6. Modèle de Credentials BYOK — Règle Critique

```mermaid
flowchart TD
    subgraph Secret1[Secret 1: Console Token]
        ST["st_... token"]
        SS["SecretStorage VS Code"]
        Keys["Clés:\nopenbyok.opencode.token\n.refresh\n.server\n.expires"]
    end
    
    subgraph Secret2[Secret 2: BYOK API Key]
        Native["\${input:chat.lm.secret.X}"]
        VSCNative["VS Code native secret storage"]
        CreatedBy["Créé UNIQUEMENT par VS Code\nlorsque user fait\n'Update API Key'"]
    end
    
    subgraph Extension[Extension OpenBYOK]
        direction TB
        SelectModels["selectModels()"]
        ResolveKey["resolveByokApiKey(existingEntry)"]
        WriteCLM["upsertChatLanguageModel(byokEntry)"]
    end
    
    subgraph VSCodeUI[VS Code UI]
        ManageLM["Manage Language Models"]
        UpdateKey["Gear → Update API Key"]
        UserPaste["User colle clé OpenCode"]
        VSCRewrite["VS Code réécrit\nchatLanguageModels.json\navec \${input:...}"]
    end
    
    %% Rules
    ST -->|stocké par| SS
    SS -->|utilisé par| Extension
    
    SelectModels --> ResolveKey
    ResolveKey -->|Groupe existant| KeepRef["Conserver \${input:...} actuel"]
    ResolveKey -->|Nouveau groupe| EmptyPH["apiKey: '' placeholder vide"]
    
    KeepRef --> WriteCLM
    EmptyPH --> WriteCLM
    
    WriteCLM --> CLM["chatLanguageModels.json\nvendor: customendpoint\napiKey: ref ou ''"]
    
    CLM --> UserAction{"User action"}
    UserAction -- Ouvre Manage LM\nvoit le groupe\nclique Update API Key --> UpdateKey
    UserAction -- Skip --> End(["Groupe sans clé\nnon utilisable"])
    
    UpdateKey --> UserPaste
    UserPaste --> VSCRewrite
    VSCRewrite --> Native
    Native --> VSCNative
    
    %% Critical rules
    Rule1["RÈGLE: Ne JAMAIS inventer\nchat.lm.secret.X\n→ Invalid credential"] -.-> Extension
    Rule2["RÈGLE: vendor=customendpoint\nobligatoire\n(openbyok inerte)"] -.-> WriteCLM
    Rule3["RÈGLE: apiKey: '' OBLIGATOIRE\npour nouveau groupe\nsinon invisible dans Manage LM"] -.-> EmptyPH
    Rule4["Ne JAMAIS toucher\nau groupe OpenCode Go\n(vendor=opencodego)"] -.-> CLM
    
    classDef secret fill:#1a3a2e,stroke:#4ec9b0,color:#d4d4d4;
    classDef ext fill:#2d2d2d,stroke:#ce9178,color:#d4d4d4;
    classDef ui fill:#1a2a3a,stroke:#569cd6,color:#d4d4d4;
    classDef rule fill:#3a1a1a,stroke:#f14c4c,color:#f48771;
    
    class ST,SS,Keys,Native,VSCNative,CreatedBy secret;
    class SelectModels,ResolveKey,WriteCLM,KeepRef,EmptyPH,CLM ext;
    class ManageLM,UpdateKey,UserPaste,VSCRewrite ui;
    class Rule1,Rule2,Rule3,Rule4 rule;
```

---

## 7. Génération de Message de Commit (OpenGIT)

```mermaid
sequenceDiagram
    actor User
    participant OGit as opengit/command.js
    participant TokenStore as token-store.js
    participant Git as git.js
    participant Registry as registry.js
    participant BenchCache as bench-cache.js
    participant Chat as chat.js
    participant SCM as VS Code SCM
    
    User->>OGit: OpenBYOK: Générer un message de commit\n(ou bouton SCM title)
    OGit->>TokenStore: getToken()
    TokenStore-->>OGit: token st_...
    OGit->>Git: getGitDiff()
    Git-->>OGit: diff (staged puis unstaged)
    
    alt Diff vide
        OGit->>User: showWarning "No git changes detected"
    else Diff OK
        OGit->>Git: getGitLog(5)
        Git-->>OGit: history (5 derniers sujets)
        
        OGit->>OGit: Build prompt\n(custom ou défaut + {history})
        
        OGit->>OGit: Read openbyok.commitModel setting
        alt commitModel configuré
            OGit->>Registry: getDefault().resolveModelFor(token, settingId)
        else Vide (Auto)
            OGit->>BenchCache: fastestModel()
            BenchCache-->>OGit: {baseURL, modelID, name, spd}
            OGit->>Registry: findModelById(token, bench.modelID)
            OGit->>User: showInfo "aucun commitModel configuré — utilisation du plus rapide (X)"
        end
        
        Registry-->>OGit: Model {baseURL, modelID, name...}
        
        OGit->>Chat: chatCompletion(baseURL, modelID, token, prompt + diff)
        Note over Chat: Progress Window\ntitle: "generating commit message (name)..."
        Chat-->>OGit: commit message text
        
        OGit->>SCM: fillScmInputBox(message)
        alt Succès
            OGit->>User: showInfo "Commit message generated by X — inserted in the commit box"
        else Git extension indisponible
            OGit->>User: showInfo "Commit message generated by X: <message>"\n(user peut copier)
        end
    end
```

---

## 8. Flux selectModels (BYOK) — Deux Étapes

```mermaid
flowchart TD
    Start(["selectModels()"]) --> GetToken["tokenStore.getToken()"]
    GetToken --> ListAll["registry.list() → provider.listModels(token)\nTOUS providers"]
    ListAll --> ModelsOK{"Models trouvés?"}
    ModelsOK -- Non --> WarnNoModels["showWarning 'No chat models found'"]
    ModelsOK -- Oui --> CacheCheck{"benchCache.isFresh?"}
    
    CacheCheck -- Oui --> UseCache["Use cached benchMap"]
    CacheCheck -- Non --> OfferBench["showInfo: 'Run Benchmark / Skip'"]
    
    OfferBench -- Run Benchmark --> RunBench["benchmark.runBenchmarkWithProgress()"]
    RunBench -- OK --> ReloadCache["benchCache.load()"]
    ReloadCache --> UseCache
    OfferBench -- Skip --> UseCache
    OfferBench -- Dismiss --> End(["Return"])
    
    UseCache --> BuildBenchMap["benchMap = Map<key, CacheEntry>"]
    BuildBenchMap --> GroupByProvider["Group models by providerID"]
    
    GroupByProvider --> PickProvider["QuickPick: Choose provider\nlabel + count + baseURL"]
    PickProvider -- Cancel --> End
    PickProvider -- OK --> FilterModels["Models of chosen provider"]
    
    FilterModels --> BuildItems["Build QuickPick items per model"]
    BuildItems --> CalcSPD["spd = entry.spd ?? Infinity"]
    CalcSPD --> SortItems["Sort: spd asc → statusOrder → key"]
    SortItems --> ShowStatus["Status icons: OK/SLOW/UNKNOWN/NO_TOKENS/TIMEOUT/ERROR"]
    ShowStatus --> PickModels["QuickPick multi-select\ncached models pre-picked"]
    
    PickModels -- Cancel --> End
    PickModels -- OK --> BuildEntry["Build byokEntry"]
    
    BuildEntry --> Name["name: OpenBYOK <providerID>"]
    BuildEntry --> Vendor["vendor: customendpoint"]
    BuildEntry --> APIType["apiType: chat-completions"]
    BuildEntry --> ModelsList["models[] avec capacités complètes"]
    BuildEntry --> ResolveKey["resolveByokApiKey(existingEntry)"]
    
    ResolveKey -- Existing group --> KeepAPIKey["apiKey = existing \${input:...}"]
    ResolveKey -- New group --> EmptyAPIKey["apiKey = ''"]
    
    KeepAPIKey --> Upsert["vsConfig.upsertChatLanguageModel(byokEntry)"]
    EmptyAPIKey --> Upsert
    Upsert --> EnsureInputs["vsConfig.ensureInputDefinition() best-effort"]
    
    EnsureInputs --> KeepMsg{"apiKeyRef?"}
    KeepMsg -- Oui --> ShowKeep["showInfo: models updated, key kept → Reload Window"]
    KeepMsg -- Non --> ShowConfig["showInfo: models added → Configure API Key / Reload Window"]
    
    ShowKeep --> ReloadAction["User: Reload Window / Dismiss"]
    ShowConfig --> ConfigAction["User: Configure API Key → loop / Reload Window"]
    
    classDef decision fill:#3a2e1a,stroke:#dcdcaa,color:#d4d4d4;
    classDef action fill:#2d2d2d,stroke:#4ec9b0,color:#d4d4d4;
    classDef ui fill:#1a2a3a,stroke:#569cd6,color:#d4d4d4;
    
    class CacheCheck,ModelsOK,KeepMsg decision;
    class GetToken,ListAll,BuildBenchMap,GroupByProvider,FilterModels,BuildItems,CalcSPD,SortItems,BuildEntry,Upsert,EnsureInputs action;
    class OfferBench,RunBench,ReloadCache,PickProvider,PickModels,ShowKeep,ShowConfig,ReloadAction,ConfigAction,WarnNoModels ui;
```

---

## 9. Proxy OpenCode Go — Request Flow

```mermaid
sequenceDiagram
    participant Client as VS Code / Extension\n(chatCompletion)
    participant Proxy as proxy.js\n127.0.0.1:18080
    participant Upstream as opencode.ai\n/inference/go/openai/v1...
    
    Client->>Proxy: POST http://127.0.0.1:18080/chat/completions\nHeaders: x-interaction-id: abc-123\nBody: {model, messages:[{role, content, reasoning?}], stream}
    
    Proxy->>Proxy: getSessionId(req)\n→ abc-123 (depuis header) ou fallback IP→UUID
    Proxy->>Proxy: Parse JSON body
    Proxy->>Proxy: Strip messages[].reasoning si présent
    Proxy->>Proxy: Rebuild body sans reasoning
    
    Proxy->>Upstream: POST https://opencode.ai/inference/go/openai/v1/chat/completions\nHeaders: + x-opencode-session: abc-123\n       + Host: opencode.ai\n       + Authorization: Bearer <token>\nBody: {model, messages:[{role, content}], stream}
    
    Upstream-->>Proxy: Response (stream or JSON)
    Proxy->>Proxy: Propagate statusCode + headers
    Proxy-->>Client: Stream/Body upstream
    
    alt Upstream Error
        Proxy->>Client: 502 {error: upstream message}
        Proxy->>Logger: logger.error('proxy upstream error', err)
    end
    
    Note over Proxy: Logs via logger.js\nOutputChannel "OpenBYOK"
```

---

## 10. Dépendances & Couplage (Vue Fichier)

```mermaid
graph LR
    subgraph Entry
        Ext[extension.js]
    end
    
    subgraph Core_Constants
        Const[constants.js]
    end
    
    subgraph Core_Utils
        Utils[utils.js]
    end
    
    subgraph Core_Providers
        Reg[registry.js]
        OCode[opencode.js]
        OCLI[opencode-cli.js]
        OGo[opencode-go.js]
    end
    
    subgraph Core_Services
        Token[token-store.js]
        Bench[bench-cache.js]
        HTTP[http.js]
        Proc[proc.js]
        Git[git.js]
        Chat[chat.js]
        VSC[vscode-config.js]
        Proxy[proxy.js]
        Log[logger.js]
        Tele[telemetry.js]
    end
    
    subgraph Features_BYOK
        BYOK[byok/commands.js]
    end
    
    subgraph Features_Bench
        BCmd[benchmark/commands.js]
        BBench[benchmark/benchmark.js]
    end
    
    subgraph Features_Git
        OGit[opengit/command.js]
    end
    
    %% Extension wiring
    Ext --> Log
    Ext --> Proxy
    Ext --> Token
    Ext --> Bench
    Ext --> BYOK
    Ext --> BCmd
    Ext --> OGit
    
    %% Providers
    Reg --> OCode
    Reg --> OGo
    OCode --> Token
    OCode --> Bench
    OCode --> HTTP
    OCode --> Chat
    OCode --> OCLI
    OGo --> Token
    OGo --> HTTP
    OGo --> Proxy
    OGo --> Const
    
    %% Services deps
    Token --> HTTP
    Token --> Const
    Bench --> Const
    Bench --> Utils
    HTTP --> Const
    Chat --> Token
    Chat --> Utils
    Proxy --> Log
    Proxy --> Const
    Log --> Const
    VSC --> Utils
    Git --> Proc
    Proc --> Const
    
    %% Features deps
    BYOK --> Reg
    BYOK --> Bench
    BYOK --> VSC
    BYOK --> Token
    BYOK --> Const
    BYOK --> Utils
    
    BCmd --> Reg
    BCmd --> Token
    BCmd --> Bench
    BCmd --> Chat
    BCmd --> Const
    BCmd --> Utils
    
    BBench --> Chat
    BBench --> Const
    BBench --> Utils
    
    OGit --> Reg
    OGit --> Token
    OGit --> Git
    OGit --> Chat
    OGit --> Bench
    OGit --> Const
    
    style Ext fill:#1e1e1e,stroke:#007acc,color:#d4d4d4
    style Tele fill:#2d2d2d,stroke:#888,color:#888,stroke-dasharray: 5 5
```

---

## Comment utiliser

1. **VS Code** : installez *Markdown Preview Mermaid Support* → ouvrez `MERMAID.md` → `Ctrl+Shift+V` (Preview).
2. **GitHub/GitLab** : les diagrammes s'affichent nativement dans les `.md`.
3. **Mermaid Live Editor** : copiez un bloc ````mermaid ... ```` dans <https://mermaid.live/>.
4. **Export** : VS Code → *Print to PDF* depuis la preview, ou outil CLI `mmdc` (`npm i -g @mermaid-js/mermaid-cli`).

---

*Généré le 2026-11-15 — source unique : `src/`*