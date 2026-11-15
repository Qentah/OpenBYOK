'use strict';

const Module = require('module');
const origLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === 'vscode') {
    return {
      window: { createOutputChannel: () => ({ appendLine() {}, show() {} }) },
      workspace: { getConfiguration: () => ({ get: () => undefined }) },
    };
  }
  return origLoad.apply(this, arguments);
};

const proxy = require('../src/core/services/proxy');
const { shapeRequest, ALLOWED_TOP_LEVEL_FIELDS, ALLOWED_MESSAGE_FIELDS } = proxy;

function buf(s) { return Buffer.from(s, 'utf8'); }
function eq(a, b) { return Buffer.compare(a, b) === 0; }
function parse(b) { return JSON.parse(b.toString('utf8')); }

let failed = 0;
function check(name, cond) {
  if (!cond) { failed++; console.error('FAIL', name); } else { console.log('OK  ', name); }
}

// (a) strip cot/reasoning fields from messages
const inputA = JSON.stringify({
  model: 'm', messages: [{ role: 'user', content: 'hi', cot_id: 'x', cot_summary: 'y', reasoning: 'r', reasoning_content: 'rc', reasoning_details: 'rd' }],
  foo: 1, metadata: { z: 1 }, reasoning_effort: 'high',
});
const outA = shapeRequest(buf(inputA));
const jA = parse(outA);
check('A: top-level foo removed', !('foo' in jA));
check('A: top-level metadata removed', !('metadata' in jA));
check('A: reasoning_effort retained', jA.reasoning_effort === 'high');
check('A: message standard fields kept', jA.messages[0].role === 'user' && jA.messages[0].content === 'hi');
check('A: cot_id removed', !('cot_id' in jA.messages[0]));
check('A: cot_summary removed', !('cot_summary' in jA.messages[0]));
check('A: reasoning removed', !('reasoning' in jA.messages[0]));
check('A: reasoning_content removed', !('reasoning_content' in jA.messages[0]));
check('A: reasoning_details removed', !('reasoning_details' in jA.messages[0]));

// (b) top-level stripping
const inputB = JSON.stringify({ model: 'm', messages: [], bar: 2 });
const jB = parse(shapeRequest(buf(inputB)));
check('B: bar removed', !('bar' in jB));
check('B: model kept', jB.model === 'm');

// (c) reasoning_effort retained (covered above)

// (d) malformed JSON pass-through
const raw = buf('not json {');
const outD = shapeRequest(raw);
check('D: malformed pass-through bytes', eq(outD, raw));

// (e) empty body
check('E: empty -> empty', shapeRequest(buf('')).length === 0);

// (f) messages not an array
const inputF = JSON.stringify({ model: 'm', messages: 'nope', foo: 1 });
const jF = parse(shapeRequest(buf(inputF)));
check('F: foo removed', !('foo' in jF));
check('F: messages untouched', jF.messages === 'nope');

// (g) non-object body pass-through
const arr = buf(JSON.stringify([1, 2, 3]));
check('G: array pass-through', eq(shapeRequest(arr), arr));
const num = buf('42');
check('G: number pass-through', eq(shapeRequest(num), num));

// allowlists exported as Sets
check('allowlist top-level is Set', ALLOWED_TOP_LEVEL_FIELDS instanceof Set);
check('allowlist msg is Set', ALLOWED_MESSAGE_FIELDS instanceof Set);
check('allowlist contains reasoning_effort', ALLOWED_TOP_LEVEL_FIELDS.has('reasoning_effort'));
check('allowlist msg contains content', ALLOWED_MESSAGE_FIELDS.has('content'));

console.log(`\n${failed === 0 ? 'ALL OK' : failed + ' FAILURES'}`);
process.exit(failed === 0 ? 0 : 1);