'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsyncRaw = promisify(execFile);

/**
 * execFile wrapper with sane defaults: utf8, timeout, windowsHide.
 * Returns { stdout, stderr }.
 */
async function execFileAsync(cmd, args, opts = {}) {
  return execFileAsyncRaw(cmd, args, {
    encoding: 'utf8',
    timeout: opts.timeout ?? 15000,
    windowsHide: true,
    ...opts,
  });
}

/** Check whether an executable is reachable (spawn attempt, no throw). */
async function commandExists(cmd, args = ['--version']) {
  try {
    await execFileAsync(cmd, args, { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

module.exports = { execFileAsync, commandExists };
