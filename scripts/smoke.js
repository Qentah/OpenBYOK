const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = process.argv[2] || 'src';
const dir = path.resolve(process.cwd(), root);

function collect(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(full, out);
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
  }
}

const files = [];
collect(dir, files);
files.sort();

let failed = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
    console.log('OK  ' + path.relative(process.cwd(), f));
  } catch (e) {
    failed++;
    console.error('FAIL ' + path.relative(process.cwd(), f));
    if (e.stderr) process.stderr.write(e.stderr);
    if (e.stdout) process.stdout.write(e.stdout);
  }
}

console.log(`\nChecked ${files.length} file(s), ${failed} failure(s).`);
process.exit(failed === 0 ? 0 : 1);
