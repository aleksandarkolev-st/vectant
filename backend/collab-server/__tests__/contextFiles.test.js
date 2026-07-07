const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readContextFiles } = require('../contextFiles');
const { applyScaffoldFiles } = require('../scaffold');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-')); }

test('readContextFiles returns only the present allow-listed files', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'package.json'), '{"name":"x"}');
  fs.writeFileSync(path.join(d, 'README.md'), '# hi');
  fs.writeFileSync(path.join(d, 'secret.txt'), 'nope');
  const files = readContextFiles(d);
  assert.equal(files['package.json'], '{"name":"x"}');
  assert.equal(files['README.md'], '# hi');
  assert.ok(!('secret.txt' in files));
});

test('applyScaffoldFiles overwrite:true replaces an existing file', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'vectant.programs.json'), 'OLD');
  const skip = applyScaffoldFiles(d, [{ path: 'vectant.programs.json', contents: 'NEW' }]);
  assert.deepEqual(skip.skipped, ['vectant.programs.json']); // default: only-missing
  const over = applyScaffoldFiles(d, [{ path: 'vectant.programs.json', contents: 'NEW' }], { overwrite: true });
  assert.deepEqual(over.written, ['vectant.programs.json']);
  assert.equal(fs.readFileSync(path.join(d, 'vectant.programs.json'), 'utf8'), 'NEW');
});

test('overwrite still rejects path traversal', () => {
  assert.throws(() => applyScaffoldFiles(tmp(), [{ path: '../evil', contents: 'x' }], { overwrite: true }), /path_escape/);
});
