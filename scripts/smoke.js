'use strict';
// Smoke test: load the extension with a stubbed 'vscode' module.
const Module = require('module');
const orig = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') {
    return {
      window: { createOutputChannel: () => ({ appendLine(){}, show(){}, dispose(){} }), createStatusBarItem: () => ({ text: '', tooltip: '', command: '', show(){}, dispose(){}, hide(){} }), showInformationMessage: async () => undefined, showWarningMessage: async () => undefined, showErrorMessage: async () => undefined, showQuickPick: async () => undefined, withProgress: async (o, cb) => cb({ report(){} }, { isCancellationRequested: false }) },
      workspace: { workspaceFolders: [], getConfiguration: () => ({ get: () => undefined }) },
      env: { openExternal: async () => {}, clipboard: { writeText: async () => {} } },
      extensions: { getExtension: () => undefined },
      commands: { registerCommand: () => ({ dispose(){} }), executeCommand: async () => {} },
      ProgressLocation: { Notification: 1, Window: 2 },
      StatusBarAlignment: { Left: 1, Right: 2 },
      Uri: { parse: (s) => ({ toString: () => s }) },
    };
  }
  return orig.apply(this, arguments);
};
const ext = require('../src/extension.js');
const ctx = { secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} }, subscriptions: [] };
ext.activate(ctx);
console.log('ACTIVATE OK');
ext.deactivate();
console.log('DEACTIVATE OK');
// utils
const { runPool } = require('../src/core/utils');
runPool([1,2,3], async (x) => { if (x === 2) throw new Error('boom'); return x*2; }, 2).then((r) => {
  console.log('runPool:', JSON.stringify(r));
  if (r[1] !== null) throw new Error('runPool should null on error');
  console.log('SMOKE OK');
}).catch((e) => { console.error(e); process.exit(1); });
