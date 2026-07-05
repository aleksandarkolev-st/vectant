import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { ensureProofWorkspace } from './codesite-proof-api.mjs';

const DEFAULT_BASE_URL = 'http://127.0.0.1:3107';

function repoRoot() {
  return path.basename(process.cwd()) === 'synthi'
    ? path.dirname(process.cwd())
    : process.cwd();
}

function proofDir() {
  return path.resolve(process.env.CODESITE_PROOF_OUT_DIR || path.join(repoRoot(), 'tmp', 'codesite-dojo-proof'));
}

function slugNow() {
  return `codesite-repo-policy-compiler-proof-${Date.now()}`;
}

function createApi(baseUrl, slug) {
  const apiBase = `${baseUrl.replace(/\/+$/, '')}/api/workspace/${encodeURIComponent(slug)}/codesite`;
  async function api(route, options = {}) {
    const response = await fetch(`${apiBase}${route}`, {
      ...options,
      headers: {
        'content-type': 'application/json',
        ...(options.headers || {}),
      },
    });
    const text = await response.text();
    let body = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { raw: text };
    }
    if (!response.ok) {
      throw new Error(`${options.method || 'GET'} ${route} returned ${response.status}: ${JSON.stringify(body)}`);
    }
    return body;
  }
  return api;
}

function write(root, rel, content) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function prepareFixtureRepo(dir, slug) {
  const root = path.join(dir, 'codesite-policy-compiler-repos', slug);
  fs.rmSync(root, { recursive: true, force: true });
  write(root, 'package.json', JSON.stringify({ private: true, workspaces: ['packages/*', 'apps/*'] }, null, 2));
  write(root, '.github/CODEOWNERS', [
    'api/auth/** @security',
    'packages/contracts/** @platform',
  ].join('\n'));
  write(root, 'openapi/auth.yaml', [
    'openapi: 3.1.0',
    'paths:',
    '  /auth/signup:',
    '    post:',
    '      operationId: signup',
  ].join('\n'));
  write(root, 'synthi/prisma/schema.prisma', 'model User { id String @id email String @unique }\n');
  write(root, 'synthi/prisma/migrations/202607010001_auth/migration.sql', 'CREATE TABLE "User" (id text primary key, email text unique);\n');
  write(root, 'packages/contracts/package.json', JSON.stringify({
    name: '@acme/contracts',
    exports: {
      '.': {
        types: './src/index.d.ts',
        import: './src/index.ts',
        require: './dist/index.cjs',
      },
      './server': {
        import: './src/server.ts',
        default: './src/server.ts',
      },
      './features/*': './src/features/*.ts',
    },
  }, null, 2));
  write(root, 'packages/contracts/src/index.ts', 'export type Signup = { email: string; displayName?: string };\n');
  write(root, 'packages/contracts/src/server.ts', 'export const server = { runtime: "node" };\n');
  write(root, 'packages/contracts/src/features/audit.ts', 'export const audit = { enabled: true };\n');
  write(root, 'apps/web/signup/SignupForm.tsx', [
    'import React from "react";',
    'import type { Signup } from "@acme/contracts";',
    'import { server } from "@acme/contracts/server";',
    'import { audit } from "@acme/contracts/features/audit";',
    'export const form = { server, audit, React } as unknown as Signup;',
  ].join('\n'));
  write(root, 'apps/web/signup/SignupForm.test.tsx', 'import { form } from "./SignupForm";\nvoid form;\n');
  write(root, 'app/api/auth/signup/route.ts', 'import type { Signup } from "@acme/contracts";\nexport async function POST(_: Request) { return Response.json({ ok: true } as Signup); }\n');
  write(root, 'infra/prod/kustomization.yaml', 'resources: []\n');
  write(root, '.synthi/codesite/proof/incidents/auth-near-miss.json', JSON.stringify({
    category: 'near_miss',
    severity: 'high',
    affectedPaths: ['packages/contracts/**', 'api/auth/**'],
  }, null, 2));
  write(root, '.env.example', 'TOKEN=redacted\n');
  return root;
}

function assertProof(condition, message) {
  if (!condition) throw new Error(message);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sourceTable(policy) {
  return Object.entries(policy.policySources || {})
    .map(([key, value]) => `<tr><td>${escapeHtml(key)}</td><td>${escapeHtml(value)}</td></tr>`)
    .join('\n');
}

function edgeTable(edges) {
  return edges.map((edge) => `<tr><td>${escapeHtml(edge.from)}</td><td>${escapeHtml(edge.imports.join(', '))}</td></tr>`).join('\n');
}

function packageExportTable(entries) {
  return entries.map((entry) => `<tr><td>${escapeHtml(entry.packageName)}</td><td>${escapeHtml(entry.root)}</td><td>${escapeHtml(JSON.stringify(entry.exportMap || {}, null, 2))}</td></tr>`).join('\n');
}

function zoneTable(zones) {
  return zones.map((zone) => `<tr><td>${escapeHtml(zone.source)}</td><td>${escapeHtml(zone.label)}</td><td>${escapeHtml(zone.class)}</td><td>${escapeHtml((zone.paths || []).join(', '))}</td></tr>`).join('\n');
}

function proofHtml(proof) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CodeSite Repo Policy Compiler Proof</title>
<style>
:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#080a10;color:#f4f7fb}
body{margin:0;padding:28px;background:#080a10}
main{max-width:1180px;margin:0 auto;display:grid;gap:18px}
.hero,.card{border:1px solid #252d3f;border-radius:8px;background:#10131c;padding:18px}
.pass{display:inline-block;border-radius:6px;background:#123b27;color:#9df2bd;padding:4px 8px;font-size:12px;font-weight:700}
h1{margin:8px 0 6px;font-size:25px;letter-spacing:0}
h2{font-size:16px;margin:0 0 10px}
p{margin:0;color:#a5adbf;line-height:1.5}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px}
.label{color:#98a2b8;font-size:12px}
.value{margin-top:6px;font-size:14px;overflow-wrap:anywhere}
table{width:100%;border-collapse:collapse;font-size:13px}
td,th{border-top:1px solid #252d3f;padding:8px;text-align:left;vertical-align:top}
th{color:#a5adbf;font-weight:600}
pre{white-space:pre-wrap;border:1px solid #252d3f;border-radius:8px;background:#05060a;padding:14px;color:#cbd1e3;font-size:12px}
</style>
</head>
<body>
<main>
<section class="hero">
<span class="pass">PASS</span>
<h1>CodeSite Repo Policy Compiler Proof</h1>
<p>Live Docker workflow using a real fixture repository, package-name imports, conditional and wildcard package export maps, OpenAPI paths, CODEOWNERS, Prisma migrations, test ownership, deployment config, secret patterns, past incidents, and the CodeSite project API.</p>
</section>
<section class="grid">
<div class="card"><div class="label">Workspace</div><div class="value">${escapeHtml(proof.slug)}</div></div>
<div class="card"><div class="label">Project</div><div class="value">${escapeHtml(proof.project.id)}</div></div>
<div class="card"><div class="label">Compiler digest</div><div class="value">${escapeHtml(proof.signals.sourceDigest)}</div></div>
<div class="card"><div class="label">Repo root</div><div class="value">${escapeHtml(proof.fixtureRepo)}</div></div>
</section>
<section class="card"><h2>Policy Sources</h2><table><tbody>${sourceTable(proof.policy)}</tbody></table></section>
<section class="card"><h2>Package Export Maps</h2><table><thead><tr><th>Package</th><th>Root</th><th>Export map</th></tr></thead><tbody>${packageExportTable(proof.signals.packageExports)}</tbody></table></section>
<section class="card"><h2>Import Graph</h2><table><thead><tr><th>From</th><th>Resolved imports</th></tr></thead><tbody>${edgeTable(proof.signals.importEdges)}</tbody></table></section>
<section class="card"><h2>Contract Zones</h2><table><thead><tr><th>Source</th><th>Label</th><th>Class</th><th>Paths</th></tr></thead><tbody>${zoneTable(proof.contractZones)}</tbody></table></section>
<section><pre>${escapeHtml(JSON.stringify(proof.assertions, null, 2))}</pre></section>
</main>
</body>
</html>`;
}

async function screenshotSummary(htmlPath, pngPath) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 1 });
  await page.goto(`file://${htmlPath}`, { waitUntil: 'load' });
  await page.screenshot({ path: pngPath, fullPage: true });
  await browser.close();
}

async function main() {
  const baseUrl = process.env.CODESITE_PROOF_BASE_URL || DEFAULT_BASE_URL;
  const slug = process.env.CODESITE_PROOF_WORKSPACE_SLUG || slugNow();
  const dir = proofDir();
  fs.mkdirSync(dir, { recursive: true });
  const fixtureRepo = prepareFixtureRepo(dir, slug);
  const { api } = await ensureProofWorkspace(baseUrl, slug, {
    workspaceName: 'Repo policy compiler proof workspace',
  });

  const projectResponse = await api('/projects', {
    method: 'POST',
    body: JSON.stringify({
      title: 'Repo policy compiler proof',
      request: 'Compile CodeSite airspace policy from real repo signals',
      repoRoot: fixtureRepo,
      autoWorkflow: true,
      missions: [
        {
          callsign: 'COMPILER-01',
          domain: 'schema',
          mission: 'Inspect compiled contract policy',
          route: ['packages/contracts/src/index.ts', 'openapi/auth.yaml'],
          requestedTools: ['read_file'],
        },
      ],
    }),
  });
  const project = projectResponse.project;
  const fetchedProject = await api(`/projects/${encodeURIComponent(project.id)}`);
  const artifactPreview = await api(`/projects/${encodeURIComponent(project.id)}/artifacts/preview?include=content`);
  const apiPolicy = fetchedProject.project.zonePolicy;
  const openapiZone = apiPolicy.zones.find((zone) => zone.source === 'repo_openapi');
  const packageImportEdge = apiPolicy.semanticGraph.importEdges.find((edge) => edge.from === 'apps/web/signup/SignupForm.tsx');
  const apiImportEdge = apiPolicy.semanticGraph.importEdges.find((edge) => edge.from === 'app/api/auth/signup/route.ts');
  const packageExport = apiPolicy.semanticGraph.packageExports.find((entry) => entry.packageName === '@acme/contracts');
  const testOwner = apiPolicy.semanticGraph.testOwnership.find((owner) => owner.testPath === 'apps/web/signup/SignupForm.test.tsx');
  const contractZones = apiPolicy.zones.filter((zone) => ['repo_openapi', 'repo_package_exports', 'repo_prisma_migration', 'repo_past_incident'].includes(zone.source));
  const compilerArtifact = (artifactPreview.files || []).find((file) => file.path === 'airspace/compiler-output.json');
  const manifestArtifact = (artifactPreview.files || []).find((file) => file.path === 'manifest.json');
  const compilerArtifactContent = compilerArtifact?.contentPreview ? JSON.parse(compilerArtifact.contentPreview) : null;
  const manifestContent = manifestArtifact?.contentPreview ? JSON.parse(manifestArtifact.contentPreview) : null;

  const assertions = {
    packageNameImportResolved: packageImportEdge?.imports?.includes('packages/contracts/src/index.ts') === true
      && apiImportEdge?.imports?.includes('packages/contracts/src/index.ts') === true
      && packageImportEdge?.imports?.includes('packages/contracts/src/server.ts') === true
      && packageImportEdge?.imports?.includes('packages/contracts/src/features/audit.ts') === true
      && packageImportEdge?.imports?.includes('react') !== true,
    packageExportMapPreserved: packageExport?.exportMap?.['.']?.includes('packages/contracts/src/index.ts') === true
      && packageExport?.exportMap?.['./server']?.includes('packages/contracts/src/server.ts') === true
      && packageExport?.exportMap?.['./features/*']?.includes('packages/contracts/src/features/*.ts') === true,
    openApiContractParsed: openapiZone?.contractPaths?.includes('/auth/signup') === true
      && openapiZone?.operations?.some((operation) => operation.method === 'POST' && operation.path === '/auth/signup') === true,
    openApiRoutesClassified: openapiZone?.paths?.includes('api/auth/signup/**') === true
      && openapiZone?.paths?.includes('app/api/auth/signup/**') === true,
    testOwnershipResolved: testOwner?.covers?.includes('apps/web/signup/SignupForm.tsx') === true,
    prismaMigrationLockCompiled: apiPolicy.semanticGraph.migrationLocks.includes('synthi/prisma/migrations') === true,
    pastIncidentCompiled: apiPolicy.policySources.pastIncidents === 1
      && apiPolicy.zones.some((zone) => zone.source === 'repo_past_incident' && zone.paths.includes('packages/contracts/**')),
    codeownersAndSecretsCompiled: apiPolicy.policySources.codeowners === 2
      && apiPolicy.noFlyZones.includes('**/.env.*'),
    apiProjectUsedCompiler: fetchedProject.project.id === project.id
      && apiPolicy.policySources.packageExports === 1
      && apiPolicy.policySources.openapi === 1,
    compilerArtifactExported: manifestContent?.compiler_output === 'airspace/compiler-output.json'
      && compilerArtifactContent?.schemaVersion === 'synthi.codesite.repoPolicyCompilerOutput.v1'
      && compilerArtifactContent?.compiler?.sourceDigest === apiPolicy.compiler?.sourceDigest
      && compilerArtifactContent?.compiler?.policyDigest === apiPolicy.compiler?.policyDigest,
  };

  for (const [key, value] of Object.entries(assertions)) {
    assertProof(value === true, `assertion failed: ${key}`);
  }

  const proof = {
    generatedAt: new Date().toISOString(),
    baseUrl,
    slug,
    fixtureRepo,
    project: {
      id: project.id,
      title: project.title,
      route: `/workspace/${slug}/codesite`,
    },
    signals: apiPolicy.semanticGraph,
    policy: apiPolicy,
    artifactPreview: {
      compilerOutputPath: compilerArtifact?.path || null,
      compilerOutput: compilerArtifactContent,
      manifest: manifestContent,
    },
    contractZones,
    assertions,
  };

  const jsonPath = path.join(dir, 'codesite-repo-policy-compiler-proof.json');
  const htmlPath = path.join(dir, 'codesite-repo-policy-compiler-proof.html');
  const pngPath = path.join(dir, 'codesite-repo-policy-compiler-proof.png');
  fs.writeFileSync(jsonPath, `${JSON.stringify(proof, null, 2)}\n`);
  fs.writeFileSync(htmlPath, proofHtml(proof));
  await screenshotSummary(htmlPath, pngPath);

  console.log(JSON.stringify({
    ok: true,
    jsonPath: path.relative(repoRoot(), jsonPath),
    htmlPath: path.relative(repoRoot(), htmlPath),
    pngPath: path.relative(repoRoot(), pngPath),
    assertions,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
