const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { applyScaffoldFiles } = require('../scaffold');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'scaffold-'));
}

test('writes missing files and reports them', () => {
  const cwd = tmpDir();
  const res = applyScaffoldFiles(cwd, [
    { path: 'package.json', contents: '{}' },
    { path: 'src/main.js', contents: 'console.log(1)' },
  ]);
  assert.deepStrictEqual(res.written.sort(), ['package.json', 'src/main.js']);
  assert.deepStrictEqual(res.skipped, []);
  assert.strictEqual(fs.readFileSync(path.join(cwd, 'src/main.js'), 'utf8'), 'console.log(1)');
});

test('never clobbers an existing file (skips it)', () => {
  const cwd = tmpDir();
  fs.writeFileSync(path.join(cwd, 'package.json'), 'ORIGINAL');
  const res = applyScaffoldFiles(cwd, [
    { path: 'package.json', contents: 'NEW' },
    { path: 'app.py', contents: 'x' },
  ]);
  assert.deepStrictEqual(res.written, ['app.py']);
  assert.deepStrictEqual(res.skipped, ['package.json']);
  assert.strictEqual(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'), 'ORIGINAL');
});

test('rejects path traversal / absolute paths', () => {
  const cwd = tmpDir();
  assert.throws(() => applyScaffoldFiles(cwd, [{ path: '../evil.js', contents: 'x' }]), /path_escape/);
  assert.throws(() => applyScaffoldFiles(cwd, [{ path: '/etc/passwd', contents: 'x' }]), /path_escape/);
  assert.throws(() => applyScaffoldFiles(cwd, [{ path: 'a/../../b', contents: 'x' }]), /path_escape/);
});
