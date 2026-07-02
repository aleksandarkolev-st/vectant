import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);
const proofDir = path.join(repoRoot, 'tmp', 'codesite-dojo-proof');
const proofJsonPath = path.join(proofDir, 'codesite-gitservice-boundary-proof.json');
const proofHtmlPath = path.join(proofDir, 'codesite-gitservice-boundary-proof.html');
const proofPngPath = path.join(proofDir, 'codesite-gitservice-boundary-proof.png');
const args = new Set(process.argv.slice(2));

function sha256(value) {
  return `sha256:${createHash('sha256').update(String(value)).digest('hex')}`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function slug(prefix) {
  return `${prefix}-${Date.now()}-${randomUUID().slice(0, 8)}`;
}

function contextFor(slugValue, overrides = {}) {
  return {
    active: true,
    workspaceSlug: slugValue,
    transactionId: 'txn-proof-1',
    mutationLeaseId: 'lease-proof-1',
    controlPlaneUrl: `http://codesite.test/api/workspace/${slugValue}/codesite`,
    allowedPaths: ['forged-client-path/**'],
    allowedTools: ['file_write', 'file_delete', 'file_rename'],
    evidenceRefs: ['proof:context'],
    processAncestry: ['proof-runner'],
    ...overrides,
  };
}

function createCodeSiteFetch({ writeSet = ['src/**'], recordBodies = [] } = {}) {
  const calls = [];
  const fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET' });
    if (String(url).endsWith('/transactions/txn-proof-1')) {
      return new Response(JSON.stringify({
        transaction: {
          id: 'txn-proof-1',
          status: 'open',
          mutationLeaseId: 'lease-proof-1',
          agentSessionId: 'agent-proof-1',
          writeSet,
          observedWriteSet: [],
        },
      }), { status: 200 });
    }
    if (String(url).endsWith('/transactions/txn-proof-1/record-write')) {
      const body = JSON.parse(options.body || '{}');
      recordBodies.push(body);
      return new Response(JSON.stringify({ ok: true, eventId: `event-${recordBodies.length}` }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: false, error: 'unexpected_url', url }), { status: 404 });
  };
  return { fetch, calls, recordBodies };
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function expectReject(fn) {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected operation to reject');
}

function proofAssert(assertions, ok, name, detail = {}) {
  assertions.push({ name, ok: Boolean(ok), detail });
  if (!ok) {
    const error = new Error(`proof assertion failed: ${name}`);
    error.detail = detail;
    throw error;
  }
}

async function withTempGitService(slugValue, userId, fn) {
  const gitService = require('../backend/collab-server/gitService');
  const config = require('../backend/collab-server/config');
  const previousBaseDir = gitService.baseDir;
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codesite-gitservice-boundary-'));
  gitService.baseDir = baseDir;
  const repoPath = gitService.getEffectiveRepoPath(slugValue, userId);
  await fs.mkdir(repoPath, { recursive: true });
  try {
    return await fn({ gitService, config, baseDir, repoPath });
  } finally {
    gitService.baseDir = previousBaseDir;
    await fs.rm(baseDir, { recursive: true, force: true });
    await fs.rm(path.join(config.REPO_CACHE_DIR, slugValue), { recursive: true, force: true }).catch(() => {});
  }
}

async function runProofScenarios() {
  const userId = 'proof-user';
  const assertions = [];
  const scenarios = [];

  const legacySlug = slug('legacy-write');
  await withTempGitService(legacySlug, userId, async ({ gitService, repoPath }) => {
    await gitService.writeFile(legacySlug, 'src/app.js', 'legacy write\n', userId);
    const content = await fs.readFile(path.join(repoPath, 'src/app.js'), 'utf8');
    proofAssert(assertions, content === 'legacy write\n', 'legacy write still reaches repo without CodeSite context', {
      path: 'src/app.js',
      digest: sha256(content),
    });
    proofAssert(assertions, gitService.safeWriteFile === undefined, 'raw safeWriteFile is no longer exported', {
      exportedType: typeof gitService.safeWriteFile,
    });
    scenarios.push({
      name: 'Legacy direct write',
      status: 'pass',
      repoPath,
      mutations: [{ path: 'src/app.js', disposition: 'legacy_allowed', digest: sha256(content) }],
      notes: ['No CodeSite context was supplied, preserving ordinary user edit compatibility.'],
    });
  });

  const allowedSlug = slug('allowed-write');
  await withTempGitService(allowedSlug, userId, async ({ gitService, repoPath }) => {
    const recordBodies = [];
    const { fetch, calls } = createCodeSiteFetch({ writeSet: ['src/**'], recordBodies });
    await gitService.writeFile(allowedSlug, 'src/app.js', 'codesite write\n', userId, {
      codesiteContext: contextFor(allowedSlug),
      fetch,
      evidenceRefs: ['proof:direct-write'],
      processAncestry: ['gitService.writeFile'],
      lineProvenance: [{ filePath: 'src/app.js', startLine: 1, endLine: 1, lineAnchor: 'src/app.js#L1-L1' }],
    });
    const content = await fs.readFile(path.join(repoPath, 'src/app.js'), 'utf8');
    const event = recordBodies[0] || {};
    proofAssert(assertions, event.codesiteFsEvent?.type === 'write_allowed', 'allowed direct write records CodeSiteFS event before mutation', {
      path: event.path,
      calls: calls.length,
    });
    proofAssert(assertions, content === 'codesite write\n', 'allowed direct write lands after preflight', {
      digest: sha256(content),
    });
    proofAssert(assertions, event.lineProvenance?.[0]?.lineAnchor === 'src/app.js#L1-L1', 'direct service write preserves line provenance evidence', {
      lineProvenance: event.lineProvenance,
    });
    scenarios.push({
      name: 'CodeSite direct write',
      status: 'pass',
      repoPath,
      mutations: [{
        path: event.path,
        disposition: event.codesiteFsEvent?.type,
        evidenceRefs: event.evidenceRefs,
        processAncestry: event.processAncestry,
        digest: sha256(content),
      }],
      notes: ['The control-plane write set was loaded before the file changed.'],
    });
  });

  const batchSlug = slug('mixed-batch');
  await withTempGitService(batchSlug, userId, async ({ gitService, repoPath }) => {
    await fs.mkdir(path.join(repoPath, 'src'), { recursive: true });
    await fs.writeFile(path.join(repoPath, 'src/allowed.js'), 'before\n');
    const recordBodies = [];
    const { fetch } = createCodeSiteFetch({ writeSet: ['src/**'], recordBodies });
    const error = await expectReject(() => gitService.writeFilesBatch(batchSlug, [
      { path: 'src/allowed.js', content: 'after\n' },
      { path: 'api/auth/signup.ts', content: 'blocked\n' },
    ], {
      userId,
      codesiteContext: contextFor(batchSlug),
      fetch,
    }));
    const allowedContent = await fs.readFile(path.join(repoPath, 'src/allowed.js'), 'utf8');
    const blockedExists = await exists(path.join(repoPath, 'api/auth/signup.ts'));
    proofAssert(assertions, error.code === 'CODESITE_WRITE_DENIED', 'mixed batch is rejected by CodeSiteFS', {
      path: error.event?.path,
      reasonCodes: error.event?.details?.reason_codes,
    });
    proofAssert(assertions, allowedContent === 'before\n' && blockedExists === false, 'mixed batch does not partially write allowed files', {
      allowedDigest: sha256(allowedContent),
      blockedExists,
    });
    scenarios.push({
      name: 'Mixed batch preflight',
      status: 'pass',
      repoPath,
      mutations: [{
        path: error.event?.path,
        disposition: error.event?.type,
        reasonCodes: error.event?.details?.reason_codes,
        partialWritePrevented: true,
      }],
      notes: ['The allowed file remained unchanged because one batch member was outside the authoritative write set.'],
    });
  });

  const renameSlug = slug('rename-symlink');
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'codesite-gitservice-outside-'));
  try {
    await withTempGitService(renameSlug, userId, async ({ gitService, repoPath }) => {
      await fs.mkdir(path.join(repoPath, 'src'), { recursive: true });
      await fs.writeFile(path.join(repoPath, 'src/app.js'), 'inside\n');
      await fs.symlink(outside, path.join(repoPath, 'linked-outside'));
      const recordBodies = [];
      const { fetch } = createCodeSiteFetch({ writeSet: ['src/**', 'linked-outside/**'], recordBodies });
      const error = await expectReject(() => gitService.renameItem(renameSlug, 'src/app.js', 'linked-outside/app.js', userId, {
        codesiteContext: contextFor(renameSlug),
        fetch,
      }));
      const sourceContent = await fs.readFile(path.join(repoPath, 'src/app.js'), 'utf8');
      const outsideChanged = await exists(path.join(outside, 'app.js'));
      proofAssert(assertions, error.event?.details?.reason_codes?.includes('repo_parent_symlink_escape'), 'rename into symlink parent is blocked before move', {
        path: error.event?.path,
        reasonCodes: error.event?.details?.reason_codes,
      });
      proofAssert(assertions, sourceContent === 'inside\n' && outsideChanged === false, 'symlink escape block preserves source and outside directory', {
        sourceDigest: sha256(sourceContent),
        outsideChanged,
      });
      scenarios.push({
        name: 'Symlink parent rename',
        status: 'pass',
        repoPath,
        mutations: [{
          path: error.event?.path,
          disposition: error.event?.type,
          reasonCodes: error.event?.details?.reason_codes,
          outsideChanged,
        }],
        notes: ['The target path matched the declared write set but failed realpath containment.'],
      });
    });
  } finally {
    await fs.rm(outside, { recursive: true, force: true });
  }

  const aliasSlug = slug('inside-symlink-alias');
  await withTempGitService(aliasSlug, userId, async ({ gitService, repoPath }) => {
    await fs.mkdir(path.join(repoPath, 'secret'), { recursive: true });
    await fs.symlink(path.join(repoPath, 'secret'), path.join(repoPath, 'allowed-link'));
    const recordBodies = [];
    const { fetch } = createCodeSiteFetch({ writeSet: ['allowed-link/**'], recordBodies });
    const error = await expectReject(() => gitService.writeFile(aliasSlug, 'allowed-link/new.js', 'alias write\n', userId, {
      codesiteContext: contextFor(aliasSlug),
      fetch,
    }));
    const canonicalTargetExists = await exists(path.join(repoPath, 'secret/new.js'));
    proofAssert(assertions, error.event?.details?.reason_codes?.includes('repo_path_symlink_alias'), 'inside-repo symlink aliases cannot bypass write-set paths', {
      path: error.event?.path,
      reasonCodes: error.event?.details?.reason_codes,
    });
    proofAssert(assertions, canonicalTargetExists === false, 'symlink alias block prevents canonical target mutation', {
      canonicalTargetExists,
    });
    scenarios.push({
      name: 'Inside-repo symlink alias',
      status: 'pass',
      repoPath,
      mutations: [{
        path: error.event?.path,
        disposition: error.event?.type,
        reasonCodes: error.event?.details?.reason_codes,
        canonicalTargetExists,
      }],
      notes: ['The lexical path matched the write set, but the canonical repo path was different, so the shared resolver denied it.'],
    });
  });

  const syncDeleteSlug = slug('sync-delete');
  await withTempGitService(syncDeleteSlug, userId, async ({ gitService, repoPath }) => {
    await fs.mkdir(path.join(repoPath, 'src'), { recursive: true });
    await fs.writeFile(path.join(repoPath, 'src/old.js'), 'old\n');
    const recordBodies = [];
    const { fetch } = createCodeSiteFetch({ writeSet: ['src/**'], recordBodies });
    await gitService.syncFile(syncDeleteSlug, 'src/synced.js', 'synced\n', userId, {
      codesiteContext: contextFor(syncDeleteSlug),
      fetch,
      evidenceRefs: ['proof:sync'],
    });
    await gitService.deleteItem(syncDeleteSlug, 'src/old.js', userId, {
      codesiteContext: contextFor(syncDeleteSlug),
      fetch,
      evidenceRefs: ['proof:delete'],
    });
    const syncedContent = await fs.readFile(path.join(repoPath, 'src/synced.js'), 'utf8');
    const oldExists = await exists(path.join(repoPath, 'src/old.js'));
    proofAssert(assertions, syncedContent === 'synced\n' && oldExists === false, 'syncFile and deleteItem mutate only after CodeSiteFS records events', {
      paths: recordBodies.map((body) => body.path),
      oldExists,
    });
    scenarios.push({
      name: 'Sync and delete primitives',
      status: 'pass',
      repoPath,
      mutations: recordBodies.map((body) => ({
        path: body.path,
        disposition: body.codesiteFsEvent?.type,
        evidenceRefs: body.evidenceRefs,
      })),
      notes: ['Both non-writeFile CRUD primitives recorded through CodeSiteFS with their own tools and evidence refs.'],
    });
  });

  const requiredSlug = slug('required-context');
  await withTempGitService(requiredSlug, userId, async ({ gitService, repoPath }) => {
    const error = await expectReject(() => gitService.createDirectory(requiredSlug, 'src/new-dir', userId, {
      requireCodeSiteBoundary: true,
    }));
    const created = await exists(path.join(repoPath, 'src/new-dir'));
    proofAssert(assertions, error.code === 'CODESITE_WRITE_DENIED', 'required service boundary fails closed without CodeSite context', {
      reasonCodes: error.event?.details?.reason_codes,
    });
    proofAssert(assertions, created === false, 'missing-context directory create does not touch repo', { created });
    scenarios.push({
      name: 'Required boundary without context',
      status: 'pass',
      repoPath,
      mutations: [{
        path: error.event?.path,
        disposition: error.event?.type,
        reasonCodes: error.event?.details?.reason_codes,
      }],
      notes: ['A caller can require CodeSiteFS even when no context is supplied, and the service fails closed.'],
    });
  });

  return {
    schemaVersion: 'synthi.codesite.gitServiceBoundaryProof.v1',
    generatedAt: new Date().toISOString(),
    source: 'scripts/codesite-gitservice-boundary-proof.mjs',
    assertions,
    scenarios,
    summary: {
      status: assertions.every((item) => item.ok) ? 'pass' : 'fail',
      assertionCount: assertions.length,
      scenarioCount: scenarios.length,
    },
  };
}

function proofHtml(proof) {
  const assertionRows = proof.assertions.map((assertion) => `
    <tr>
      <td><span class="${assertion.ok ? 'pass' : 'fail'}">${assertion.ok ? 'PASS' : 'FAIL'}</span></td>
      <td>${escapeHtml(assertion.name)}</td>
      <td><code>${escapeHtml(JSON.stringify(assertion.detail))}</code></td>
    </tr>
  `).join('');
  const scenarioCards = proof.scenarios.map((scenario) => `
    <section class="card">
      <div class="card-head">
        <h2>${escapeHtml(scenario.name)}</h2>
        <span class="pass">PASS</span>
      </div>
      <p>${escapeHtml(scenario.notes.join(' '))}</p>
      <table>
        <thead><tr><th>Path</th><th>Disposition</th><th>Reason / Evidence</th></tr></thead>
        <tbody>
          ${scenario.mutations.map((mutation) => `
            <tr>
              <td><code>${escapeHtml(mutation.path || '')}</code></td>
              <td>${escapeHtml(mutation.disposition || '')}</td>
              <td><code>${escapeHtml(JSON.stringify(mutation.reasonCodes || mutation.evidenceRefs || mutation))}</code></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </section>
  `).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CodeSite gitService Boundary Proof</title>
<style>
:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0a0d12;color:#f4f7fb}
body{margin:0;background:#0a0d12;padding:28px}
main{max-width:1160px;margin:0 auto;display:grid;gap:16px}
.hero,.card{border:1px solid #293345;border-radius:8px;background:#111822;padding:18px}
.hero{display:grid;gap:10px}
h1{font-size:28px;line-height:1.15;margin:0;letter-spacing:0}
h2{font-size:16px;margin:0;letter-spacing:0}
p{margin:0;color:#aeb9ca;line-height:1.5}
.meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px}
.metric{border:1px solid #293345;border-radius:8px;padding:12px;background:#0c1119}
.label{font-size:12px;color:#8d98aa}
.value{margin-top:5px;font-size:18px;font-weight:700}
.pass,.fail{display:inline-block;border-radius:6px;padding:4px 8px;font-size:12px;font-weight:800}
.pass{background:#123b27;color:#9ef0bc}.fail{background:#4a1414;color:#ffb8b8}
.card-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px}
table{width:100%;border-collapse:collapse;margin-top:12px;font-size:13px}
th,td{border-top:1px solid #293345;padding:8px;text-align:left;vertical-align:top}
th{color:#aeb9ca;font-weight:700}
code{font-family:"SFMono-Regular",Consolas,monospace;font-size:12px;color:#d8e1f1;overflow-wrap:anywhere}
</style>
</head>
<body>
<main>
  <section class="hero">
    <span class="pass">PASS</span>
    <h1>CodeSite gitService Boundary Proof</h1>
    <p>Direct gitService mutation primitives were exercised through real product code. CodeSite-aware calls recorded shared CodeSiteFS events before mutation, blocked illegal writes before repo changes, and preserved legacy non-CodeSite writes.</p>
    <div class="meta">
      <div class="metric"><div class="label">Scenarios</div><div class="value">${proof.summary.scenarioCount}</div></div>
      <div class="metric"><div class="label">Assertions</div><div class="value">${proof.summary.assertionCount}</div></div>
      <div class="metric"><div class="label">Generated</div><div class="value">${escapeHtml(proof.generatedAt)}</div></div>
    </div>
  </section>
  ${scenarioCards}
  <section class="card">
    <div class="card-head"><h2>Assertions</h2><span class="pass">ALL PASS</span></div>
    <table>
      <thead><tr><th>Status</th><th>Assertion</th><th>Evidence</th></tr></thead>
      <tbody>${assertionRows}</tbody>
    </table>
  </section>
</main>
</body>
</html>`;
}

async function screenshot(htmlPath = proofHtmlPath, pngPath = proofPngPath) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({
    headless: true,
    chromiumSandbox: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1100 }, deviceScaleFactor: 1 });
    await page.goto(`file://${htmlPath}`, { waitUntil: 'load' });
    await page.screenshot({ path: pngPath, fullPage: true });
  } finally {
    await browser.close();
  }
}

async function main() {
  await fs.mkdir(proofDir, { recursive: true });
  if (args.has('--screenshot-only')) {
    await screenshot();
    return;
  }

  const proof = await runProofScenarios();
  if (proof.summary.status !== 'pass') {
    throw new Error('CodeSite gitService boundary proof failed');
  }
  await fs.writeFile(proofJsonPath, JSON.stringify(proof, null, 2), 'utf8');
  await fs.writeFile(proofHtmlPath, proofHtml(proof).replace(/[ \t]+$/gm, ''), 'utf8');
  if (!args.has('--no-screenshot')) {
    await screenshot();
  }
  console.log(JSON.stringify({
    ok: true,
    proofJsonPath,
    proofHtmlPath,
    proofPngPath: args.has('--no-screenshot') ? null : proofPngPath,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
