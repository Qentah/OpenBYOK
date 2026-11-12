# openbyok — VS Code Extension (BYOK)

Super-lightweight extension that registers OpenCode Console models as VS Code
BYOK (Bring Your Own Key). **No local OpenCode CLI or database required.**

## Features
- Register an OpenCode Console token (`st_…`) via device flow (browser or manual URL) or auto-retrieve from OpenCode CLI if installed
- Browse & select providers/models from the Console API
- **Consolidated metadata**: context window, output limits, vision, tool calling, reasoning effort — fetched from both Console API and static catalogue
- Auto-generates `chatLanguageModels.json` entries (vendor `customendpoint`)
- Token stored in VS Code SecretStorage (encrypted, OS-level)
- Auto-refresh support

## Installation (from source — no compilation needed)

This extension is **pure JavaScript** (CommonJS). There is **no build step, no TypeScript, no compilation**.
You can install it directly from the source folder and modify the code on the fly.

### Option A — Install as unpacked extension (recommended for dev)

1. Open VS Code
2. `Ctrl+Shift+P` → "Developer: Install Extension from Location..."
3. Select the `vscode/` folder
4. The extension is now active — edit `src/extension.js` and reload the window (`Ctrl+Shift+P` → "Developer: Reload Window") to apply changes

### Option B — Symlink into extensions folder

```bash
# Windows (PowerShell, run as admin or enable developer mode)
New-Item -ItemType SymbolicLink -Path "$env:USERPROFILE\.vscode\extensions\openbyok" -Target "REDACTED_LOCAL_PATH"
```

Then reload VS Code. Any edit to `src/extension.js` takes effect after a window reload.

### Option C — Package as .vsix (no compile)

```bash
npm install -g @vscode/vsce
cd vscode/
vsce package --no-dependencies
# produces openbyok-0.1.0.vsix
code --install-extension openbyok-0.1.0.vsix
```

### Hot-reload workflow

1. Edit `src/extension.js`
2. `Ctrl+Shift+P` → "Developer: Reload Window"
3. No recompilation needed — VS Code re-reads the source on every load

## Usage
1. `Ctrl+Shift+P` → "OpenBYOK: Register API Token (st_…)"
2. `Ctrl+Shift+P` → "OpenBYOK: Select Models for BYOK"
3. Pick models → they appear in the VS Code model picker with full consolidated metadata
4. Reload VS Code if models don't appear immediately

## Independence
This extension talks directly to:
- `https://opencode.ai/console/api/v2/config` (Console API)
- `https://models.opencode.ai/experimental/v2.0/api.json` (static catalogue)

It does NOT read `~/.local/share/opencode/opencode.db`, does NOT invoke the
`opencode` CLI, and does NOT depend on `@opencode/cli`.

## Consolidation
Models are consolidated by merging:
1. Console OpenCode config → providers, baseURL, active models
2. Static catalogue → context/output limits, modalities, capabilities, costs

The NVIDIA provider entry is preferred when multiple catalogue entries exist for
the same model ID (matching the console OpenCode display values).