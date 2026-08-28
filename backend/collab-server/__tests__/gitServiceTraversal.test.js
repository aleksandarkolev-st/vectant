const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const gitServiceModule = require('../gitService');
const GitService = gitServiceModule.constructor;

test('readFile rejects traversal while allowing normal repo reads', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitservice-traversal-'));
  const repoPath = path.join(tempRoot, 'repo');
  const service = new GitService(tempRoot);
  await fs.mkdir(repoPath, { recursive: true });
  await fs.writeFile(path.join(tempRoot, 'outside-secret.txt'), 'outside\n', 'utf8');
  await fs.writeFile(path.join(repoPath, 'canary.txt'), 'inside\n', 'utf8');
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));

  await assert.rejects(
    () => service.readFile('repo', '../../outside-secret.txt'),
    /Invalid file path/,
  );
  await assert.rejects(
    () => service.readFile('repo', '..\\outside-secret.txt'),
    /Invalid file path/,
  );
  assert.strictEqual(
    await service.readFile('repo', 'canary.txt'),
    'inside\n',
  );
});
