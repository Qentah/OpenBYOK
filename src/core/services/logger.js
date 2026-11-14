'use strict';

const vscode = require('vscode');

let channel = null;

function init() {
  if (channel) return channel;
  channel = vscode.window.createOutputChannel('OpenBYOK');
  return channel;
}

function isTelemetryEnabled() {
  try {
    return vscode.workspace.getConfiguration('openbyok').get('telemetryEnabled') === true;
  } catch (e) {
    return false;
  }
}

function line(level, msg, err) {
  const c = channel || init();
  const ts = new Date().toISOString();
  c.appendLine(`[${ts}] [${level}] ${msg}`);
  if (err) {
    c.appendLine(`  ${err && err.stack ? err.stack : String(err)}`);
  }
  // Send telemetry event if enabled and msg contains relevant info
  if (isTelemetryEnabled() && msg && typeof msg === 'string' && !msg.startsWith('OpenBYOK: ') && !msg.includes('Secret')) {
    // Simple telemetry: count messages, track errors, etc.
    const event = {
      type: level.toLowerCase(),
      message: msg,
      timestamp: new Date().toISOString(),
      channel: 'OpenBYOK'
    };
    // Send telemetry via VS Code's telemetry API (if available)
    try {
      vscode?.telemetry?.sendEvent('OpenBYOK', event);
    } catch (e) {
      // Telemetry not available, ignore
    }
  }
}

module.exports = {
  init,
  info: (m) => line('INFO', m),
  warn: (m, e) => line('WARN', m, e),
  error: (m, e) => line('ERROR', m, e),
  show: () => channel && channel.show(true),
  channel: () => channel,
};