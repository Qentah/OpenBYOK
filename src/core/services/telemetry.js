'use strict';

const vscode = require('vscode');

function enabled() {
  try { return vscode.workspace.getConfiguration('openbyok').get('telemetryEnabled') === true; }
  catch { return false; }
}

function logEvent(name, data) {
  if (!enabled()) return;
  try {
    const channel = vscode.window.createOutputChannel('OpenBYOK Telemetry');
    channel.appendLine(`[${new Date().toISOString()}] ${name} ${data ? JSON.stringify(data) : ''}`);
  } catch {}
}

module.exports = { enabled, logEvent };