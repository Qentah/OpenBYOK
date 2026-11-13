'use strict';

const vscode = require('vscode');
const { execFileAsync } = require('./proc');

function workspaceFolder() {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/** Staged diff first, then unstaged. Returns '' when nothing changed. */
async function getGitDiff() {
  const folder = workspaceFolder();
  if (!folder) throw new Error('No workspace folder open.');
  for (const args of [['diff', '--cached'], ['diff']]) {
    try {
      const { stdout } = await execFileAsync('git', args, { cwd: folder });
      if (stdout && stdout.trim()) return stdout;
    } catch {}
  }
  return '';
}

/**
 * Prefill the integrated Source Control input box with the generated message.
 * Returns true on success, false if the Git extension/repo was not available.
 */
async function fillScmInputBox(message) {
  const gitExt = vscode.extensions.getExtension('vscode.git');
  if (!gitExt?.isActive) return false;
  const gitApi = await gitExt.exports.getAPI(1);
  const folder = workspaceFolder();
  const repo = gitApi.repositories.find((r) => r.rootUri.fsPath === folder) ?? gitApi.repositories[0];
  if (!repo) return false;
  repo.inputBox.value = message;
  return true;
}

module.exports = { workspaceFolder, getGitDiff, fillScmInputBox };
