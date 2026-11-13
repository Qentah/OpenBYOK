'use strict';

const { execFileAsync } = require('../services/proc');

/**
 * Optional complement: local OpenCode CLI.
 * Only meaningful when the `opencode` binary is available on the machine.
 */
async function cliExportToken() {
  const exeCandidates = [process.env.OPENCODE_CLI_PATH, 'opencode'].filter(Boolean);
  for (const exe of exeCandidates) {
    try {
      const { stdout } = await execFileAsync(exe, ['auth', 'export', 'opencode']);
      const creds = JSON.parse(stdout);
      const active = creds.find((c) => c.active && c.value?.access) ?? creds[0];
      if (active?.value?.access) return active.value.access;
    } catch { /* try next candidate */ }
  }
  throw new Error('OpenCode CLI not found or no token available. Install @opencode/cli or use device flow.');
}

async function cliAvailable() {
  try {
    await cliExportToken();
    return true;
  } catch {
    return false;
  }
}

module.exports = { cliExportToken, cliAvailable };
