// Regression guard: a base64 batch entry must land as DECODED bytes in both
// places we persist it — the on-disk repo AND the durable GCS backup.
//
// The original bug decoded only for the disk write and handed the raw base64
// string to GCS. Because a workspace re-hydrates from GCS, the next hydration
// overwrote the repo with base64 text: `npm install` then died with
// EJSONPARSE on package.json, no node_modules was produced, and the TypeScript
// language server reported "Could not find a valid TypeScript installation".

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const config = require('../config');
const activityRegistry = require('../codesiteActivityRegistry');
const gcsSync = require('../gcsSync');
const gitService = require('../gitService');

function uniqueSlug(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

// Runs `fn` against a throwaway repo with GCS stubbed so we can capture the
// exact bytes handed to the durable backup.
async function withStubbedWorkspace(t, fn) {
  const slug = uniqueSlug('write-batch-encoding');
  const userId = 'user-1';

  const previousBaseDir = gitService.baseDir;
  const previousBaseUrl = process.env.SYNTHI_CODESITE_API_BASE_URL;
  const previousFetch = global.fetch;
  const previousIsConfigured = gcsSync.isGcsConfigured;
  const previousSync = gcsSync.syncFileToGcs;

  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'write-batch-encoding-'));
  gitService.baseDir = baseDir;
  process.env.SYNTHI_CODESITE_API_BASE_URL = 'http://codesite.test/api/workspace/{workspace_slug}/codesite';
  global.fetch = async () => new Response(JSON.stringify({
    activeTransactions: activityRegistry.activeTransactionsForWorkspace(slug),
  }), { status: 200 });

  const uploads = [];
  gcsSync.isGcsConfigured = () => true;
  gcsSync.syncFileToGcs = async (_slug, relativePath, content) => {
    // Mirror the real implementation's coercion so the test observes the same
    // bytes GCS would actually store.
    uploads.push({
      path: relativePath,
      body: Buffer.isBuffer(content) ? Buffer.from(content) : Buffer.from(String(content), 'utf8'),
    });
    return { success: true };
  };

  const repoPath = gitService.getEffectiveRepoPath(slug, userId);
  activityRegistry.markTransactionClosed({ workspaceSlug: slug });
  await fs.mkdir(repoPath, { recursive: true });

  t.after(async () => {
    activityRegistry.markTransactionClosed({ workspaceSlug: slug });
    gitService.baseDir = previousBaseDir;
    gcsSync.isGcsConfigured = previousIsConfigured;
    gcsSync.syncFileToGcs = previousSync;
    if (previousBaseUrl === undefined) {
      delete process.env.SYNTHI_CODESITE_API_BASE_URL;
    } else {
      process.env.SYNTHI_CODESITE_API_BASE_URL = previousBaseUrl;
    }
    global.fetch = previousFetch;
    await fs.rm(baseDir, { recursive: true, force: true });
    await fs.rm(path.join(config.REPO_CACHE_DIR, slug), { recursive: true, force: true });
  });

  return fn({ slug, userId, repoPath, uploads });
}

test('a base64 batch entry is decoded for the GCS backup, not just for disk', async (t) => {
  await withStubbedWorkspace(t, async ({ slug, userId, repoPath, uploads }) => {
    // The exact shape the folder-import UI sends (fileToBatchEntry).
    const source = '{\r\n  "dependencies": {\r\n    "lucide-react": "^0.553.0"\r\n  }\r\n}\r\n';
    const encoded = Buffer.from(source, 'utf8').toString('base64');

    const result = await gitService.writeFilesBatch(slug, [
      { path: 'package.json', encoding: 'base64', content: encoded },
    ], { syncToGcs: true, userId });

    assert.deepStrictEqual(result.errors, []);
    assert.deepStrictEqual(result.skipped, []);

    const onDisk = await fs.readFile(path.join(repoPath, 'package.json'));
    assert.strictEqual(onDisk.toString('utf8'), source, 'disk copy must be decoded');
    // The whole point of the bug: parsing must succeed, not throw EJSONPARSE.
    assert.doesNotThrow(() => JSON.parse(onDisk.toString('utf8')));

    assert.strictEqual(uploads.length, 1);
    assert.strictEqual(uploads[0].path, 'package.json');
    assert.strictEqual(
      uploads[0].body.toString('utf8'),
      source,
      'GCS backup must receive the same decoded bytes as disk, not the base64 text',
    );
    assert.ok(uploads[0].body.equals(onDisk), 'disk and GCS copies must be byte-identical');

    assert.strictEqual(result.written[0].bytes, Buffer.byteLength(source, 'utf8'));
  });
});

test('binary base64 content round-trips to disk and GCS byte-for-byte', async (t) => {
  await withStubbedWorkspace(t, async ({ slug, userId, repoPath, uploads }) => {
    // Bytes that are not valid UTF-8 — coercing them through a string would
    // corrupt them, so this pins the Buffer path end to end.
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe]);

    await gitService.writeFilesBatch(slug, [
      { path: 'assets/logo.png', encoding: 'base64', content: bytes.toString('base64') },
    ], { syncToGcs: true, userId });

    const onDisk = await fs.readFile(path.join(repoPath, 'assets/logo.png'));
    assert.ok(onDisk.equals(bytes), 'disk copy must be the original bytes');
    assert.ok(uploads[0].body.equals(bytes), 'GCS copy must be the original bytes');
  });
});

test('a utf8 batch entry is still written verbatim', async (t) => {
  await withStubbedWorkspace(t, async ({ slug, userId, repoPath, uploads }) => {
    const source = 'export const answer = 42;\n';

    const result = await gitService.writeFilesBatch(slug, [
      { path: 'src/answer.ts', encoding: 'utf8', content: source },
    ], { syncToGcs: true, userId });

    const onDisk = await fs.readFile(path.join(repoPath, 'src/answer.ts'), 'utf8');
    assert.strictEqual(onDisk, source);
    assert.strictEqual(uploads[0].body.toString('utf8'), source);
    assert.strictEqual(result.written[0].bytes, Buffer.byteLength(source, 'utf8'));
  });
});
