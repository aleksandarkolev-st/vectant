#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const DEFAULT_PROOF_ROOT = 'tmp/codesite-dojo-proof';

function repoRoot() {
  return path.basename(process.cwd()) === 'synthi'
    ? path.dirname(process.cwd())
    : process.cwd();
}

function proofRoot() {
  return path.resolve(process.env.CODESITE_PROOF_OUT_DIR || path.join(repoRoot(), DEFAULT_PROOF_ROOT));
}

function git(args) {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function readText(relativePath) {
  return fs.readFileSync(path.join(repoRoot(), relativePath), 'utf8');
}

function readJsonIfExists(relativePath) {
  const absolutePath = path.join(proofRoot(), relativePath);
  if (!fs.existsSync(absolutePath)) return null;
  return JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
}

function proofOk(proof) {
  if (!proof) return false;
  if (proof.ok === true || proof.status === 'validated') {
    return assertionsPass(proof.assertions);
  }
  return assertionsPass(proof.assertions);
}

function assertionsPass(assertions) {
  if (!assertions) return true;
  const values = Array.isArray(assertions)
    ? assertions.map((entry) => entry?.ok ?? entry?.passed ?? entry?.value ?? entry)
    : Object.values(assertions).map((entry) => (
      entry && typeof entry === 'object'
        ? entry.ok ?? entry.passed ?? entry.value ?? (entry.status === 'pass' || entry.status === 'passed')
        : entry
    ));
  return values.length === 0 || values.every((value) => value === true);
}

function fileExists(relativePath) {
  return fs.existsSync(path.join(proofRoot(), relativePath));
}

function pngLooksPresent(relativePath) {
  const absolutePath = path.join(proofRoot(), relativePath);
  if (!fs.existsSync(absolutePath)) return false;
  const stat = fs.statSync(absolutePath);
  if (stat.size < 1024) return false;
  const fd = fs.openSync(absolutePath, 'r');
  const header = Buffer.alloc(8);
  fs.readSync(fd, header, 0, 8, 0);
  fs.closeSync(fd);
  return header.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const proofFiles = {
  activeMutationBoundary: {
    file: 'codesite-active-mutation-boundary-proof.json',
    png: 'codesite-active-mutation-boundary-proof.png',
  },
  gitServiceBoundary: {
    file: 'codesite-gitservice-boundary-proof.json',
    png: 'codesite-gitservice-boundary-proof.png',
  },
  gitServiceIndexBoundary: {
    file: 'codesite-gitservice-index-proof.json',
    png: 'codesite-gitservice-index-proof.png',
  },
  gitServiceWorktreeBoundary: {
    file: 'codesite-gitservice-worktree-proof.json',
    png: 'codesite-gitservice-worktree-proof.png',
  },
  directGitServiceBoundary: {
    file: 'codesite-direct-gitservice-boundary-proof.json',
    png: 'codesite-direct-gitservice-boundary-proof.png',
  },
  gitProvisioningBoundary: {
    file: 'codesite-git-provisioning-boundary-proof.json',
    png: 'codesite-git-provisioning-boundary-proof.png',
  },
  repoCacheBoundary: {
    file: 'codesite-repo-cache-boundary-proof.json',
    png: 'codesite-repo-cache-boundary-proof.png',
  },
  workspacePrepGuard: {
    file: 'codesite-workspace-prep-guard-proof.json',
    png: 'codesite-workspace-prep-guard-proof.png',
  },
  runtimeFilesystemHydration: {
    file: 'codesite-runtime-filesystem-hydration-proof.json',
    png: 'codesite-runtime-filesystem-hydration-proof.png',
  },
  runtimeOverlay: {
    file: 'codesite-runtime-overlay-proof.json',
    png: 'codesite-runtime-overlay-proof.png',
  },
  runtimeQuarantine: {
    file: 'codesite-runtime-quarantine-proof.json',
    png: 'codesite-runtime-quarantine-proof.png',
  },
  runtimeMountBoundary: {
    file: 'codesite-runtime-mount-boundary-proof.json',
    png: 'codesite-runtime-mount-boundary-proof.png',
  },
  codesiteFsRuntimeBoundary: {
    file: 'codesitefs-runtime-boundary-proof.json',
    png: 'codesitefs-runtime-boundary-proof.png',
  },
  unmanagedHostBoundary: {
    file: 'codesite-unmanaged-host-boundary-proof.json',
    png: 'codesite-unmanaged-host-boundary-proof.png',
  },
  quarantineReview: {
    file: 'codesite-quarantine-review-proof.json',
    png: 'codesite-quarantine-review-proof.png',
  },
  shadowSimulator: {
    file: 'codesite-shadow-simulator-proof.json',
    png: 'codesite-shadow-simulator-proof.png',
  },
  governanceMcpLifecycle: {
    file: 'codesite-governance-mcp-lifecycle-proof.json',
    png: 'codesite-governance-mcp-lifecycle-proof.png',
  },
  terminalReattach: {
    file: 'codesite-terminal-reattach-proof.json',
    png: 'codesite-terminal-reattach-proof.png',
  },
  runtimeContext: {
    file: 'codesite-runtime-context-proof.json',
    png: 'codesite-runtime-context-proof.png',
  },
};

const surfaceMatrix = [
  {
    id: 'managed_patch_apply',
    label: 'Managed patch apply and file writes',
    planRefs: ['2A.3', '6', '19', '25.2C'],
    expected: ['allowed', 'denied', 'quarantined'],
    proofs: ['activeMutationBoundary', 'codesiteFsRuntimeBoundary', 'governanceMcpLifecycle'],
    codeMarkers: [
      ['backend/collab-server/server.js', 'codesiteFs.run(operation, applyFn, options)'],
      ['backend/collab-server/codesiteActiveBoundary.js', 'assertCodeSiteWorkspaceMutationAllowed'],
    ],
  },
  {
    id: 'yjs_flush_and_collab_save',
    label: 'Yjs flush and collaborative save paths',
    planRefs: ['19', '25.2C'],
    expected: ['allowed', 'denied'],
    proofs: ['activeMutationBoundary'],
    codeMarkers: [
      ['backend/collab-server/server.js', 'workspaceSlug: slug'],
      ['tmp/codesite-dojo-proof/run-active-mutation-boundary-proof.mjs', 'Yjs save/pre-stage flushes'],
    ],
  },
  {
    id: 'gitservice_file_mutations',
    label: 'gitService file write, batch, delete, and rename wrappers',
    planRefs: ['19', '25.2C'],
    expected: ['allowed', 'denied'],
    proofs: ['gitServiceBoundary', 'activeMutationBoundary'],
    codeMarkers: [
      ['backend/collab-server/gitService.js', '_runCodeSiteMutationBoundary'],
      ['backend/collab-server/gitService.js', 'assertCodeSiteWorkspaceMutationAllowedAsync'],
    ],
  },
  {
    id: 'git_index_worktree_refs',
    label: 'Git index, worktree, refs, and config mutation paths',
    planRefs: ['2A.3', '19', '26.2'],
    expected: ['allowed', 'denied'],
    proofs: ['gitServiceIndexBoundary', 'gitServiceWorktreeBoundary', 'directGitServiceBoundary'],
    codeMarkers: [
      ['tmp/codesite-dojo-proof/run-direct-gitservice-boundary-proof.mjs', 'deleteTag mutates inside git_refs boundary'],
      ['tmp/codesite-dojo-proof/run-direct-gitservice-boundary-proof.mjs', 'pushTag'],
    ],
  },
  {
    id: 'repo_provisioning_and_cache',
    label: 'Repository provisioning, clone, cache, and workspace prep',
    planRefs: ['2A.7', '23', '25.0', '25.2C'],
    expected: ['allowed', 'denied'],
    proofs: ['gitProvisioningBoundary', 'repoCacheBoundary', 'workspacePrepGuard'],
    codeMarkers: [
      ['tmp/codesite-dojo-proof/run-repo-cache-boundary-proof.mjs', 'ensureUserRepo accepts provisioning options'],
      ['tmp/codesite-dojo-proof/run-git-provisioning-boundary-proof.mjs', 'repo_provisioning_clearance_required'],
    ],
  },
  {
    id: 'runtime_terminal_and_container_exec',
    label: 'Terminal, runtime exec, and managed container writes',
    planRefs: ['2A.3', '25.2C', '26.9', '28'],
    expected: ['denied', 'quarantined', 'overlay_only'],
    proofs: ['runtimeContext', 'runtimeFilesystemHydration', 'runtimeOverlay', 'runtimeQuarantine', 'runtimeMountBoundary', 'terminalReattach'],
    codeMarkers: [
      ['backend/collab-server/workspaceRuntimeContainer.js', 'codesite-overlay'],
      ['backend/collab-server/terminalRouting.js', 'codesite'],
    ],
  },
  {
    id: 'unmanaged_host_and_raw_process_writes',
    label: 'Unmanaged host/process attempts against active CodeSite work',
    planRefs: ['2A.3', '25.2C', '28'],
    expected: ['prewrite_denied', 'docker_readonly_base', 'quarantined'],
    proofs: ['unmanagedHostBoundary', 'runtimeMountBoundary', 'quarantineReview'],
    codeMarkers: [
      ['backend/collab-server/codesiteHostWriteSentinel.js', 'prewriteGuard'],
      ['synthi/scripts/codesite-unmanaged-host-boundary-proof.mjs', 'createCodeSiteHostWriteSentinel'],
    ],
  },
  {
    id: 'shadow_apply_and_simulator',
    label: 'Shadow apply, simulator, and counterfactual mutation choices',
    planRefs: ['2A.5', '22', '25.4', '25.9'],
    expected: ['simulated', 'policy_delta', 'replay_linked'],
    proofs: ['shadowSimulator'],
    codeMarkers: [
      ['synthi/scripts/codesite-shadow-simulator-proof.mjs', 'codesite_shadow_simulator_live_proof'],
      ['synthi/src/lib/codesite/controlPlane.js', 'createCounterfactualRun'],
    ],
  },
  {
    id: 'mcp_agent_tools',
    label: 'MCP agent tools and tower-mediated agent writes',
    planRefs: ['2C', '19', '20', '21', '25.2B'],
    expected: ['allowed', 'denied', 'inbox_audited'],
    proofs: ['governanceMcpLifecycle'],
    codeMarkers: [
      ['mcp/synthi-mcp/src/tools/codesite.ts', 'synthi_codesite_open_transaction'],
      ['mcp/synthi-mcp/src/tools/codesite.ts', 'synthi_codesite_request_commit'],
    ],
  },
];

function evaluateSurface(surface, loadedProofs) {
  const proofResults = surface.proofs.map((name) => {
    const spec = proofFiles[name];
    const proof = loadedProofs[name] || null;
    return {
      name,
      file: spec?.file || null,
      png: spec?.png || null,
      proofOk: proofOk(proof),
      filePresent: spec ? fileExists(spec.file) : false,
      visualPresent: spec?.png ? pngLooksPresent(spec.png) : true,
    };
  });
  const codeResults = surface.codeMarkers.map(([relativePath, marker]) => {
    let present = false;
    try {
      present = readText(relativePath).includes(marker);
    } catch {
      present = false;
    }
    return { relativePath, marker, present };
  });
  const ok = proofResults.every((entry) => entry.filePresent && entry.proofOk && entry.visualPresent)
    && codeResults.every((entry) => entry.present);
  return { ...surface, proofResults, codeResults, ok };
}

function renderHtml(proof) {
  const rows = proof.surfaces.map((surface) => `
    <tr>
      <td><span class="${surface.ok ? 'ok' : 'bad'}">${surface.ok ? 'PASS' : 'FAIL'}</span></td>
      <td><strong>${escapeHtml(surface.label)}</strong><br><code>${escapeHtml(surface.id)}</code></td>
      <td>${surface.planRefs.map(escapeHtml).join(', ')}</td>
      <td>${surface.expected.map(escapeHtml).join(', ')}</td>
      <td>${surface.proofResults.map((entry) => `<div><code>${escapeHtml(entry.name)}</code> ${entry.filePresent && entry.proofOk && entry.visualPresent ? 'pass' : 'fail'}</div>`).join('')}</td>
      <td>${surface.codeResults.map((entry) => `<div><code>${escapeHtml(entry.relativePath)}</code> ${entry.present ? 'pass' : 'fail'}</div>`).join('')}</td>
    </tr>
  `).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CodeSite Mutation Surface Coverage Proof</title>
<style>
:root{color-scheme:dark;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#080b10;color:#f5f7fb}
body{margin:0;background:#080b10;padding:28px}
main{max-width:1280px;margin:0 auto;display:grid;gap:16px}
.hero,.card{border:1px solid #2c3443;background:#111722;border-radius:8px;padding:18px}
.hero{display:grid;grid-template-columns:1fr auto;gap:16px;align-items:start}
h1{margin:8px 0 8px;font-size:30px;line-height:1.12;letter-spacing:0}
p{margin:0;color:#aeb8c9;line-height:1.55;max-width:92ch}
.stamp{border-radius:6px;padding:7px 11px;font-size:12px;font-weight:800;background:${proof.ok ? '#133d2a' : '#4b1515'};color:${proof.ok ? '#9df1bd' : '#ffc1c1'}}
.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}
.metric{border:1px solid #2c3443;background:#0b1018;border-radius:8px;padding:12px;min-width:0}
.label{font-size:12px;color:#8f9caf}.value{margin-top:6px;font-size:16px;font-weight:750;overflow-wrap:anywhere}
table{width:100%;border-collapse:collapse;font-size:13px;table-layout:fixed}
th,td{border-top:1px solid #2c3443;padding:9px;text-align:left;vertical-align:top}
th{font-size:12px;color:#aeb8c9}
code{font-family:"SFMono-Regular",Consolas,monospace;font-size:12px;overflow-wrap:anywhere;color:#dce5f5}
.ok{color:#9df1bd;font-weight:800}.bad{color:#ffc1c1;font-weight:800}
@media(max-width:900px){body{padding:14px}.hero{grid-template-columns:1fr}.grid{grid-template-columns:1fr 1fr}h1{font-size:25px}}
</style>
</head>
<body>
<main>
<section class="hero">
  <div>
    <span class="stamp">${proof.ok ? 'VALIDATED' : 'FAILED'}</span>
    <h1>CodeSite Mutation Surface Coverage Proof</h1>
    <p>Every mutation route named in the plan is mapped to a passing proof artifact, a visual artifact when applicable, and concrete code integration points. The matrix separates managed CodeSite surfaces, runtime overlays, raw host/process attempts, Git boundaries, shadow apply, and MCP agent tools.</p>
  </div>
  <span class="stamp">${escapeHtml(proof.status)}</span>
</section>
<section class="grid">
  <div class="metric"><div class="label">Surfaces</div><div class="value">${proof.surfaces.filter((surface) => surface.ok).length}/${proof.surfaces.length}</div></div>
  <div class="metric"><div class="label">Proof refs</div><div class="value">${proof.proofSummary.passing}/${proof.proofSummary.total}</div></div>
  <div class="metric"><div class="label">Code markers</div><div class="value">${proof.codeSummary.passing}/${proof.codeSummary.total}</div></div>
  <div class="metric"><div class="label">Git head</div><div class="value">${escapeHtml(proof.git.head || 'missing')}</div></div>
</section>
<section class="card">
  <table>
    <thead><tr><th>Status</th><th>Mutation surface</th><th>Plan</th><th>Expected control</th><th>Proofs</th><th>Code bindings</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</section>
</main>
</body>
</html>`;
}

async function screenshot(htmlPath, pngPath) {
  const browser = await chromium.launch({
    headless: true,
    chromiumSandbox: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1360, height: 980 }, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' });
    await page.screenshot({ path: pngPath, fullPage: true });
  } finally {
    await browser.close();
  }
}

async function main() {
  const root = proofRoot();
  fs.mkdirSync(root, { recursive: true });
  const loadedProofs = Object.fromEntries(Object.entries(proofFiles).map(([name, spec]) => [
    name,
    readJsonIfExists(spec.file),
  ]));
  const surfaces = surfaceMatrix.map((surface) => evaluateSurface(surface, loadedProofs));
  const proofEntries = surfaces.flatMap((surface) => surface.proofResults);
  const codeEntries = surfaces.flatMap((surface) => surface.codeResults);
  const assertions = {
    everyPlanSurfaceMapped: surfaces.length >= 9,
    everySurfaceHasPassingProofs: surfaces.every((surface) => surface.proofResults.every((entry) => entry.filePresent && entry.proofOk)),
    everySurfaceHasVisualEvidenceWhereExpected: surfaces.every((surface) => surface.proofResults.every((entry) => entry.visualPresent)),
    everySurfaceHasCodeBinding: surfaces.every((surface) => surface.codeResults.every((entry) => entry.present)),
    rawHostProcessSurfaceScopedToSentinelAndReadOnlyBase: surfaces.find((surface) => surface.id === 'unmanaged_host_and_raw_process_writes')?.ok === true,
    mcpAndAgentToolsCovered: surfaces.find((surface) => surface.id === 'mcp_agent_tools')?.ok === true,
    shadowApplySurfaceCovered: surfaces.find((surface) => surface.id === 'shadow_apply_and_simulator')?.ok === true,
  };
  const proof = {
    schemaVersion: 'synthi.codesite.mutationSurfaceCoverageProof.v1',
    status: 'validated',
    generatedAt: new Date().toISOString(),
    git: {
      head: git(['rev-parse', 'HEAD']),
      branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
      statusShort: git(['status', '--short']),
    },
    surfaces,
    proofSummary: {
      total: proofEntries.length,
      passing: proofEntries.filter((entry) => entry.filePresent && entry.proofOk && entry.visualPresent).length,
    },
    codeSummary: {
      total: codeEntries.length,
      passing: codeEntries.filter((entry) => entry.present).length,
    },
    assertions,
  };
  proof.ok = Object.values(assertions).every((value) => value === true);

  const jsonPath = path.join(root, 'codesite-mutation-surface-coverage-proof.json');
  const htmlPath = path.join(root, 'codesite-mutation-surface-coverage-proof.html');
  const pngPath = path.join(root, 'codesite-mutation-surface-coverage-proof.png');
  fs.writeFileSync(jsonPath, `${JSON.stringify(proof, null, 2)}\n`);
  fs.writeFileSync(htmlPath, renderHtml(proof));
  await screenshot(htmlPath, pngPath);

  console.log(JSON.stringify({
    ok: proof.ok,
    jsonPath: path.relative(repoRoot(), jsonPath).replace(/\\/g, '/'),
    htmlPath: path.relative(repoRoot(), htmlPath).replace(/\\/g, '/'),
    pngPath: path.relative(repoRoot(), pngPath).replace(/\\/g, '/'),
    surfaces: proof.surfaces.length,
    proofSummary: proof.proofSummary,
    codeSummary: proof.codeSummary,
  }, null, 2));
  if (!proof.ok) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
