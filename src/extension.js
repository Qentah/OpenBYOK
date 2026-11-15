'use strict';

const vscode = require('vscode');

const tokenStore = require('./core/services/token-store');
const benchCache = require('./core/services/bench-cache');
const vsConfig = require('./core/services/vscode-config');
const proxy = require('./core/services/proxy');
const logger = require('./core/services/logger');

const byok = require('./features/byok/commands');
const benchmark = require('./features/benchmark/commands');
const opengit = require('./features/opengit/command');
const inline = require('./features/inline/completion');

function activate(context) {
  logger.init();
  proxy.start();
  tokenStore.init(context.secrets);
  benchCache.load();
  try { vsConfig.repairModelLimits(); } catch {}

  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'openbyok.selectFromBenchmark';
  context.subscriptions.push(statusBarItem);
  benchmark.setStatusBarItem(statusBarItem);
  benchmark.updateStatusBar();
  statusBarItem.show();
  
  if (!benchCache.isFresh()) {
    tokenStore.getToken().then(() => {
      benchmark.runBackgroundBenchmark().then(() => benchmark.updateStatusBar()).catch((e) => logger.warn('background benchmark failed', e));
    }).catch(() => { /* no token yet */ });
  }

  byok.register(context);
  benchmark.register(context);
  opengit.register(context);
  inline.register(context);
}

function deactivate() {
  try { proxy.stop(); } catch {}
}

module.exports = { activate, deactivate };
