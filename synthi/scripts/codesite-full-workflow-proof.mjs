import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import { chromium } from 'playwright';
import {
  canonicalDojoProofPayload,
  createEd25519DojoProofSigner,
  generateEd25519DojoProofKeyPair,
} from '../../mcp/synthi-mcp/dist/dojo/proof/signing.js';

const require = createRequire(import.meta.url);
const {
  collectCodeSiteRepoState,
  createCodeSiteFS,
  createCodeSiteQuarantineWorkspace,
  deriveLineProvenanceFromContentChange,
  finalizeCodeSiteQuarantineWorkspace,
} = require('../../backend/collab-server/codesiteFs.js');
const { codeSiteTerminalLaunchMode } = require('../../backend/collab-server/terminalRouting.js');
const { codeSiteProgramRuntimeLaunchMode } = require('../../backend/collab-server/runtimePodTerminal.js');
const execFileAsync = promisify(execFile);

const DEFAULT_BASE_URL = 'http://127.0.0.1:3107';
const DEFAULT_LIVE_UI_ROUTE_TIMEOUT_MS = 360000;
const DEFAULT_LIVE_UI_NAVIGATION_TIMEOUT_MS = 180000;
const PLAN_BLACK_BOX_MINIMUM_EVENT_TYPES = [
  'transaction.opened',
  'assumption.recorded',
  'clearance.issued',
  'read.observed',
  'write.attempted',
  'write.denied',
  'snapshot.taken',
  'shadow.run',
  'arbiter.verdict',
  'inspection.result',
  'near_miss.detected',
  'policy_delta.proposed',
  'transaction.committed',
  'transaction.aborted',
];

function repoRoot() {
  return path.basename(process.cwd()) === 'synthi'
    ? path.dirname(process.cwd())
    : process.cwd();
}

function outDir() {
  return path.resolve(process.env.CODESITE_PROOF_OUT_DIR || path.join(repoRoot(), 'tmp', 'codesite-dojo-proof'));
}

function containerRepoRoot(hostPath) {
  const containerRoot = process.env.CODESITE_PROOF_CONTAINER_WORKSPACE_ROOT || '/workspace';
  const relative = path.relative(repoRoot(), hostPath).split(path.sep).join('/');
  return path.posix.join(containerRoot, relative);
}

function slugNow() {
  return `codesite-full-workflow-proof-${Date.now()}`;
}

function proofTimeoutMs(envName, fallbackMs) {
  const value = Number(process.env[envName]);
  return Number.isFinite(value) && value > 0 ? value : fallbackMs;
}

function signedDojoProof(slug) {
  const keyPair = generateEd25519DojoProofKeyPair('dojo-full-workflow-key');
  const signer = createEd25519DojoProofSigner({
    key_id: keyPair.key_id,
    private_key_pem: keyPair.private_key_pem,
  });
  const unsignedCapsule = {
    schema_version: 'synthi.dojo.proofCapsule.v1',
    capsule_id: 'pcap-full-workflow-schema',
    skill_id: 'codesite.schema',
    skill_version: '2026-06-25.1',
    requested_action: 'codesite.mutation.clearance',
    license_version: 'schema.level_2@2026-06-25',
    issuer: 'dojo-full-workflow-issuer',
    key_id: keyPair.key_id,
    nonce: `nonce-${Date.now()}`,
    ledger_checkpoint_hash: 'd'.repeat(64),
    evidence_claims: [{
      claim: 'codesite.restricted_mutation',
      satisfied: true,
      evidence_refs: ['evidence:full-workflow-checkride'],
    }],
    evidence_record_ids: ['full-workflow-checkride'],
    issued_at: '2026-06-29T00:00:00.000Z',
    expires_at: '2026-08-01T00:00:00.000Z',
    signature_algorithm: 'ed25519',
  };
  const signature = signer.sign(canonicalDojoProofPayload(unsignedCapsule));
  return {
    dojoProofCapsule: {
      ...unsignedCapsule,
      signature: signature.signature,
    },
    dojoProofKey: {
      schema_version: 'synthi.dojo.proofKey.v1',
      tenant_id: slug,
      key_id: keyPair.key_id,
      issuer: 'dojo-full-workflow-issuer',
      algorithm: 'ed25519',
      signing_provider: 'ed25519-local',
      key_custody: 'local',
      public_key_pem: keyPair.public_key_pem,
      status: 'active',
      created_at: '2026-06-29T00:00:00.000Z',
      retain_for_forensic_verification: false,
    },
    dojoRequiredEvidenceClaims: ['codesite.restricted_mutation'],
    implementationStatus: {
      executable: true,
      productionRuntime: true,
      verificationRuntime: 'codesite-ed25519-proof-verifier',
      runtimeBoundary: 'docker-full-workflow-proof',
    },
  };
}

function authCookieHeader() {
  return String(process.env.CODESITE_PROOF_AUTH_COOKIE || '').trim();
}

async function nextAuthCookieForActor(actor) {
  const secret = process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error('AUTH_SECRET or NEXTAUTH_SECRET is required to mint temporary proof actor sessions');
  const { encode } = await import('next-auth/jwt');
  const token = await encode({
    secret,
    token: {
      name: actor.name,
      email: actor.email,
      sub: actor.sessionUserId,
      userId: actor.sessionUserId,
      picture: null,
    },
    maxAge: 60 * 60,
  });
  return `next-auth.session-token=${token}`;
}

async function proofActors(baseUrl, slug) {
  const specs = [
    { key: 'owner', name: 'CodeSite Proof Owner', email: `codesite-owner+${slug}@example.test`, role: 'owner' },
    { key: 'schema', name: 'Schema Agent User', email: `codesite-schema+${slug}@example.test`, role: 'admin' },
    { key: 'api', name: 'API Agent User', email: `codesite-api+${slug}@example.test`, role: 'admin' },
    { key: 'test', name: 'Test Agent User', email: `codesite-test+${slug}@example.test`, role: 'admin' },
  ];
  const actors = Object.fromEntries(await Promise.all(specs.map(async (spec) => [
    spec.key,
    {
      ...spec,
      sessionUserId: `${slug}-${spec.key}`,
      authCookie: await nextAuthCookieForActor({ ...spec, sessionUserId: `${slug}-${spec.key}` }),
    },
  ])));
  const app = createAppApi(baseUrl, { authCookie: actors.owner.authCookie });
  try {
    await app('/api/workspace', {
      method: 'POST',
      body: JSON.stringify({
        name: `CodeSite proof ${slug}`,
        slug,
        repoUrl: `proof://${slug}`,
      }),
    });
  } catch (error) {
    const optionalWorkspaceItemFailed = error.status === 500
      && /workspace item/i.test(String(error.body?.error || error.message || ''));
    if (error.status !== 409 && !optionalWorkspaceItemFailed) throw error;
  }
  for (const actor of [actors.schema, actors.api, actors.test]) {
    const response = await app(`/api/workspace/${encodeURIComponent(slug)}/members`, {
      method: 'POST',
      body: JSON.stringify({ email: actor.email, role: actor.role }),
    });
    actor.userId = response.member?.user?.id || null;
  }
  const membersResponse = await app(`/api/workspace/${encodeURIComponent(slug)}/members`);
  for (const member of membersResponse.members || []) {
    const actor = Object.values(actors).find((item) => item.email === member.user?.email);
    if (actor) actor.userId = member.user?.id || actor.userId || null;
  }
  for (const actor of Object.values(actors)) {
    if (!actor.userId) throw new Error(`proof actor ${actor.key} was not materialized as a workspace user`);
  }
  return {
    mode: 'generated_nextauth_jwt_multi_user',
    workspace: membersResponse.workspace,
    actors,
  };
}

function createAppApi(baseUrl, { authCookie = '' } = {}) {
  const appBase = baseUrl.replace(/\/+$/, '');
  async function appApi(route, options = {}) {
    const method = options.method || 'GET';
    let response;
    try {
      response = await fetch(`${appBase}${route}`, {
        ...options,
        headers: {
          'content-type': 'application/json',
          ...(authCookie ? { cookie: authCookie } : {}),
          ...(options.headers || {}),
        },
      });
    } catch (error) {
      const cause = error?.cause;
      const detail = [
        `${method} ${route} fetch failed`,
        cause?.code ? `code=${cause.code}` : null,
        cause?.errno ? `errno=${cause.errno}` : null,
        cause?.address ? `address=${cause.address}` : null,
        cause?.port ? `port=${cause.port}` : null,
        cause?.message ? `cause=${cause.message}` : null,
      ].filter(Boolean).join('; ');
      const wrapped = new Error(detail || `${method} ${route} fetch failed`);
      wrapped.cause = error;
      throw wrapped;
    }
    return parseJsonResponse(response, route, method);
  }
  return appApi;
}

async function parseJsonResponse(response, route, method) {
  const text = await response.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!response.ok) {
    const error = new Error(`${method} ${route} returned ${response.status}: ${JSON.stringify(body)}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

function createApi(baseUrl, slug, { authCookie = '' } = {}) {
  const apiBase = `${baseUrl.replace(/\/+$/, '')}/api/workspace/${encodeURIComponent(slug)}/codesite`;
  async function api(route, options = {}) {
    const response = await fetch(`${apiBase}${route}`, {
      ...options,
      headers: {
        'content-type': 'application/json',
        ...(authCookie ? { cookie: authCookie } : {}),
        ...(options.headers || {}),
      },
    });
    return parseJsonResponse(response, route, options.method || 'GET');
  }
  api.baseUrl = apiBase;
  return api;
}

function authCookiesForBaseUrl(baseUrl, cookieHeader) {
  if (!cookieHeader) return [];
  const url = baseUrl.replace(/\/+$/, '');
  return cookieHeader
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const separator = part.indexOf('=');
      if (separator <= 0) return null;
      return {
        name: part.slice(0, separator),
        value: part.slice(separator + 1),
        url,
      };
    })
    .filter(Boolean);
}

function createAuthenticatedFetch(authCookie) {
  if (!authCookie) return fetch;
  return (input, init = {}) => {
    const headers = new Headers(init.headers || {});
    if (!headers.has('cookie')) {
      headers.set('cookie', authCookie);
    }
    return fetch(input, { ...init, headers });
  };
}

function safeArtifactSegment(value) {
  return String(value || 'workspace')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    || 'workspace';
}

function requireValue(value, message) {
  if (!value) throw new Error(message);
  return value;
}

function assertProof(condition, message) {
  if (!condition) throw new Error(message);
}

function eventTypesFromReplay(replay) {
  return new Set((replay?.replay?.causalEvents || replay?.causalEvents || []).map((event) => event.type).filter(Boolean));
}

function missingEventTypes(replay, requiredTypes = PLAN_BLACK_BOX_MINIMUM_EVENT_TYPES) {
  const observed = eventTypesFromReplay(replay);
  return requiredTypes.filter((type) => !observed.has(type));
}

function allAssertionsTrue(assertions) {
  return Object.values(assertions || {}).every((value) => value === true);
}

function normalizeCommandText(value) {
  return String(value || '')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
    .trim()
    .replace(/\s+/g, ' ');
}

function commandTokens(value) {
  return unique(normalizeCommandText(value)
    .toLowerCase()
    .replace(/[$"'`]/g, ' ')
    .split(/[^a-z0-9_./:*,-]+/i)
    .map((token) => token.trim())
    .filter((token) => token && !['bin', 'bash', 'sh', 'lc', '-lc', 'c'].includes(token)));
}

function tokenMatches(left, right) {
  if (left === right) return true;
  if (left.length < 4 || right.length < 4) return false;
  return left.includes(right) || right.includes(left);
}

function reportedCommandBackedByTranscript(reported, transcriptCommands = []) {
  const normalizedReported = normalizeCommandText(reported);
  if (!normalizedReported) return true;
  if (transcriptCommands.some((actual) => actual === normalizedReported || actual.includes(normalizedReported))) {
    return true;
  }
  const reportedTokens = commandTokens(normalizedReported);
  if (reportedTokens.length < 3) return false;
  return transcriptCommands.some((actual) => {
    const actualTokens = commandTokens(actual);
    if (!actualTokens.length) return false;
    const matched = reportedTokens.filter((reportedToken) => actualTokens.some((actualToken) => tokenMatches(reportedToken, actualToken)));
    const requiredMatches = Math.max(3, Math.ceil(reportedTokens.length * 0.65));
    const commandVerb = reportedTokens.find((token) => /^[a-z][a-z0-9_-]*$/i.test(token));
    const verbMatched = !commandVerb || actualTokens.some((actualToken) => tokenMatches(commandVerb, actualToken));
    return verbMatched && matched.length >= requiredMatches;
  });
}

function roleCommandRequirements(role) {
  if (role === 'schema') {
    return [{ key: 'schema_typecheck', pattern: /\bnpm\s+run\s+typecheck\b/ }];
  }
  if (role === 'inspection') {
    return [{ key: 'inspection_tests', pattern: /\bnpm\s+test\b/ }];
  }
  if (role === 'backend') {
    return [{ key: 'backend_file_inspection', pattern: /\b(rg|grep|sed|cat|pwd|ls|find)\b/ }];
  }
  return [];
}

function roleWorkflowActionRequirements(role) {
  if (role === 'schema') {
    return [
      'control_state_read',
      'execution_plan_filed',
      'mutation_lease_requested',
      'mutation_transaction_opened',
      'assumption_recorded',
      'controlled_write_proposed',
      'inspection_requested',
      'commit_requested',
    ];
  }
  if (role === 'backend') {
    return [
      'control_state_read',
      'execution_plan_filed',
      'inbox_read',
      'inbox_event_acknowledged',
      'change_order_filed',
      'stale_transaction_aborted',
    ];
  }
  if (role === 'inspection') {
    return [
      'control_state_read',
      'execution_plan_filed',
      'landing_requested',
      'metrics_read',
    ];
  }
  return [];
}

function workflowActionBackedByTranscript(action, transcriptCommands = []) {
  const commandAction = String(action?.action || '').trim();
  if (!commandAction) return false;
  return transcriptCommands.some((command) => {
    const normalized = normalizeCommandText(command);
    return normalized.includes('codesite-agent-action.mjs')
      && normalized.includes(` ${commandAction}`);
  });
}

function inspectionSignalRanNpmScript(signal, scriptName, evidencePrefix) {
  const command = signal?.command || {};
  const args = asArray(command.args);
  return signal?.source === 'codesite_inspection_executor'
    && Number(signal.exitCode) === 0
    && signal.status === 'passed'
    && command.executable === 'npm'
    && args[0] === (scriptName === 'test' ? 'test' : 'run')
    && (scriptName === 'test' || args[1] === scriptName)
    && Array.isArray(signal.evidenceRefs)
    && signal.evidenceRefs.some((ref) => String(ref).startsWith(evidencePrefix))
    && String(signal.stdoutTail || '').includes(scriptName === 'typecheck' ? 'schema typecheck passed' : 'schema contract tests passed');
}

function stableJson(value) {
  return JSON.stringify(sortJson(value));
}

function sortJson(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key])]));
}

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function unique(values) {
  return Array.from(new Set(asArray(values)));
}

function proofSecretPatterns() {
  return [
    { name: 'github_pat', pattern: /\bgithub_pat_[A-Za-z0-9_]{8,}\b/g, replacement: '[REDACTED:github_pat]' },
    { name: 'github_classic_pat', pattern: /\bghp_[A-Za-z0-9_]{3,}\b/g, replacement: '[REDACTED:github_classic_pat]' },
    { name: 'openai_project_key', pattern: /sk-proj-[A-Za-z0-9_-]{20,}/g, replacement: 'sk-proj-[REDACTED:openai_project_key]' },
    { name: 'openai_secret_key', pattern: /\bsk-[A-Za-z0-9_-]{32,}\b/g, replacement: 'sk-[REDACTED:openai_secret_key]' },
    {
      name: 'private_key',
      pattern: /-----BEGIN (?:OPENSSH|RSA|EC|DSA)? ?PRIVATE KEY-----[\s\S]*?-----END (?:OPENSSH|RSA|EC|DSA)? ?PRIVATE KEY-----/g,
      replacement: '[REDACTED:private_key_material]',
    },
    {
      name: 'nextauth_cookie',
      pattern: /((?:__Secure-)?next-auth\.session-token=)[^;\s"']{16,}/g,
      replacement: '$1[REDACTED:nextauth_cookie]',
    },
    {
      name: 'bearer_jwt',
      pattern: /Bearer\s+eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
      replacement: 'Bearer [REDACTED:bearer_jwt]',
    },
    {
      name: 'bearer_opaque',
      pattern: /Bearer\s+[A-Za-z0-9_~+/-]{48,}/g,
      replacement: 'Bearer [REDACTED:bearer_opaque]',
    },
  ];
}

function redactProofArtifactSecrets(text) {
  let redacted = String(text || '');
  const counts = {};
  for (const { name, pattern, replacement } of proofSecretPatterns()) {
    pattern.lastIndex = 0;
    let count = 0;
    redacted = redacted.replace(pattern, (...args) => {
      count += 1;
      const resolvedReplacement = typeof replacement === 'function'
        ? replacement(...args)
        : String(replacement).replace(/\$(\d+)/g, (_, index) => args[Number(index)] || '');
      return resolvedReplacement;
    });
    if (count > 0) counts[name] = count;
  }
  return { text: redacted, counts };
}

function mergeRedactionCounts(...entries) {
  const merged = {};
  for (const entry of entries) {
    for (const [name, count] of Object.entries(entry || {})) {
      merged[name] = (merged[name] || 0) + Number(count || 0);
    }
  }
  return merged;
}

function digest(value) {
  return `sha256:${crypto.createHash('sha256').update(stableJson(value)).digest('hex')}`;
}

async function fileSha256(absolutePath) {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(absolutePath);
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return `sha256:${hash.digest('hex')}`;
}

function relativeProofPath(absolutePath) {
  return path.relative(repoRoot(), absolutePath).split(path.sep).join('/');
}

function proofRunDir(dir, slug) {
  return path.join(dir, 'runs', safeArtifactSegment(slug));
}

function proofOutputPaths(dir, slug) {
  const runDir = proofRunDir(dir, slug);
  return {
    runDir,
    jsonPath: path.join(runDir, 'codesite-full-workflow-proof.json'),
    publicationPath: path.join(runDir, 'codesite-full-workflow-publication.json'),
    failureDiagnosticsPath: path.join(runDir, 'codesite-full-workflow-failure.json'),
    htmlPath: path.join(runDir, 'codesite-full-workflow-proof.html'),
    pngPath: path.join(runDir, 'codesite-full-workflow-proof.png'),
    summaryPngPath: path.join(runDir, 'codesite-full-workflow-proof-summary.png'),
    browserShot: path.join(runDir, 'codesite-full-workflow-ui.png'),
    browserProofSectionShot: path.join(runDir, 'codesite-full-workflow-ui-proof-section.png'),
    browserCoordinationShot: path.join(runDir, 'codesite-full-workflow-ui-coordination.png'),
    browserLineInspectorShot: path.join(runDir, 'codesite-full-workflow-ui-line-inspector.png'),
    browserHandoverShot: path.join(runDir, 'codesite-full-workflow-ui-causal-replay-handover.png'),
    browserMobileShot: path.join(runDir, 'codesite-full-workflow-ui-causal-replay-mobile.png'),
  };
}

async function writeLegacyProofRunningMarker(dir, { slug, runDir, runStartedAt }) {
  const marker = {
    schemaVersion: 'synthi.codesite.fullWorkflowProofPublication.v1',
    status: 'running',
    slug,
    runStartedAt: runStartedAt.toISOString(),
    runDir: relativeProofPath(runDir),
    message: 'A fresh CodeSite full workflow proof is running; legacy top-level PASS artifacts are intentionally unavailable until validation completes.',
  };
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(path.join(dir, 'codesite-full-workflow-proof.json'), `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
  await fs.promises.writeFile(path.join(dir, 'codesite-full-workflow-proof.html'), [
    '<!doctype html>',
    '<html><head><meta charset="utf-8"><title>CodeSite proof running</title></head>',
    '<body><main>',
    '<h1>CodeSite full workflow proof running</h1>',
    `<pre>${escapeHtml(JSON.stringify(marker, null, 2))}</pre>`,
    '</main></body></html>',
  ].join('\n'), 'utf8');
  await Promise.all([
    'codesite-full-workflow-proof.png',
    'codesite-full-workflow-proof-summary.png',
    'codesite-full-workflow-ui.png',
    'codesite-full-workflow-ui-proof-section.png',
    'codesite-full-workflow-ui-coordination.png',
    'codesite-full-workflow-ui-line-inspector.png',
    'codesite-full-workflow-ui-causal-replay-handover.png',
    'codesite-full-workflow-ui-causal-replay-mobile.png',
  ].map((file) => fs.promises.rm(path.join(dir, file), { force: true })));
}

function bytesPerPixel({ bitDepth, colorType }) {
  if (bitDepth !== 8) return null;
  if (colorType === 0) return 1;
  if (colorType === 2) return 3;
  if (colorType === 4) return 2;
  if (colorType === 6) return 4;
  return null;
}

function paethPredictor(left, up, upperLeft) {
  const p = left + up - upperLeft;
  const pa = Math.abs(p - left);
  const pb = Math.abs(p - up);
  const pc = Math.abs(p - upperLeft);
  if (pa <= pb && pa <= pc) return left;
  if (pb <= pc) return up;
  return upperLeft;
}

function readPngChunks(buffer) {
  const signature = '89504e470d0a1a0a';
  if (buffer.subarray(0, 8).toString('hex') !== signature) {
    throw new Error('not_png');
  }
  const chunks = [];
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buffer.length) throw new Error(`png_chunk_truncated:${type}`);
    chunks.push({ type, data: buffer.subarray(dataStart, dataEnd) });
    offset = dataEnd + 4;
    if (type === 'IEND') break;
  }
  return chunks;
}

function analyzePngPixels(buffer) {
  const chunks = readPngChunks(buffer);
  const ihdr = chunks.find((chunk) => chunk.type === 'IHDR')?.data;
  if (!ihdr || ihdr.length < 13) throw new Error('png_missing_ihdr');
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const bitDepth = ihdr[8];
  const colorType = ihdr[9];
  const interlace = ihdr[12];
  const bpp = bytesPerPixel({ bitDepth, colorType });
  if (!width || !height) throw new Error('png_empty_dimensions');
  if (!bpp || interlace !== 0) {
    return {
      width,
      height,
      bitDepth,
      colorType,
      interlace,
      supportedPixelScan: false,
      nonblank: true,
      variedSampleCount: null,
      sampleCount: null,
    };
  }
  const idat = chunks.filter((chunk) => chunk.type === 'IDAT').map((chunk) => chunk.data);
  if (!idat.length) throw new Error('png_missing_idat');
  const inflated = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const previous = Buffer.alloc(stride);
  const current = Buffer.alloc(stride);
  let inputOffset = 0;
  let firstPixel = null;
  let sampleCount = 0;
  let variedSampleCount = 0;
  const sampleEvery = Math.max(1, Math.floor((width * height) / 20000));
  let pixelIndex = 0;

  for (let y = 0; y < height; y += 1) {
    const filter = inflated[inputOffset];
    inputOffset += 1;
    if (inputOffset + stride > inflated.length) throw new Error('png_scanline_truncated');
    for (let x = 0; x < stride; x += 1) {
      const raw = inflated[inputOffset + x];
      const left = x >= bpp ? current[x - bpp] : 0;
      const up = previous[x] || 0;
      const upperLeft = x >= bpp ? previous[x - bpp] || 0 : 0;
      if (filter === 0) current[x] = raw;
      else if (filter === 1) current[x] = (raw + left) & 0xff;
      else if (filter === 2) current[x] = (raw + up) & 0xff;
      else if (filter === 3) current[x] = (raw + Math.floor((left + up) / 2)) & 0xff;
      else if (filter === 4) current[x] = (raw + paethPredictor(left, up, upperLeft)) & 0xff;
      else throw new Error(`png_unknown_filter:${filter}`);
    }
    inputOffset += stride;
    for (let x = 0; x < width; x += 1) {
      if (pixelIndex % sampleEvery === 0) {
        const byteOffset = x * bpp;
        const pixel = current.subarray(byteOffset, byteOffset + bpp).toString('hex');
        if (firstPixel == null) firstPixel = pixel;
        else if (pixel !== firstPixel) variedSampleCount += 1;
        sampleCount += 1;
      }
      pixelIndex += 1;
    }
    current.copy(previous);
  }
  const variedEnough = variedSampleCount >= Math.max(12, Math.ceil(sampleCount * 0.002));
  return {
    width,
    height,
    bitDepth,
    colorType,
    interlace,
    supportedPixelScan: true,
    nonblank: variedEnough,
    variedSampleCount,
    sampleCount,
  };
}

async function describeArtifact(absolutePath, { runStartedAt, slug, visual = false } = {}) {
  const stat = await fs.promises.stat(absolutePath);
  const descriptor = {
    path: relativeProofPath(absolutePath),
    size: stat.size,
    mtime: stat.mtime.toISOString(),
    sha256: await fileSha256(absolutePath),
    freshForRun: stat.mtimeMs + 1000 >= runStartedAt.getTime(),
    slugScopedPath: !slug || relativeProofPath(absolutePath).includes(safeArtifactSegment(slug)),
  };
  if (visual) {
    const buffer = await fs.promises.readFile(absolutePath);
    descriptor.png = analyzePngPixels(buffer);
    descriptor.nonblank = descriptor.png.nonblank === true;
  }
  return descriptor;
}

async function validateProofArtifacts({ slug, runStartedAt, visualPaths, textPaths = [] }) {
  const visuals = [];
  for (const absolutePath of visualPaths) {
    visuals.push(await describeArtifact(absolutePath, { runStartedAt, slug, visual: true }));
  }
  const textArtifacts = [];
  for (const absolutePath of textPaths) {
    if (absolutePath && fs.existsSync(absolutePath)) {
      textArtifacts.push(await describeArtifact(absolutePath, { runStartedAt, slug, visual: false }));
    }
  }
  const invalidVisuals = visuals.filter((artifact) => (
    !artifact.freshForRun
    || !artifact.slugScopedPath
    || !artifact.nonblank
    || artifact.size <= 0
    || !artifact.png?.width
    || !artifact.png?.height
  ));
  const invalidText = textArtifacts.filter((artifact) => (
    !artifact.freshForRun
    || !artifact.slugScopedPath
    || artifact.size <= 0
  ));
  return {
    ok: invalidVisuals.length === 0 && invalidText.length === 0,
    runStartedAt: runStartedAt.toISOString(),
    visualArtifacts: visuals,
    textArtifacts,
    invalidArtifacts: [...invalidVisuals, ...invalidText].map((artifact) => artifact.path),
  };
}

function isTextProofArtifact(filePath) {
  return /\.(json|jsonl|txt|md|html|log|schema)$/i.test(filePath);
}

async function listFilesRecursive(rootPath) {
  if (!rootPath || !fs.existsSync(rootPath)) return [];
  const stat = await fs.promises.stat(rootPath);
  if (stat.isFile()) return [rootPath];
  if (!stat.isDirectory()) return [];
  const entries = await fs.promises.readdir(rootPath, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = path.join(rootPath, entry.name);
    if (entry.isDirectory()) files.push(...await listFilesRecursive(child));
    else if (entry.isFile()) files.push(child);
  }
  return files;
}

async function scanProofArtifactsForSecrets(roots) {
  const patterns = proofSecretPatterns();
  const files = (await Promise.all(asArray(roots).map(listFilesRecursive))).flat()
    .filter((filePath) => isTextProofArtifact(filePath));
  const findings = [];
  for (const filePath of files) {
    const stat = await fs.promises.stat(filePath);
    if (stat.size > 32 * 1024 * 1024) {
      findings.push({ path: relativeProofPath(filePath), pattern: 'unscanned_large_text_artifact', bytes: stat.size });
      continue;
    }
    const text = await fs.promises.readFile(filePath, 'utf8');
    for (const { name, pattern } of patterns) {
      pattern.lastIndex = 0;
      if (pattern.test(text)) {
        findings.push({ path: relativeProofPath(filePath), pattern: name });
      }
    }
  }
  return {
    ok: findings.length === 0,
    scannedFileCount: files.length,
    scannedRoots: asArray(roots).filter(Boolean).map(relativeProofPath),
    findings,
  };
}

async function copyValidatedArtifact(sourcePath, targetPath) {
  await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
  const tempPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  await fs.promises.copyFile(sourcePath, tempPath);
  await fs.promises.rename(tempPath, targetPath);
}

async function publishValidatedProofRun({ dir, slug, runPaths, proof, latestSchemaPath }) {
  const copies = [
    [runPaths.jsonPath, path.join(dir, 'codesite-full-workflow-proof.json')],
    ...(fs.existsSync(runPaths.publicationPath)
      ? [[runPaths.publicationPath, path.join(dir, 'codesite-full-workflow-publication.json')]]
      : []),
    [runPaths.htmlPath, path.join(dir, 'codesite-full-workflow-proof.html')],
    [runPaths.pngPath, path.join(dir, 'codesite-full-workflow-proof.png')],
    [runPaths.summaryPngPath, path.join(dir, 'codesite-full-workflow-proof-summary.png')],
    [runPaths.browserShot, path.join(dir, 'codesite-full-workflow-ui.png')],
    [runPaths.browserProofSectionShot, path.join(dir, 'codesite-full-workflow-ui-proof-section.png')],
    [runPaths.browserCoordinationShot, path.join(dir, 'codesite-full-workflow-ui-coordination.png')],
    [runPaths.browserLineInspectorShot, path.join(dir, 'codesite-full-workflow-ui-line-inspector.png')],
    [runPaths.browserHandoverShot, path.join(dir, 'codesite-full-workflow-ui-causal-replay-handover.png')],
    [runPaths.browserMobileShot, path.join(dir, 'codesite-full-workflow-ui-causal-replay-mobile.png')],
  ];
  for (const attestation of proof.runtimeAttestations || []) {
    copies.push([
      path.join(repoRoot(), attestation.path),
      path.join(dir, path.basename(attestation.path)),
    ]);
  }
  if (latestSchemaPath && fs.existsSync(latestSchemaPath)) {
    copies.push([latestSchemaPath, path.join(dir, 'codex-agent-output.schema.json')]);
  }
  for (const [sourcePath, targetPath] of copies) {
    await copyValidatedArtifact(sourcePath, targetPath);
  }
  const latest = {
    schemaVersion: 'synthi.codesite.fullWorkflowProofLatest.v1',
    status: 'validated',
    slug,
    publishedAt: new Date().toISOString(),
    runDir: relativeProofPath(runPaths.runDir),
    proof: relativeProofPath(runPaths.jsonPath),
    proofSha256: await fileSha256(runPaths.jsonPath),
    ...(fs.existsSync(runPaths.publicationPath)
      ? {
        publication: relativeProofPath(runPaths.publicationPath),
        publicationSha256: await fileSha256(runPaths.publicationPath),
      }
      : {}),
    html: relativeProofPath(runPaths.htmlPath),
    screenshot: relativeProofPath(runPaths.pngPath),
    summaryScreenshot: relativeProofPath(runPaths.summaryPngPath),
    browserScreenshots: [
      runPaths.browserShot,
      runPaths.browserProofSectionShot,
      runPaths.browserCoordinationShot,
      runPaths.browserLineInspectorShot,
      runPaths.browserHandoverShot,
      runPaths.browserMobileShot,
    ].map(relativeProofPath),
  };
  await fs.promises.writeFile(path.join(dir, 'codesite-full-workflow-latest.json'), `${JSON.stringify(latest, null, 2)}\n`, 'utf8');
  return latest;
}

async function currentGitHead() {
  try {
    const result = await run('git', ['rev-parse', 'HEAD'], { cwd: repoRoot() });
    return result.stdout.trim();
  } catch {
    return null;
  }
}

function normalizeProviderSessionRef(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  return /^codex[-_:]/i.test(text) ? text : `codex-session:${text}`;
}

function codexProviderSessionRefs() {
  const explicit = String(process.env.CODESITE_PROOF_CODEX_PROVIDER_SESSION_REFS || '')
    .split(',')
    .map(normalizeProviderSessionRef)
    .filter(Boolean);
  const currentThread = normalizeProviderSessionRef(process.env.CODESITE_PROOF_CODEX_THREAD_ID || process.env.CODEX_THREAD_ID);
  return unique([
    ...explicit,
    currentThread,
  ].filter(Boolean));
}

async function run(command, args, options = {}) {
  const result = await execFileAsync(command, args, {
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
    ...options,
  });
  return {
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
  };
}

async function optionalCommandEvidence(command, args) {
  try {
    const result = await run(command, args);
    return {
      ok: true,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
    };
  } catch (error) {
    return {
      ok: false,
      stdout: String(error?.stdout || '').trim(),
      stderr: String(error?.stderr || error?.message || '').trim(),
    };
  }
}

function runWithClosedStdin(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const timeoutMs = Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) > 0
      ? Number(options.timeoutMs)
      : null;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const maxBuffer = options.maxBuffer || 8 * 1024 * 1024;
    let settled = false;
    const timer = timeoutMs
      ? setTimeout(() => {
        if (settled) return;
        child.kill('SIGTERM');
      }, timeoutMs)
      : null;
    child.stdin.end();
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      if (stdout.length > maxBuffer) stdout = stdout.slice(-maxBuffer);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > maxBuffer) stderr = stderr.slice(-maxBuffer);
    });
    child.on('error', (error) => {
      settled = true;
      if (timer) clearTimeout(timer);
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
    child.on('close', (exitCode, signal) => {
      settled = true;
      if (timer) clearTimeout(timer);
      if (exitCode === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const stdoutTail = stdout.slice(-4000);
      const stderrTail = stderr.slice(-4000);
      const error = new Error([
        `${command} exited with ${exitCode ?? signal}`,
        timeoutMs && signal === 'SIGTERM' ? `command exceeded timeout ${timeoutMs}ms` : null,
        stderrTail ? `stderr tail:\n${stderrTail}` : null,
        stdoutTail ? `stdout tail:\n${stdoutTail}` : null,
      ].filter(Boolean).join('\n'));
      error.stdout = stdout;
      error.stderr = stderr;
      error.exitCode = exitCode;
      error.signal = signal;
      reject(error);
    });
  });
}

async function collectCodexRuntimeEvidence() {
  const [whichCodex, codexVersion] = await Promise.all([
    optionalCommandEvidence('which', ['codex']),
    optionalCommandEvidence('codex', ['--version']),
  ]);
  const providerSessionRefs = codexProviderSessionRefs();
  return {
    provider: 'codex',
    runtime: 'tmp-codex-cli',
    providerSessionRefs,
    primaryProviderSessionRef: providerSessionRefs[0] || null,
    threadId: process.env.CODESITE_PROOF_CODEX_THREAD_ID || process.env.CODEX_THREAD_ID || null,
    command: 'codex',
    cliPath: whichCodex.ok ? whichCodex.stdout : null,
    cliVersion: codexVersion.ok ? codexVersion.stdout : null,
    cliEvidenceOk: whichCodex.ok && codexVersion.ok,
    originator: process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE || null,
    ci: process.env.CODEX_CI || null,
  };
}

function agentExecutionEvidenceDir(dir, slug) {
  return path.resolve(process.env.CODESITE_PROOF_AGENT_EXECUTION_EVIDENCE_DIR || path.join(dir, 'codex-agent-evidence', slug));
}

async function loadAgentExecutionEvidence({ dir, slug, agentFlightSpecs }) {
  const evidenceDir = agentExecutionEvidenceDir(dir, slug);
  const files = fs.existsSync(evidenceDir)
    ? (await fs.promises.readdir(evidenceDir)).filter((file) => file.endsWith('.json') && file !== 'codex-agent-output.schema.json').sort()
    : [];
  const records = [];
  for (const file of files) {
    const absolutePath = path.join(evidenceDir, file);
    const raw = await fs.promises.readFile(absolutePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed.schemaVersion !== 'synthi.codesite.codexAgentExecutionEvidence.v1') {
      continue;
    }
    const commands = asArray(parsed.commands || parsed.commandEvidence);
    const workflowActions = asArray(parsed.workflowActions || parsed.actions);
    const transcriptBinding = await verifiedCodexTranscriptBinding(parsed).catch((error) => ({
      ok: false,
      errors: [`transcript_binding_error:${error?.message || String(error)}`],
    }));
    const actorProjectionBinding = await verifiedActorProjectionBinding(parsed, workflowActions).catch((error) => ({
      ok: false,
      errors: [`actor_projection_binding_error:${error?.message || String(error)}`],
    }));
    const evidenceDigest = digest({
      schemaVersion: parsed.schemaVersion,
      callsign: parsed.callsign,
      providerSessionRef: parsed.providerSessionRef,
      workspaceSlug: parsed.workspaceSlug,
      role: parsed.role,
      commands: commands.map((command) => ({
        command: command.command,
        executable: command.executable,
        args: command.args,
        exitCode: command.exitCode,
        status: command.status,
        source: command.source,
        transcriptEventId: command.transcriptEventId,
        outputDigest: command.outputDigest,
        evidenceDigest: command.evidenceDigest,
      })),
      workflowActions,
      transcriptDigest: parsed.transcriptDigest || parsed.finalMessageDigest || parsed.transcript?.digest || null,
      stdoutDigest: parsed.stdoutDigest || parsed.transcript?.stdoutDigest || null,
      stderrDigest: parsed.stderrDigest || parsed.transcript?.stderrDigest || null,
      transcriptBinding: transcriptBinding.ok
        ? {
          eventsRawSha256: transcriptBinding.eventsRawSha256,
          stderrSha256: transcriptBinding.stderrSha256,
          finalMessageSha256: transcriptBinding.finalMessageSha256,
        }
        : transcriptBinding.errors,
      actorProjectionBinding: actorProjectionBinding.ok
        ? {
          controlStateSha256: actorProjectionBinding.controlStateSha256,
          actionScriptSha256: actorProjectionBinding.actionScriptSha256,
          receiptSha256: actorProjectionBinding.receiptSha256,
        }
        : actorProjectionBinding.errors,
    });
    records.push({
      ...parsed,
      commands,
      workflowActions,
      transcriptBinding,
      actorProjectionBinding,
      path: path.relative(repoRoot(), absolutePath).split(path.sep).join('/'),
      evidenceDigest,
      validForProof: false,
      validationErrors: [],
    });
  }

  const specsByCallsign = new Map(agentFlightSpecs.map((spec) => [spec.callsign, spec]));
  for (const record of records) {
    const errors = [];
    const spec = specsByCallsign.get(record.callsign);
    if (!spec) errors.push('unknown_callsign');
    if (record.schemaVersion !== 'synthi.codesite.codexAgentExecutionEvidence.v1') errors.push('schema_version_mismatch');
    if (record.workspaceSlug !== slug) errors.push('workspace_slug_mismatch');
    if (spec && record.providerSessionRef !== spec.providerSessionRef) errors.push('provider_session_ref_mismatch');
    if (!String(record.providerSessionRef || '').startsWith('codex-')) errors.push('provider_session_ref_not_codex');
    if (!record.commands.length) errors.push('commands_missing');
    if (record.commands.some((command) => command.source !== 'codex_jsonl_command_execution' || !command.transcriptEventId)) {
      errors.push('commands_not_transcript_derived');
    }
    const successfulCommands = record.commands.filter((command) => (
      command.source === 'codex_jsonl_command_execution'
      && Number(command.exitCode) === 0
      && command.status === 'completed'
      && command.transcriptEventId
    ));
    if (successfulCommands.length !== record.commands.length) {
      errors.push('transcript_command_failed');
    }
    if (!successfulCommands.length) {
      errors.push('no_transcript_successful_command');
    }
    const transcriptCommands = record.commands.map((command) => normalizeCommandText(command.command));
    const reportedCommands = asArray(record.reportedCommands).map(normalizeCommandText).filter(Boolean);
    const unbackedReportedCommands = reportedCommands.filter((reported) => !reportedCommandBackedByTranscript(reported, transcriptCommands));
    if (reportedCommands.length && unbackedReportedCommands.length) errors.push('reported_commands_not_transcript_backed');
    if (spec?.domain === 'backend' && successfulCommands.length < 2) errors.push('backend_two_successful_transcript_commands_missing');
    for (const requirement of roleCommandRequirements(spec?.domain || record.role)) {
      if (!successfulCommands.some((command) => requirement.pattern.test(normalizeCommandText(command.command)))) {
        errors.push(`required_command_missing:${requirement.key}`);
      }
    }
    if (!record.workflowActions.length) errors.push('workflow_actions_missing');
    const requiredWorkflowActions = roleWorkflowActionRequirements(spec?.domain || record.role);
    const missingWorkflowActions = requiredWorkflowActions.filter((kind) => !record.workflowActions.some((action) => action?.kind === kind));
    if (missingWorkflowActions.length) errors.push(`required_workflow_actions_missing:${missingWorkflowActions.join(',')}`);
    const unbackedWorkflowActions = record.workflowActions.filter((action) => !workflowActionBackedByTranscript(action, transcriptCommands));
    if (unbackedWorkflowActions.length) {
      errors.push(`workflow_actions_not_transcript_backed:${unbackedWorkflowActions.map((action) => action?.kind || action?.action || 'unknown').join(',')}`);
    }
    if (!record.workflowActions.every((action) => action?.source === 'codesite_repo_local_projection_actor')) {
      errors.push('workflow_actions_not_actor_projection_receipts');
    }
    if (!record.actorProjectionBinding?.ok) {
      errors.push(...asArray(record.actorProjectionBinding?.errors).map((error) => `actor_projection_binding_${error}`));
    }
    if (!(record.transcriptDigest || record.finalMessageDigest || record.transcript?.digest)) errors.push('transcript_digest_missing');
    if (!(record.stdoutDigest || record.transcript?.stdoutDigest)) errors.push('stdout_digest_missing');
    if (!(record.stderrDigest || record.transcript?.stderrDigest)) errors.push('stderr_digest_missing');
    if (!(record.codexExecThreadId || record.transcript?.threadId)) errors.push('codex_exec_thread_missing');
    if (Number(record.transcript?.toolEventCount || 0) < 1) errors.push('codex_exec_tool_event_missing');
    if (!record.transcriptBinding?.ok) {
      errors.push(...asArray(record.transcriptBinding?.errors).map((error) => `transcript_binding_${error}`));
    }
    record.validForProof = errors.length === 0;
    record.validationErrors = errors;
  }

  const recordsByCallsign = new Map(records.map((record) => [record.callsign, record]));
  const missingCallsigns = agentFlightSpecs
    .map((spec) => spec.callsign)
    .filter((callsign) => !recordsByCallsign.get(callsign)?.validForProof);
  return {
    evidenceDir: path.relative(repoRoot(), evidenceDir).split(path.sep).join('/'),
    records,
    recordsByCallsign,
    missingCallsigns,
  };
}

async function verifiedCodexTranscriptBinding(record = {}) {
  const transcript = record.transcript || {};
  const eventsRawPath = transcript.eventsRawPath;
  const stderrPath = transcript.stderrPath;
  const finalMessagePath = transcript.finalMessagePath;
  const errors = [];
  const eventsRawAbsolute = resolveRepoRelativeProofFile(eventsRawPath, 'eventsRawPath', errors);
  const stderrAbsolute = resolveRepoRelativeProofFile(stderrPath, 'stderrPath', errors);
  const finalMessageAbsolute = resolveRepoRelativeProofFile(finalMessagePath, 'finalMessagePath', errors);
  const eventsRaw = eventsRawAbsolute ? await fs.promises.readFile(eventsRawAbsolute, 'utf8').catch(() => null) : null;
  const stderr = stderrAbsolute ? await fs.promises.readFile(stderrAbsolute, 'utf8').catch(() => null) : null;
  const finalMessage = finalMessageAbsolute ? await fs.promises.readFile(finalMessageAbsolute, 'utf8').catch(() => null) : null;
  if (eventsRaw == null) errors.push('events_raw_unreadable');
  if (stderr == null) errors.push('stderr_unreadable');
  if (finalMessage == null) errors.push('final_message_unreadable');

  const computedTranscriptDigest = eventsRaw == null ? null : digest(eventsRaw);
  const computedStdoutDigest = eventsRaw == null ? null : digest(eventsRaw);
  const computedStderrDigest = stderr == null ? null : digest(stderr);
  const computedFinalMessageDigest = finalMessage == null ? null : digest(finalMessage);
  const eventsRawSha256 = eventsRawAbsolute && eventsRaw != null ? await fileSha256(eventsRawAbsolute) : null;
  const stderrSha256 = stderrAbsolute && stderr != null ? await fileSha256(stderrAbsolute) : null;
  const finalMessageSha256 = finalMessageAbsolute && finalMessage != null ? await fileSha256(finalMessageAbsolute) : null;

  compareDigest(errors, 'transcriptDigest', record.transcriptDigest || transcript.digest, computedTranscriptDigest);
  compareDigest(errors, 'stdoutDigest', record.stdoutDigest || transcript.stdoutDigest, computedStdoutDigest);
  compareDigest(errors, 'stderrDigest', record.stderrDigest || transcript.stderrDigest, computedStderrDigest);
  compareDigest(errors, 'finalMessageDigest', record.finalMessageDigest || transcript.finalMessageDigest, computedFinalMessageDigest);
  compareDigest(errors, 'eventsRawSha256', transcript.eventsRawSha256, eventsRawSha256);
  compareDigest(errors, 'stderrSha256', transcript.stderrSha256, stderrSha256);
  compareDigest(errors, 'finalMessageSha256', transcript.finalMessageSha256, finalMessageSha256);

  return {
    ok: errors.length === 0,
    errors,
    eventsRawPath,
    stderrPath,
    finalMessagePath,
    transcriptDigest: computedTranscriptDigest,
    stdoutDigest: computedStdoutDigest,
    stderrDigest: computedStderrDigest,
    finalMessageDigest: computedFinalMessageDigest,
    eventsRawSha256,
    stderrSha256,
    finalMessageSha256,
  };
}

async function verifiedActorProjectionBinding(record = {}, workflowActions = []) {
  const actorProjection = record.actorProjection || {};
  const errors = [];
  const controlStateAbsolute = resolveRepoRelativeProofFile(actorProjection.controlStatePath, 'actorProjection.controlStatePath', errors);
  const actionScriptAbsolute = resolveRepoRelativeProofFile(actorProjection.actionScriptPath, 'actorProjection.actionScriptPath', errors);
  const receiptAbsolute = resolveRepoRelativeProofFile(actorProjection.receiptPath, 'actorProjection.receiptPath', errors);
  const controlState = controlStateAbsolute ? await fs.promises.readFile(controlStateAbsolute, 'utf8').catch(() => null) : null;
  const actionScript = actionScriptAbsolute ? await fs.promises.readFile(actionScriptAbsolute, 'utf8').catch(() => null) : null;
  const receiptText = receiptAbsolute ? await fs.promises.readFile(receiptAbsolute, 'utf8').catch(() => null) : null;
  if (controlState == null) errors.push('control_state_unreadable');
  if (actionScript == null) errors.push('action_script_unreadable');
  if (receiptText == null) errors.push('receipt_unreadable');

  const controlStateSha256 = controlStateAbsolute && controlState != null ? await fileSha256(controlStateAbsolute) : null;
  const actionScriptSha256 = actionScriptAbsolute && actionScript != null ? await fileSha256(actionScriptAbsolute) : null;
  const receiptSha256 = receiptAbsolute && receiptText != null ? await fileSha256(receiptAbsolute) : null;
  compareDigest(errors, 'actorProjection.controlStateSha256', actorProjection.controlStateSha256, controlStateSha256);
  compareDigest(errors, 'actorProjection.actionScriptSha256', actorProjection.actionScriptSha256, actionScriptSha256);
  compareDigest(errors, 'actorProjection.receiptSha256', actorProjection.receiptSha256, receiptSha256);

  const receiptActions = receiptText == null ? [] : parseJsonl(receiptText);
  if (receiptText != null && receiptActions.length === 0) errors.push('receipt_actions_missing');
  if (receiptActions.length !== workflowActions.length) errors.push('receipt_action_count_mismatch');
  const receiptDigests = new Set(receiptActions.map((action) => action.receiptDigest).filter(Boolean));
  const missingReceiptDigests = workflowActions
    .map((action) => action.receiptDigest)
    .filter((receiptDigest) => !receiptDigest || !receiptDigests.has(receiptDigest));
  if (missingReceiptDigests.length) errors.push('workflow_action_receipt_digest_mismatch');
  if (!receiptActions.every((action) => action.callsign === record.callsign && action.workspaceSlug === record.workspaceSlug)) {
    errors.push('receipt_action_scope_mismatch');
  }

  return {
    ok: errors.length === 0,
    errors,
    controlStateSha256,
    actionScriptSha256,
    receiptSha256,
  };
}

function resolveRepoRelativeProofFile(relativePath, label, errors) {
  if (!relativePath) {
    errors.push(`${label}_missing`);
    return null;
  }
  const root = repoRoot();
  const absolute = path.resolve(root, relativePath);
  const rel = path.relative(root, absolute);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    errors.push(`${label}_path_escape`);
    return null;
  }
  return absolute;
}

function parseJsonl(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function compareDigest(errors, label, observed, expected, options = {}) {
  if (!observed && options.optional) return;
  if (!observed || !expected) {
    errors.push(`${label}_missing`);
    return;
  }
  if (observed !== expected) {
    errors.push(`${label}_mismatch`);
  }
}

function codexAgentOutputSchema() {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    additionalProperties: false,
    required: ['callsign', 'providerSessionRef', 'role', 'inspectedPaths', 'commandsRun', 'workflowActions', 'workflowFinding', 'risk'],
    properties: {
      callsign: { type: 'string' },
      providerSessionRef: { type: 'string' },
      role: { type: 'string', enum: ['schema', 'backend', 'inspection'] },
      inspectedPaths: { type: 'array', minItems: 1, items: { type: 'string' } },
      commandsRun: { type: 'array', minItems: 1, items: { type: 'string' } },
      workflowActions: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'action'],
          properties: {
            kind: { type: 'string' },
            action: { type: 'string' },
          },
        },
      },
      workflowFinding: { type: 'string' },
      risk: { type: 'string', enum: ['none', 'low', 'medium', 'high'] },
    },
  };
}

function codexAgentPrompt({ spec, registration, slug, projectId, proofRepo, actorCommands, actorProjection }) {
  const hostRepoRoot = repoRoot();
  const repoPath = (absolutePath) => path.relative(hostRepoRoot, absolutePath).split(path.sep).join('/');
  const planPath = 'docs/CODESITE_CONSTRUCTION_COORDINATION_PLAN.md';
  const proofScriptPath = 'synthi/scripts/codesite-full-workflow-proof.mjs';
  const proofRepoPath = repoPath(proofRepo.hostRoot);
  const proofRepoPackagePath = `${proofRepoPath}/package.json`;
  const proofRepoSchemaPath = `${proofRepoPath}/synthi/prisma/schema.prisma`;
  const proofRepoTypecheckPath = `${proofRepoPath}/scripts/typecheck-schema.mjs`;
  const proofRepoContractTestPath = `${proofRepoPath}/scripts/test-schema-contract.mjs`;
  const projectionPath = repoPath(actorProjection.controlStatePath);
  const actionScriptPath = repoPath(actorProjection.actionScriptPath);
  const actionContract = actorProjection.actionContracts[spec.callsign] || [];
  const expectedRefsText = [
    'Expected CodeSite providerSessionRefs for this proof:',
    ...agentFlightSpecsForPrompt(spec).map((entry) => `- ${entry.callsign}: ${entry.providerSessionRef}`),
  ].join('\n');
  const roleChecks = {
    schema: [
      `Read the CodeSite projection at ${projectionPath}; it contains your registered agent session, execution plan, clearance, transaction, assumption, and write proposal contract.`,
      `Use ${actionScriptPath} to emit actor receipts for control-state read, execution-plan filing, mutation lease, transaction open, assumption, controlled-write proposal, inspection request, and commit request.`,
      `Run cd ${proofRepoPath} && npm run typecheck after the action receipts and report that command in commandsRun.`,
      `You may inspect ${proofRepoSchemaPath}, ${proofRepoPackagePath}, ${planPath}, or ${proofScriptPath} only as supporting context.`,
    ],
    backend: [
      `Read the CodeSite projection at ${projectionPath}; it contains your held dependent API flight, RFI inbox item, change-order response, stale assumption, and aborted API transaction.`,
      `Use ${actionScriptPath} to emit actor receipts for control-state read, execution-plan filing, inbox read, inbox acknowledgement, change-order filing, and stale transaction abort.`,
      'Confirm API-02 has a distinct providerSessionRef from SCHEMA-01 and TEST-03 from the projection already read and the listed dependency check; do not run an extra provider-session command.',
      `You may inspect ${planPath}, ${proofScriptPath}, and ${projectionPath} only as supporting context.`,
    ],
    inspection: [
      `Read the CodeSite projection at ${projectionPath}; it contains the landing radar inspection, metrics summary, proof bundle inputs, black-box replay refs, and causal line-inspector evidence.`,
      `Use ${actionScriptPath} to emit actor receipts for control-state read, execution-plan filing, landing request, and metrics read.`,
      `Run cd ${proofRepoPath} && npm test after the action receipts and report that command in commandsRun.`,
      `You may inspect ${proofRepoPackagePath}, ${proofRepoTypecheckPath}, ${proofRepoContractTestPath}, ${planPath}, or ${proofScriptPath} only as supporting context.`,
    ],
  };
  return [
    `You are CodeSite ${spec.callsign}, a real Codex actor session for workspace ${slug}.`,
    `Provider session ref: ${spec.providerSessionRef}.`,
    `Registered CodeSite agent session id: ${registration?.agentSession?.id || 'unknown'}.`,
    `Execution plan id: ${registration?.executionPlan?.id || 'unknown'}.`,
    `Project id: ${projectId}.`,
    expectedRefsText,
    '',
    'You must execute shell commands; do not answer from memory or from this prompt alone.',
    `Use exact repo-relative paths from this prompt. The working directory is ${hostRepoRoot}.`,
    'Do not substitute /workspace paths; this Codex proof session runs on the host with the repo as its working directory.',
    'Do not run broad find commands over the repo root, node_modules, .git, or tmp trees.',
    'Prefer bounded commands such as pwd, sed -n, rg -n on an exact file, ls on an exact directory, and npm scripts in the proof repo.',
    'Only run commands that should exit 0; the workflow proof rejects failed command_execution transcript entries.',
    'The commandsRun array must list only successful commands that appear in the Codex command_execution transcript.',
    `You may write only through ${actionScriptPath}; it appends CodeSite actor receipts under the generated proof repo outbox.`,
    'Do not edit application source, stage, commit, or write anywhere outside that generated proof repo outbox.',
    'Perform these role-specific checks:',
    ...(roleChecks[spec.domain] || roleChecks.inspection).map((check) => `- ${check}`),
    '',
    'Run only these exact actor commands in order. Do not run any additional command after the last listed command:',
    ...actorCommands.map((command) => `- ${command}`),
    '',
    'Your workflowActions array must summarize the action receipts created by the commands above. Use these required action contracts:',
    ...actionContract.map((entry) => `- ${entry.kind} via ${entry.action}`),
    '',
    `Return only JSON matching the provided schema immediately after the last listed command. The role field must be "${spec.domain}". The callsign and providerSessionRef fields must exactly match the values above.`,
  ].join('\n');
}

function agentFlightSpecsForPrompt(currentSpec) {
  return [
    { callsign: 'SCHEMA-01', providerSessionRef: process.env.CODESITE_PROOF_CODEX_PROVIDER_SESSION_REFS?.split(',')?.[0] || currentSpec.providerSessionRef },
    { callsign: 'API-02', providerSessionRef: process.env.CODESITE_PROOF_CODEX_PROVIDER_SESSION_REFS?.split(',')?.[1] || currentSpec.providerSessionRef },
    { callsign: 'TEST-03', providerSessionRef: process.env.CODESITE_PROOF_CODEX_PROVIDER_SESSION_REFS?.split(',')?.[2] || currentSpec.providerSessionRef },
  ].map((entry) => ({
    ...entry,
    providerSessionRef: normalizeProviderSessionRef(entry.providerSessionRef),
  }));
}

function proofProjectRedactionPolicy() {
  return {
    acceptsTowerMessages: true,
    redactSecrets: true,
    redactPrivatePrompts: true,
    allowAttachments: false,
    visibleZones: ['**'],
    allowedDocumentKinds: [
      'rfi',
      'change_order',
      'inspection_request',
      'inspection_result',
      'mayday',
      'handoff',
      'stop_work',
      'punch',
      'tower_instruction',
    ],
  };
}

function codexActorActionScriptSource() {
  return `#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function parseArgs(argv) {
  const options = {};
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg.startsWith('--')) {
      options[arg.slice(2)] = argv[++index];
    } else {
      positionals.push(arg);
    }
  }
  return {
    projectId: options.project,
    callsign: options.callsign,
    action: options.action || positionals[0],
  };
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key])]));
}

function digest(value) {
  return 'sha256:' + crypto.createHash('sha256').update(JSON.stringify(sortJson(value))).digest('hex');
}

function fileSha256(filePath) {
  return 'sha256:' + crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function fail(message) {
  console.error(message);
  process.exit(2);
}

const { projectId, callsign, action } = parseArgs(process.argv.slice(2));
if (!projectId) fail('--project is required');
if (!callsign) fail('--callsign is required');
if (!action) fail('action is required');

const scriptPath = fileURLToPath(import.meta.url);
const proofRepoRoot = path.resolve(path.dirname(scriptPath), '..');
const projectRoot = path.join(proofRepoRoot, '.synthi', 'codesite', 'projects', projectId);
const controlStatePath = path.join(projectRoot, 'control-state.json');
if (!fs.existsSync(controlStatePath)) fail('control-state.json is missing');
const state = JSON.parse(fs.readFileSync(controlStatePath, 'utf8'));
const agent = state.agents.find((entry) => entry.callsign === callsign);
if (!agent) fail('unknown callsign ' + callsign);
const contract = (state.actionContracts[callsign] || []).find((entry) => entry.action === action);
if (!contract) fail('action ' + action + ' is not allowed for ' + callsign);

const outboxDir = path.join(projectRoot, 'outbox', callsign);
fs.mkdirSync(outboxDir, { recursive: true });
const projectionControlStateSha256 = fileSha256(controlStatePath);
const actionScriptSha256 = fileSha256(scriptPath);
const receipt = {
  schemaVersion: 'synthi.codesite.agentActionReceipt.v1',
  source: 'codesite_repo_local_projection_actor',
  workspaceSlug: state.workspaceSlug,
  projectId,
  callsign,
  role: agent.role,
  providerSessionRef: agent.providerSessionRef,
  agentSessionId: agent.agentSessionId,
  executionPlanId: agent.executionPlanId,
  action: contract.action,
  kind: contract.kind,
  tool: contract.tool,
  surface: 'repo-local-json-projection',
  references: contract.references || {},
  expectedAssertions: contract.expectedAssertions || [],
  projectionControlStateSha256,
  actionScriptSha256,
  emittedAt: new Date().toISOString(),
  outputArtifacts: [],
};

if (contract.kind === 'controlled_write_proposed') {
  const proposalDir = path.join(outboxDir, 'patch-proposals');
  fs.mkdirSync(proposalDir, { recursive: true });
  const proposal = {
    schemaVersion: 'synthi.codesite.controlledPatchProposal.v1',
    source: 'codesite_repo_local_projection_actor',
    workspaceSlug: state.workspaceSlug,
    projectId,
    callsign,
    transactionId: state.mutation.transactionId,
    mutationLeaseId: state.mutation.mutationLeaseId,
    path: state.patch.path,
    contentSha256: state.patch.afterSha256,
    reasonRef: state.patch.reasonRef,
    evidenceRefs: state.patch.evidenceRefs,
    generatedAt: new Date().toISOString(),
  };
  proposal.proposalDigest = digest(proposal);
  const proposalPath = path.join(proposalDir, proposal.proposalDigest.replace(/^sha256:/, '') + '.json');
  fs.writeFileSync(proposalPath, JSON.stringify(proposal, null, 2) + '\\n', 'utf8');
  receipt.outputArtifacts.push({
    kind: 'controlled_patch_proposal',
    path: path.relative(proofRepoRoot, proposalPath).split(path.sep).join('/'),
    sha256: fileSha256(proposalPath),
    proposalDigest: proposal.proposalDigest,
  });
}

receipt.receiptDigest = digest({
  schemaVersion: receipt.schemaVersion,
  source: receipt.source,
  workspaceSlug: receipt.workspaceSlug,
  projectId: receipt.projectId,
  callsign: receipt.callsign,
  role: receipt.role,
  providerSessionRef: receipt.providerSessionRef,
  agentSessionId: receipt.agentSessionId,
  executionPlanId: receipt.executionPlanId,
  action: receipt.action,
  kind: receipt.kind,
  tool: receipt.tool,
  references: receipt.references,
  outputArtifacts: receipt.outputArtifacts,
  projectionControlStateSha256,
  actionScriptSha256,
});

const receiptPath = path.join(outboxDir, 'actions.jsonl');
fs.appendFileSync(receiptPath, JSON.stringify(receipt) + '\\n', 'utf8');
console.log(JSON.stringify({
  ok: true,
  callsign,
  action,
  kind: receipt.kind,
  receiptDigest: receipt.receiptDigest,
  references: receipt.references,
}));
`;
}

function sha256Text(text) {
  return `sha256:${crypto.createHash('sha256').update(String(text)).digest('hex')}`;
}

function buildCodexActorActionContracts({ agentRegistrations, workflowContext }) {
  const ids = {
    projectId: workflowContext.project.id,
    mutationLeaseId: workflowContext.lease.id,
    transactionId: workflowContext.transaction.id,
    schemaAssumptionId: workflowContext.schemaAssumption.id,
    staleAssumptionId: workflowContext.staleAssumption.id,
    apiTransactionId: workflowContext.apiTransaction.id,
    apiAbortTransactionId: workflowContext.apiAbort.id,
    rfiDocumentId: workflowContext.rfiDocument.id,
    rfiInboxEventId: workflowContext.rfiInboxItem.eventId,
    rfiAckInboxItemId: workflowContext.rfiAck.id,
    changeOrderDocumentId: workflowContext.changeOrderDocument.id,
    inspectionRunId: workflowContext.inspectionRun.id,
  };
  const byCallsign = new Map(agentRegistrations.map((entry) => [entry.spec.callsign, entry]));
  const baseRefs = (callsign) => ({
    projectId: ids.projectId,
    agentSessionId: byCallsign.get(callsign)?.agentSession?.id || null,
    executionPlanId: byCallsign.get(callsign)?.executionPlan?.id || null,
  });
  return {
    'SCHEMA-01': [
      { action: 'read-control-state', kind: 'control_state_read', tool: 'synthi_codesite_get_radar', references: baseRefs('SCHEMA-01') },
      { action: 'file-execution-plan', kind: 'execution_plan_filed', tool: 'synthi_codesite_file_flight_plan', references: baseRefs('SCHEMA-01') },
      { action: 'request-mutation-lease', kind: 'mutation_lease_requested', tool: 'synthi_codesite_request_clearance', references: { ...baseRefs('SCHEMA-01'), mutationLeaseId: ids.mutationLeaseId } },
      { action: 'open-mutation-transaction', kind: 'mutation_transaction_opened', tool: 'synthi_codesite_open_transaction', references: { ...baseRefs('SCHEMA-01'), transactionId: ids.transactionId, mutationLeaseId: ids.mutationLeaseId } },
      { action: 'record-assumption', kind: 'assumption_recorded', tool: 'synthi_codesite_record_assumption', references: { ...baseRefs('SCHEMA-01'), assumptionId: ids.schemaAssumptionId, path: workflowContext.readPath } },
      { action: 'propose-controlled-write', kind: 'controlled_write_proposed', tool: 'synthi_codesite_apply_patch', references: { ...baseRefs('SCHEMA-01'), transactionId: ids.transactionId, path: workflowContext.changedPath, contentSha256: workflowContext.patch.afterSha256 } },
      { action: 'request-inspection', kind: 'inspection_requested', tool: 'synthi_codesite_request_landing', references: { ...baseRefs('SCHEMA-01'), inspectionRunId: ids.inspectionRunId } },
      { action: 'request-commit', kind: 'commit_requested', tool: 'synthi_codesite_request_commit', references: { ...baseRefs('SCHEMA-01'), transactionId: ids.transactionId } },
    ],
    'API-02': [
      { action: 'read-control-state', kind: 'control_state_read', tool: 'synthi_codesite_get_radar', references: baseRefs('API-02') },
      { action: 'file-execution-plan', kind: 'execution_plan_filed', tool: 'synthi_codesite_file_flight_plan', references: baseRefs('API-02') },
      { action: 'read-inbox', kind: 'inbox_read', tool: 'synthi_codesite_get_inbox', references: { ...baseRefs('API-02'), documentId: ids.rfiDocumentId, eventId: ids.rfiInboxEventId } },
      { action: 'ack-inbox-event', kind: 'inbox_event_acknowledged', tool: 'synthi_codesite_ack_event', references: { ...baseRefs('API-02'), inboxItemId: ids.rfiAckInboxItemId, eventId: ids.rfiInboxEventId } },
      { action: 'file-change-order', kind: 'change_order_filed', tool: 'synthi_codesite_file_change_order', references: { ...baseRefs('API-02'), documentId: ids.changeOrderDocumentId, answersDocumentId: ids.rfiDocumentId } },
      { action: 'abort-stale-transaction', kind: 'stale_transaction_aborted', tool: 'synthi_codesite_abort_transaction', references: { ...baseRefs('API-02'), transactionId: ids.apiAbortTransactionId, originalTransactionId: ids.apiTransactionId, staleAssumptionId: ids.staleAssumptionId } },
    ],
    'TEST-03': [
      { action: 'read-control-state', kind: 'control_state_read', tool: 'synthi_codesite_get_radar', references: baseRefs('TEST-03') },
      { action: 'file-execution-plan', kind: 'execution_plan_filed', tool: 'synthi_codesite_file_flight_plan', references: baseRefs('TEST-03') },
      { action: 'request-landing', kind: 'landing_requested', tool: 'synthi_codesite_request_landing', references: { ...baseRefs('TEST-03'), inspectionRunId: ids.inspectionRunId, changedPath: workflowContext.changedPath } },
      { action: 'read-metrics', kind: 'metrics_read', tool: 'synthi_codesite_get_metrics', references: { ...baseRefs('TEST-03'), inspectionRunId: ids.inspectionRunId, projectId: ids.projectId } },
    ],
  };
}

async function prepareCodexActorProjection({ evidenceDir, slug, projectId, proofRepo, agentRegistrations, workflowContext }) {
  const actionScript = codexActorActionScriptSource();
  const actionScriptPath = path.join(proofRepo.hostRoot, 'scripts', 'codesite-agent-action.mjs');
  await fs.promises.writeFile(actionScriptPath, actionScript, { encoding: 'utf8', mode: 0o755 });
  const actionContracts = buildCodexActorActionContracts({ agentRegistrations, workflowContext });
  const state = {
    schemaVersion: 'synthi.codesite.agentProjection.v1',
    source: 'codesite-full-workflow-proof',
    workspaceSlug: slug,
    projectId,
    generatedAt: new Date().toISOString(),
    actionScriptSha256: await fileSha256(actionScriptPath),
    agents: agentRegistrations.map((entry) => ({
      callsign: entry.spec.callsign,
      role: entry.spec.domain,
      mission: entry.spec.mission,
      status: entry.spec.status,
      providerSessionRef: entry.spec.providerSessionRef,
      agentSessionId: entry.agentSession.id,
      executionPlanId: entry.executionPlan.id,
      permissions: entry.agentSession.permissions,
      requestedTools: entry.executionPlan.requestedTools,
      route: entry.executionPlan.route,
    })),
    mutation: {
      mutationLeaseId: workflowContext.lease.id,
      transactionId: workflowContext.transaction.id,
      allowedPaths: workflowContext.lease.allowedPaths,
      writeSet: workflowContext.transaction.writeSet,
      readSet: workflowContext.transaction.readSet,
      observedReadSet: workflowContext.transaction.observedReadSet,
    },
    patch: {
      path: workflowContext.changedPath,
      afterSha256: workflowContext.patch.afterSha256,
      reasonRef: workflowContext.patch.reasonRef,
      evidenceRefs: workflowContext.patch.evidenceRefs,
    },
    coordination: {
      rfiDocument: workflowContext.rfiDocument,
      rfiInboxItem: workflowContext.rfiInboxItem,
      rfiAck: workflowContext.rfiAck,
      changeOrderDocument: workflowContext.changeOrderDocument,
      changeOrderInboxItem: workflowContext.changeOrderInboxItem,
      changeOrderAck: workflowContext.changeOrderAck,
    },
    assumptions: {
      schema: workflowContext.schemaAssumption,
      stale: workflowContext.staleAssumption,
      apiTransaction: workflowContext.apiTransaction,
      apiAbort: workflowContext.apiAbort,
    },
    inspection: {
      inspectionRun: workflowContext.inspectionRun,
      status: workflowContext.inspectionRun.status,
      changedPaths: workflowContext.inspectionRun.changedPaths,
    },
    metrics: {
      startupWorkflow: 'schema-first signup audit-log migration',
      documentCount: workflowContext.documentCount,
      inboxItemCount: workflowContext.inboxItemCount,
      counterfactualRunId: workflowContext.counterfactualRun.id,
    },
    actionContracts,
  };
  const projectionRoot = path.join(proofRepo.hostRoot, '.synthi', 'codesite', 'projects', projectId);
  await fs.promises.mkdir(projectionRoot, { recursive: true });
  const controlStatePath = path.join(projectionRoot, 'control-state.json');
  await fs.promises.writeFile(controlStatePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  const mirroredControlStatePath = path.join(evidenceDir, 'codex-actor-control-state.json');
  const mirroredActionScriptPath = path.join(evidenceDir, 'codesite-agent-action.mjs.txt');
  await fs.promises.copyFile(controlStatePath, mirroredControlStatePath);
  await fs.promises.writeFile(mirroredActionScriptPath, actionScript, 'utf8');
  return {
    root: projectionRoot,
    controlStatePath,
    actionScriptPath,
    mirroredControlStatePath,
    mirroredActionScriptPath,
    controlStateSha256: await fileSha256(mirroredControlStatePath),
    actionScriptSha256: await fileSha256(mirroredActionScriptPath),
    actionContracts,
  };
}

function codexAgentCommands({ spec, proofRepo, projectId, actorProjection }) {
  const repoPath = (absolutePath) => path.relative(repoRoot(), absolutePath).split(path.sep).join('/');
  const scriptPath = repoPath(actorProjection.actionScriptPath);
  const actionCommand = (action) => `node ${scriptPath} --project ${projectId} --callsign ${spec.callsign} ${action}`;
  const contractCommands = (actorProjection.actionContracts[spec.callsign] || []).map((entry) => actionCommand(entry.action));
  const proofRepoPath = repoPath(proofRepo.hostRoot);
  if (spec.domain === 'schema') {
    return [
      ...contractCommands.slice(0, 6),
      `cd ${proofRepoPath} && npm run typecheck`,
      ...contractCommands.slice(6),
    ];
  }
  if (spec.domain === 'inspection') {
    return [
      ...contractCommands,
      `cd ${proofRepoPath} && npm test`,
    ];
  }
  return [
    ...contractCommands,
    `rg -n "api.signup.depends_on_schema.v1|auth.signup.schema.v1" ${repoPath(actorProjection.controlStatePath)}`,
  ];
}

async function mirrorActionReceipts({ evidenceDir, actorProjection, spec }) {
  const safeCallsign = safeArtifactSegment(spec.callsign);
  const receiptSourcePath = path.join(actorProjection.root, 'outbox', spec.callsign, 'actions.jsonl');
  assertProof(fs.existsSync(receiptSourcePath), `Codex actor receipt file missing for ${spec.callsign}`);
  const receiptMirrorPath = path.join(evidenceDir, `${safeCallsign}.actions.jsonl`);
  await fs.promises.copyFile(receiptSourcePath, receiptMirrorPath);
  const receiptText = await fs.promises.readFile(receiptMirrorPath, 'utf8');
  const workflowActions = parseJsonl(receiptText);
  return {
    workflowActions,
    receiptMirrorPath,
    receiptSha256: await fileSha256(receiptMirrorPath),
  };
}

function parseCodexJsonEvents(...texts) {
  return texts
    .flatMap((text) => String(text || '').split(/\r?\n/))
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{') && line.endsWith('}'))
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function parseCodexFinalJson(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function codexToolEventCount(events) {
  return events.filter((event) => {
    const item = event?.item || event || {};
    const itemType = String(item.type || event?.type || '');
    if (itemType === 'agent_message') return false;
    return /tool|command|exec|shell/i.test(itemType)
      || Boolean(item.command)
      || item.name === 'exec_command'
      || item.recipient_name === 'functions.exec_command';
  }).length;
}

function codexCommandEvidence(events, { transcriptDigest, finalMessageDigest }) {
  return events
    .filter((event) => event?.type === 'item.completed' && event.item?.type === 'command_execution')
    .map((event, index) => {
      const item = event.item || {};
      const command = String(item.command || '').trim();
      const aggregatedOutput = String(item.aggregated_output || '');
      const outputDigest = digest(aggregatedOutput);
      return {
        command,
        executable: command.split(/\s+/)[0] || 'shell',
        args: [],
        exitCode: item.exit_code ?? null,
        status: item.status || 'completed',
        source: 'codex_jsonl_command_execution',
        transcriptEventId: item.id || null,
        outputDigest,
        evidenceDigest: digest({
          command,
          exitCode: item.exit_code ?? null,
          status: item.status || 'completed',
          eventId: item.id || null,
          transcriptDigest,
          finalMessageDigest,
          outputDigest,
          index,
        }),
      };
    });
}

async function generateAgentExecutionEvidence({ dir, slug, projectId, proofRepo, agentFlightSpecs, agentRegistrations, workflowContext }) {
  const codexHome = process.env.CODESITE_PROOF_CODEX_AGENT_HOME || '/tmp/codesite-codex-agent-home';
  assertProof(fs.existsSync(codexHome), `Codex agent proof home does not exist: ${codexHome}`);
  assertProof(fs.existsSync(path.join(codexHome, 'auth.json')), `Codex agent proof home is missing auth.json: ${codexHome}`);
  const evidenceDir = agentExecutionEvidenceDir(dir, slug);
  await fs.promises.rm(evidenceDir, { recursive: true, force: true });
  await fs.promises.mkdir(evidenceDir, { recursive: true });
  const schemaPath = path.join(evidenceDir, 'codex-agent-output.schema.json');
  await fs.promises.writeFile(schemaPath, `${JSON.stringify(codexAgentOutputSchema(), null, 2)}\n`, 'utf8');
  const actorProjection = await prepareCodexActorProjection({
    evidenceDir,
    slug,
    projectId,
    proofRepo,
    agentRegistrations,
    workflowContext,
  });

  for (const spec of agentFlightSpecs) {
    const registration = agentRegistrations.find((entry) => entry.spec.callsign === spec.callsign);
    const safeCallsign = safeArtifactSegment(spec.callsign);
    const stdoutPath = path.join(evidenceDir, `${safeCallsign}.events.raw.jsonl`);
    const stderrPath = path.join(evidenceDir, `${safeCallsign}.stderr.log`);
    const finalPath = path.join(evidenceDir, `${safeCallsign}.final.txt`);
    const actorCommands = codexAgentCommands({ spec, proofRepo, projectId, actorProjection });
    const prompt = codexAgentPrompt({ spec, registration, slug, projectId, proofRepo, actorCommands, actorProjection });
    const args = [
      '-a',
      'never',
      'exec',
      '--json',
      '--ephemeral',
      '--ignore-user-config',
      '--ignore-rules',
      '--dangerously-bypass-approvals-and-sandbox',
      '--output-schema',
      schemaPath,
      '--output-last-message',
      finalPath,
      '-C',
      repoRoot(),
      prompt,
    ];
    const startedAt = new Date();
    const result = await runWithClosedStdin('codex', args, {
      cwd: repoRoot(),
      timeoutMs: normalizeCodexAgentTimeoutMs(),
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
      },
    });
    const completedAt = new Date();
    const stdoutRedaction = redactProofArtifactSecrets(result.stdout);
    const stderrRedaction = redactProofArtifactSecrets(result.stderr);
    await fs.promises.writeFile(stdoutPath, stdoutRedaction.text, 'utf8');
    await fs.promises.writeFile(stderrPath, stderrRedaction.text, 'utf8');
    const rawFinalText = fs.existsSync(finalPath) ? fs.readFileSync(finalPath, 'utf8') : '';
    const finalRedaction = redactProofArtifactSecrets(rawFinalText);
    if (fs.existsSync(finalPath)) {
      await fs.promises.writeFile(finalPath, finalRedaction.text, 'utf8');
    }
    const finalText = finalRedaction.text;
    const redactionCounts = mergeRedactionCounts(stdoutRedaction.counts, stderrRedaction.counts, finalRedaction.counts);
    const finalJson = parseCodexFinalJson(finalText);
    const events = parseCodexJsonEvents(stdoutRedaction.text, stderrRedaction.text);
    const threadId = events.find((event) => event.type === 'thread.started')?.thread_id || null;
    const usage = events.find((event) => event.type === 'turn.completed')?.usage || null;
    const toolEventCount = codexToolEventCount(events);
    const transcriptDigest = digest(stdoutRedaction.text);
    const stdoutDigest = digest(stdoutRedaction.text);
    const stderrDigest = digest(stderrRedaction.text);
    const finalMessageDigest = digest(finalText);
    const eventsRawSha256 = await fileSha256(stdoutPath);
    const stderrSha256 = await fileSha256(stderrPath);
    const finalMessageSha256 = fs.existsSync(finalPath) ? await fileSha256(finalPath) : null;
    const commandEvidence = codexCommandEvidence(events, { transcriptDigest, finalMessageDigest });
    const receiptEvidence = await mirrorActionReceipts({ evidenceDir, actorProjection, spec });
    const workflowActions = receiptEvidence.workflowActions;
    const record = {
      schemaVersion: 'synthi.codesite.codexAgentExecutionEvidence.v1',
      callsign: spec.callsign,
      workspaceSlug: slug,
      providerSessionRef: spec.providerSessionRef,
      providerSessionRefSource: 'codesite_registered_session',
      role: spec.domain,
      agentSessionId: registration?.agentSession?.id || null,
      executionPlanId: registration?.executionPlan?.id || null,
      codexExecThreadId: threadId,
      commands: commandEvidence,
      reportedCommands: asArray(finalJson?.commandsRun),
      workflowActions,
      actorProjection: {
        surface: 'repo_local_codesite_projection',
        runtimeControlStatePath: path.relative(repoRoot(), actorProjection.controlStatePath).split(path.sep).join('/'),
        runtimeActionScriptPath: path.relative(repoRoot(), actorProjection.actionScriptPath).split(path.sep).join('/'),
        controlStatePath: path.relative(repoRoot(), actorProjection.mirroredControlStatePath).split(path.sep).join('/'),
        actionScriptPath: path.relative(repoRoot(), actorProjection.mirroredActionScriptPath).split(path.sep).join('/'),
        receiptPath: path.relative(repoRoot(), receiptEvidence.receiptMirrorPath).split(path.sep).join('/'),
        controlStateSha256: actorProjection.controlStateSha256,
        actionScriptSha256: actorProjection.actionScriptSha256,
        receiptSha256: receiptEvidence.receiptSha256,
        requiredActions: roleWorkflowActionRequirements(spec.domain),
      },
      finalReportedWorkflowActions: asArray(finalJson?.workflowActions),
      finalMessageDigest,
      transcriptDigest,
      stdoutDigest,
      stderrDigest,
      transcript: {
        eventsRawPath: path.relative(repoRoot(), stdoutPath).split(path.sep).join('/'),
        stderrPath: path.relative(repoRoot(), stderrPath).split(path.sep).join('/'),
        finalMessagePath: path.relative(repoRoot(), finalPath).split(path.sep).join('/'),
        eventCount: events.length,
        toolEventCount,
        threadId,
        usage,
        stdoutDigest,
        stderrDigest,
        finalMessageDigest,
        eventsRawSha256,
        stderrSha256,
        finalMessageSha256,
        redactionCounts,
      },
      redactionReport: {
        finalPublicationSecretScanRequired: true,
        rawCredentialMaterialStored: 'redacted_before_publication',
        authHomeStoredInRepo: 'validated_at_publication',
        promptIncludedSecrets: 'redacted_before_publication',
        counts: redactionCounts,
        outerIsolation: 'docker_playwright_sidecar_networked_with_proof_app',
      },
      generatedAt: completedAt.toISOString(),
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
    };
    await fs.promises.writeFile(path.join(evidenceDir, `${safeCallsign}.json`), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  }

  return loadAgentExecutionEvidence({ dir, slug, agentFlightSpecs });
}

function normalizeCodexAgentTimeoutMs() {
  const requested = Number(process.env.CODESITE_PROOF_CODEX_AGENT_TIMEOUT_MS || 600000);
  return Number.isFinite(requested) && requested > 0 ? Math.min(requested, 900000) : 600000;
}

async function prepareProofRepo({ dir, slug, changedPath, readPath }) {
  const hostRoot = path.join(dir, 'codesite-full-workflow-repos', slug);
  const gitEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: path.join(dir, 'codesite-full-workflow-gitconfig'),
  };
  await fs.promises.rm(hostRoot, { recursive: true, force: true });
  await fs.promises.mkdir(path.dirname(path.join(hostRoot, changedPath)), { recursive: true });
  await fs.promises.mkdir(path.dirname(path.join(hostRoot, readPath)), { recursive: true });
  const before = [
    'datasource db {',
    '  provider = "postgresql"',
    '  url      = env("DATABASE_URL")',
    '}',
    '',
    'model User {',
    '  id    String @id',
    '  email String @unique',
    '}',
    '',
  ].join('\n');
  const after = [
    before,
    'model AuditEvent {',
    '  id        String   @id',
    '  userId    String',
    '  createdAt DateTime @default(now())',
    '}',
    '',
  ].join('\n');
  await fs.promises.writeFile(path.join(hostRoot, changedPath), before, 'utf8');
  await fs.promises.writeFile(path.join(hostRoot, readPath), 'schema-contract-read-v1\n', 'utf8');
  await fs.promises.mkdir(path.join(hostRoot, 'scripts'), { recursive: true });
  await fs.promises.writeFile(path.join(hostRoot, 'scripts', 'codesite-agent-action.mjs'), codexActorActionScriptSource(), { encoding: 'utf8', mode: 0o755 });
  await fs.promises.writeFile(path.join(hostRoot, 'package.json'), JSON.stringify({
    name: `codesite-proof-${slug}`,
    private: true,
    type: 'module',
    scripts: {
      typecheck: 'node scripts/typecheck-schema.mjs',
      test: 'node scripts/test-schema-contract.mjs',
    },
  }, null, 2), 'utf8');
  await fs.promises.writeFile(path.join(hostRoot, 'scripts', 'typecheck-schema.mjs'), [
    "import fs from 'node:fs';",
    '',
    "const schema = fs.readFileSync('synthi/prisma/schema.prisma', 'utf8');",
    'const required = [',
    '  /datasource\\s+db\\s*{[\\s\\S]*provider\\s*=\\s*"postgresql"/,',
    '  /model\\s+User\\s*{[\\s\\S]*id\\s+String\\s+@id[\\s\\S]*email\\s+String\\s+@unique[\\s\\S]*}/,',
    '  /model\\s+AuditEvent\\s*{[\\s\\S]*id\\s+String\\s+@id[\\s\\S]*userId\\s+String[\\s\\S]*createdAt\\s+DateTime\\s+@default\\(now\\(\\)\\)[\\s\\S]*}/,',
    '];',
    'const missing = required.filter((pattern) => !pattern.test(schema)).map((pattern) => pattern.toString());',
    'if (missing.length) {',
    "  console.error('schema typecheck failed', JSON.stringify(missing));",
    '  process.exit(1);',
    '}',
    "console.log('schema typecheck passed: AuditEvent contract is compatible with User identity schema');",
    '',
  ].join('\n'), 'utf8');
  await fs.promises.writeFile(path.join(hostRoot, 'scripts', 'test-schema-contract.mjs'), [
    "import fs from 'node:fs';",
    '',
    "const schema = fs.readFileSync('synthi/prisma/schema.prisma', 'utf8');",
    "const contract = fs.readFileSync('synthi/prisma/schema-contract-read.txt', 'utf8').trim();",
    "if (contract !== 'schema-contract-read-v1') {",
    "  console.error(`unexpected read contract ${contract}`);",
    '  process.exit(1);',
    '}',
    "const auditEventBlock = schema.match(/model\\s+AuditEvent\\s*{([\\s\\S]*?)}/)?.[1] || '';",
    'const assertions = [',
    "  ['audit event model exists', auditEventBlock.length > 0],",
    "  ['audit event has stable id', /id\\s+String\\s+@id/.test(auditEventBlock)],",
    "  ['audit event binds user id', /userId\\s+String/.test(auditEventBlock)],",
    "  ['audit event has server timestamp', /createdAt\\s+DateTime\\s+@default\\(now\\(\\)\\)/.test(auditEventBlock)],",
    '];',
    'const failures = assertions.filter(([, ok]) => !ok).map(([label]) => label);',
    'if (failures.length) {',
    "  console.error('schema contract tests failed', JSON.stringify(failures));",
    '  process.exit(1);',
    '}',
    "console.log('schema contract tests passed: AuditEvent satisfies startup audit-log workflow');",
    '',
  ].join('\n'), 'utf8');
  await run('git', ['init'], { cwd: hostRoot, env: gitEnv });
  await run('git', ['config', '--global', '--add', 'safe.directory', hostRoot], { cwd: hostRoot, env: gitEnv });
  await run('git', ['config', 'user.email', 'codesite-proof@example.invalid'], { cwd: hostRoot, env: gitEnv });
  await run('git', ['config', 'user.name', 'CodeSite Proof'], { cwd: hostRoot, env: gitEnv });
  await run('git', ['add', '.'], { cwd: hostRoot, env: gitEnv });
  await run('git', ['commit', '-m', 'Initial CodeSite proof repo'], { cwd: hostRoot, env: gitEnv });
  return {
    hostRoot,
    containerRoot: containerRepoRoot(hostRoot),
    gitEnv,
    before,
    after,
  };
}

async function gitCommitAll(proofRepo, message) {
  await run('git', ['add', '.'], { cwd: proofRepo.hostRoot, env: proofRepo.gitEnv });
  await run('git', ['commit', '-m', message], { cwd: proofRepo.hostRoot, env: proofRepo.gitEnv });
  return gitCommitEvidence(proofRepo);
}

async function gitAmendHead(proofRepo, message) {
  await run('git', ['commit', '--amend', '-m', message], { cwd: proofRepo.hostRoot, env: proofRepo.gitEnv });
  return gitCommitEvidence(proofRepo);
}

async function gitCommitEvidence(proofRepo) {
  const [sha, tree, message] = await Promise.all([
    run('git', ['rev-parse', 'HEAD'], { cwd: proofRepo.hostRoot, env: proofRepo.gitEnv }),
    run('git', ['rev-parse', 'HEAD^{tree}'], { cwd: proofRepo.hostRoot, env: proofRepo.gitEnv }),
    run('git', ['show', '-s', '--format=%B', 'HEAD'], { cwd: proofRepo.hostRoot, env: proofRepo.gitEnv }),
  ]);
  return {
    sha: sha.stdout.trim(),
    tree: tree.stdout.trim(),
    message: message.stdout.trim(),
  };
}

function proofShadowExecutionPlan(proofRepo, changedPath) {
  return {
    schemaVersion: 'synthi.codesite.shadowExecutionPlan.v1',
    repoRoot: proofRepo.containerRoot,
    stopOnFailure: false,
    commands: [
      {
        label: 'schema-typecheck',
        command: 'node',
        args: ['scripts/typecheck-schema.mjs'],
      },
      {
        label: 'schema-contract-test',
        command: 'node',
        args: ['scripts/test-schema-contract.mjs'],
      },
    ],
    universes: {
      'schema-first': {
        patches: [{ path: changedPath, content: proofRepo.after }],
      },
      'frontend-backend-parallel': {
        patches: [],
      },
    },
  };
}

function commitMessageWithTrailers(summary, trailers) {
  return [
    summary,
    '',
    Object.entries(trailers || {})
      .filter(([, value]) => value != null && value !== '')
      .map(([key, value]) => `${key}: ${value}`)
      .join('\n'),
  ].join('\n');
}

function commitMessageContainsTrailers(message, trailers) {
  return Object.entries(trailers || {})
    .filter(([, value]) => value != null && value !== '')
    .every(([key, value]) => message.includes(`${key}: ${value}`));
}

async function writeRuntimeBoundaryAttestations(dir, { slug, project, transaction, lease, runtimeBoundary }) {
  const specs = [
    {
      file: 'codesite-runtime-boundary-host-block-attestation.json',
      proofId: 'codesite.runtime.host-block.current',
      title: 'Active CodeSite host runtime surfaces are blocked',
      assertions: {
        terminalHostBlocked: runtimeBoundary.terminalHostMode === 'block-host',
        programHeadlessBlocked: runtimeBoundary.programHeadlessMode === 'block-host',
        runtimePodWithoutManagedMountBlocked: runtimeBoundary.terminalRuntimePodMode === 'block-runtime'
          && runtimeBoundary.programRuntimePodMode === 'block-runtime',
      },
      evidence: {
        terminalHostMode: runtimeBoundary.terminalHostMode,
        programHeadlessMode: runtimeBoundary.programHeadlessMode,
        terminalRuntimePodMode: runtimeBoundary.terminalRuntimePodMode,
        programRuntimePodMode: runtimeBoundary.programRuntimePodMode,
      },
    },
    {
      file: 'codesite-runtime-boundary-overlay-attestation.json',
      proofId: 'codesite.runtime.quarantine-overlay.current',
      title: 'Active CodeSite managed runtime surfaces require quarantine overlay',
      assertions: {
        containerTerminalUsesQuarantineRuntime: runtimeBoundary.terminalContainerMode === 'overlay-runtime',
        hybridProgramUsesQuarantineRuntime: runtimeBoundary.programHybridMode === 'overlay-runtime',
        runtimePodWithManagedOverlayUsesQuarantineRuntime: runtimeBoundary.terminalRuntimePodWithOverlayMode === 'overlay-runtime'
          && runtimeBoundary.programRuntimePodWithOverlayMode === 'overlay-runtime',
        overlayShellDidNotMutateRealRepo: runtimeBoundary.rawShellOverlay.realRepoUnchangedBeforeFinalize === true,
        unmanagedTerminalWriteQuarantined: runtimeBoundary.unmanagedTerminalWriteBoundary?.outcome === 'quarantined_before_real_repo_mutation'
          && runtimeBoundary.unmanagedTerminalWriteBoundary?.realRepoUnchangedBeforeFinalize === true
          && runtimeBoundary.unmanagedTerminalWriteBoundary?.overlayOnlyMutationObserved === true,
      },
      evidence: {
        terminalContainerMode: runtimeBoundary.terminalContainerMode,
        programHybridMode: runtimeBoundary.programHybridMode,
        terminalRuntimePodWithOverlayMode: runtimeBoundary.terminalRuntimePodWithOverlayMode,
        programRuntimePodWithOverlayMode: runtimeBoundary.programRuntimePodWithOverlayMode,
        rawShellOverlay: runtimeBoundary.rawShellOverlay,
        unmanagedTerminalWriteBoundary: runtimeBoundary.unmanagedTerminalWriteBoundary,
      },
    },
  ];

  const attestations = [];
  for (const spec of specs) {
    const payload = {
      schemaVersion: 'synthi.codesite.runtimeBoundaryAttestation.v1',
      proofId: spec.proofId,
      title: spec.title,
      workspaceSlug: slug,
      projectId: project.id,
      transactionId: transaction.id,
      mutationLeaseId: lease.id,
      displayCallsign: lease.displayCallsign,
      generatedAt: new Date().toISOString(),
      currentWorkflowRun: true,
      assertions: spec.assertions,
      evidence: spec.evidence,
    };
    payload.attestationDigest = digest(payload);
    const absolutePath = path.join(dir, spec.file);
    const content = `${JSON.stringify(payload, null, 2)}\n`;
    await fs.promises.writeFile(absolutePath, content, 'utf8');
    attestations.push({
      path: path.relative(repoRoot(), absolutePath).split(path.sep).join('/'),
      digest: `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`,
      proofId: payload.proofId,
      assertions: payload.assertions,
      currentWorkflowRun: true,
      attestationDigest: payload.attestationDigest,
    });
  }
  return attestations;
}

async function buildContainerReadableSnapshot(readSet, hostRepoRoot, containerRoot, options = {}) {
  const scope = options.scope === 'read_set' ? 'read_set' : 'repo_wide';
  const limits = {
    maxFiles: 512,
    maxFileBytes: 2 * 1024 * 1024,
    maxScanEntries: 15000,
  };
  const fileDigests = await Promise.all(readSet.map(async (filePath) => {
    const absolutePath = path.join(hostRepoRoot, filePath);
    const content = await fs.promises.readFile(absolutePath);
    const stat = await fs.promises.stat(absolutePath);
    return {
      path: filePath,
      exists: true,
      size: stat.size,
      digest: `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`,
    };
  }));
  const repoManifest = scope === 'repo_wide'
    ? await buildProofRepoManifest(hostRepoRoot, limits)
    : {
      repoManifestDigest: null,
      repoManifestFileCount: 0,
      repoManifestScannedEntries: 0,
      repoManifestTruncated: false,
      repoManifestSkippedPaths: [],
    };
  const evidence = {
    schemaVersion: 'synthi.codesite.readSnapshotEvidence.v1',
    status: 'recorded',
    scope,
    readSet,
    repoRoot: containerRoot,
    fileDigests,
    missingPaths: [],
    skippedPaths: [],
    truncated: false,
    repoManifestDigest: repoManifest.repoManifestDigest,
    repoManifestFileCount: repoManifest.repoManifestFileCount,
    repoManifestScannedEntries: repoManifest.repoManifestScannedEntries,
    repoManifestTruncated: repoManifest.repoManifestTruncated,
    repoManifestSkippedPaths: repoManifest.repoManifestSkippedPaths,
    limits,
    generatedAt: new Date().toISOString(),
    source: 'codesite-full-workflow-proof',
  };
  evidence.snapshotDigest = digest({
    schemaVersion: evidence.schemaVersion,
    status: evidence.status,
    scope: evidence.scope,
    readSet: evidence.readSet,
    fileDigests: evidence.fileDigests,
    missingPaths: evidence.missingPaths,
    skippedPaths: evidence.skippedPaths,
    truncated: evidence.truncated,
    repoManifestDigest: evidence.repoManifestDigest,
    repoManifestFileCount: evidence.repoManifestFileCount,
    repoManifestTruncated: evidence.repoManifestTruncated,
    repoManifestSkippedPaths: evidence.repoManifestSkippedPaths,
    limits: evidence.limits,
  });
  evidence.evidenceDigest = digest({
    schemaVersion: evidence.schemaVersion,
    status: evidence.status,
    scope: evidence.scope,
    readSet: evidence.readSet,
    snapshotDigest: evidence.snapshotDigest,
    fileCount: evidence.fileDigests.length,
    missingPaths: evidence.missingPaths,
    skippedPaths: evidence.skippedPaths,
    truncated: evidence.truncated,
    repoManifestDigest: evidence.repoManifestDigest,
    repoManifestFileCount: evidence.repoManifestFileCount,
    repoManifestTruncated: evidence.repoManifestTruncated,
    repoManifestSkippedPaths: evidence.repoManifestSkippedPaths,
    source: evidence.source,
  });
  return evidence;
}

const PROOF_SNAPSHOT_SKIP_DIRS = new Set([
  '.git',
  '.next',
  '.turbo',
  '.cache',
  '.synthi',
  'coverage',
  'dist',
  'build',
  'node_modules',
]);

async function buildProofRepoManifest(hostRepoRoot, limits) {
  const accumulator = {
    files: new Set(),
    skippedPaths: [],
    truncated: false,
    scanEntries: 0,
  };
  await collectProofRepoFiles(hostRepoRoot, '', accumulator, limits);
  const fileDigests = [];
  for (const filePath of [...accumulator.files].sort()) {
    const result = await proofRepoFileDigest(hostRepoRoot, filePath, limits);
    if (result.skipped) accumulator.skippedPaths.push(result.skipped);
    else fileDigests.push(result.file);
  }
  const repoManifestSkippedPaths = accumulator.skippedPaths.sort(compareProofPathEntries);
  return {
    repoManifestDigest: digest({
      schemaVersion: 'synthi.codesite.readSnapshotEvidence.v1',
      scope: 'repo_wide',
      fileDigests,
      skippedPaths: repoManifestSkippedPaths,
      truncated: accumulator.truncated,
      limits,
    }),
    repoManifestFileCount: fileDigests.length,
    repoManifestScannedEntries: accumulator.scanEntries,
    repoManifestTruncated: accumulator.truncated,
    repoManifestSkippedPaths,
  };
}

async function collectProofRepoFiles(hostRepoRoot, relDir, accumulator, limits) {
  if (accumulator.files.size >= limits.maxFiles || accumulator.scanEntries >= limits.maxScanEntries) {
    accumulator.truncated = true;
    return;
  }
  const absoluteDir = path.resolve(hostRepoRoot, relDir || '');
  let entries;
  try {
    entries = await fs.promises.readdir(absoluteDir, { withFileTypes: true });
  } catch (error) {
    accumulator.skippedPaths.push({ path: relDir || '.', reason: 'read_dir_failed', error: error?.message || String(error) });
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (accumulator.files.size >= limits.maxFiles || accumulator.scanEntries >= limits.maxScanEntries) {
      accumulator.truncated = true;
      return;
    }
    const rel = path.posix.normalize(path.posix.join(relDir || '', entry.name));
    if (!rel || rel === '.') continue;
    accumulator.scanEntries += 1;
    if (entry.isDirectory()) {
      if (!PROOF_SNAPSHOT_SKIP_DIRS.has(entry.name)) await collectProofRepoFiles(hostRepoRoot, rel, accumulator, limits);
    } else if (entry.isFile()) {
      accumulator.files.add(rel);
    } else if (entry.isSymbolicLink()) {
      accumulator.skippedPaths.push({ path: rel, reason: 'symlink_skipped' });
    }
  }
}

async function proofRepoFileDigest(hostRepoRoot, filePath, limits) {
  const absolutePath = path.resolve(hostRepoRoot, filePath);
  const relative = path.relative(hostRepoRoot, absolutePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return { skipped: { path: filePath, reason: 'path_escape' } };
  let stat;
  try {
    stat = await fs.promises.stat(absolutePath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { file: { path: filePath, exists: false, size: null, digest: null } };
    }
    return { skipped: { path: filePath, reason: 'stat_failed', error: error?.message || String(error) } };
  }
  if (!stat.isFile()) return { skipped: { path: filePath, reason: 'not_a_file' } };
  if (stat.size > limits.maxFileBytes) return { skipped: { path: filePath, reason: 'file_too_large', size: stat.size } };
  const content = await fs.promises.readFile(absolutePath);
  return {
    file: {
      path: filePath,
      exists: true,
      size: stat.size,
      digest: `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`,
    },
  };
}

function compareProofPathEntries(left, right) {
  return String(left?.path || '').localeCompare(String(right?.path || ''))
    || String(left?.reason || '').localeCompare(String(right?.reason || ''));
}

function resolveProofPath(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return path.isAbsolute(text) ? path.resolve(text) : path.resolve(repoRoot(), text);
}

function proofAppArtifactRoot(slug) {
  if (process.env.CODESITE_PROOF_APP_ARTIFACT_ROOT) {
    return resolveProofPath(process.env.CODESITE_PROOF_APP_ARTIFACT_ROOT);
  }
  const base = process.env.CODESITE_PROOF_APP_ARTIFACT_BASE || process.env.SYNTHI_CODESITE_ARTIFACT_ROOT;
  if (base) {
    return path.join(resolveProofPath(base), safeArtifactSegment(slug), '.synthi', 'codesite');
  }
  return path.join(repoRoot(), '.synthi', 'codesite');
}

function trustedProofKeysPath(slug) {
  const configured = process.env.CODESITE_PROOF_TRUSTED_KEYS_PATH;
  if (configured) return path.resolve(configured);

  const publicKeysJson = proofAuthorityEnvValue('SYNTHI_CODESITE_PROOF_AUTHORITY_PUBLIC_KEYS_JSON');
  if (publicKeysJson) {
    const keysPath = path.join(outDir(), `trusted-proof-authorities-${safeArtifactSegment(slug)}.json`);
    const parsed = JSON.parse(publicKeysJson);
    fs.writeFileSync(keysPath, `${JSON.stringify(parsed, null, 2)}\n`);
    return keysPath;
  }

  const publicKeyPem = proofAuthorityEnvValue('SYNTHI_CODESITE_PROOF_AUTHORITY_PUBLIC_KEY_PEM');
  const keyId = process.env.SYNTHI_CODESITE_PROOF_AUTHORITY_KEY_ID;
  if (publicKeyPem && keyId) {
    const keysPath = path.join(outDir(), `trusted-proof-authorities-${safeArtifactSegment(slug)}.json`);
    fs.writeFileSync(keysPath, `${JSON.stringify({
      [keyId]: {
        keyId,
        publicKeyPem,
      },
    }, null, 2)}\n`);
    return keysPath;
  }

  return null;
}

function hasTrustedHmacProofAuthority(env = process.env) {
  return Boolean(env.SYNTHI_CODESITE_PROOF_AUTHORITY_SECRET || env.SYNTHI_CODESITE_PROOF_AUTHORITY_SECRET_FILE);
}

function verifierProofAuthorityEnv() {
  const env = { ...process.env };
  if (!hasTrustedHmacProofAuthority(env)) {
    delete env.AUTH_SECRET;
    delete env.NEXTAUTH_SECRET;
  }
  return env;
}

function proofAuthorityEnvValue(key) {
  const direct = process.env[key];
  if (direct) return direct;
  const filePath = process.env[`${key}_FILE`];
  if (!filePath) return undefined;
  return fs.readFileSync(resolveProofAuthorityFilePath(filePath), 'utf8');
}

function resolveProofAuthorityFilePath(filePath) {
  return path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(repoRoot(), filePath);
}

async function runVerifier({ proofBundle, exportPaths, slug, repoRoot: gitRepoRoot, commitSha }) {
  const bundleRel = exportPaths.find((item) => item.endsWith(`/proof-bundles/${proofBundle.id}.proof.json`));
  const trailersRel = exportPaths.find((item) => item.endsWith(`/proof-bundles/${proofBundle.id}.trailers.txt`));
  if (!bundleRel || !trailersRel) {
    return {
      ok: false,
      reason: 'proof_bundle_export_missing',
      bundleRel: bundleRel || null,
      trailersRel: trailersRel || null,
    };
  }
  const artifactRoot = proofAppArtifactRoot(slug);
  const bundlePath = path.join(artifactRoot, bundleRel);
  const trailersPath = path.join(artifactRoot, trailersRel);
  const trustedKeysPath = trustedProofKeysPath(slug);
  const verifierEnv = verifierProofAuthorityEnv();
  const trustedHmacProofAuthority = hasTrustedHmacProofAuthority(verifierEnv);
  if (!trustedKeysPath && !trustedHmacProofAuthority) {
    return {
      ok: false,
      reason: 'trusted_proof_authority_missing',
      artifactRoot,
      bundlePath,
      trailersPath,
      json: {
        ok: false,
        reasonCodes: ['proof_bundle_signature_trusted_authority_required'],
        errors: ['trusted proof authority is required but no trusted key source was configured'],
      },
    };
  }
  const result = await run('node', [
    'scripts/codesite-proof-verify.mjs',
    '--bundle',
    bundlePath,
    '--trailers',
    trailersPath,
    '--require-trailers',
    ...(gitRepoRoot && commitSha ? ['--repo', gitRepoRoot, '--commit', commitSha, '--require-git-commit'] : []),
    ...(trustedKeysPath ? ['--trusted-keys', trustedKeysPath] : []),
    '--require-trusted-authority',
  ], { cwd: path.join(repoRoot(), 'synthi'), env: verifierEnv }).then(
    ({ stdout, stderr }) => ({
      ok: true,
      stdout,
      stderr,
      artifactRoot,
      bundlePath,
      trailersPath,
      trustedKeysPath,
      trustedHmacProofAuthority,
    }),
    (error) => ({
      ok: false,
      stdout: String(error.stdout || ''),
      stderr: String(error.stderr || ''),
      message: error.message,
      artifactRoot,
      bundlePath,
      trailersPath,
      trustedKeysPath,
      trustedHmacProofAuthority,
    }),
  );
  try {
    result.json = JSON.parse(result.stdout);
  } catch {
    result.json = null;
  }
  return result;
}

async function proveSerializableSnapshotGate({ api, lease, readPath, changedPath, baseSnapshotEvidence }) {
  const skippedTransaction = await api(`/mutation-leases/${encodeURIComponent(lease.id)}/transactions`, {
    method: 'POST',
    body: JSON.stringify({
      readSet: [readPath],
      writeSet: [changedPath],
      skipRepoSnapshot: true,
      invariants: ['clearance.diff.inside_route'],
    }),
  });
  const skippedValidation = await api(`/transactions/${encodeURIComponent(skippedTransaction.transaction.id)}/validate`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  const skippedAbort = await api(`/transactions/${encodeURIComponent(skippedTransaction.transaction.id)}/abort`, {
    method: 'POST',
    body: JSON.stringify({ reason: 'serializable_snapshot_required' }),
  });

  const undercoveredTransaction = await api(`/mutation-leases/${encodeURIComponent(lease.id)}/transactions`, {
    method: 'POST',
    body: JSON.stringify({
      baseSnapshot: baseSnapshotEvidence.snapshotDigest,
      baseSnapshotEvidence,
      readSet: [readPath],
      writeSet: [changedPath],
      invariants: ['clearance.diff.inside_route'],
    }),
  });
  await api(`/transactions/${encodeURIComponent(undercoveredTransaction.transaction.id)}/record-read`, {
    method: 'POST',
    body: JSON.stringify({ path: changedPath }),
  });
  const undercoveredValidation = await api(`/transactions/${encodeURIComponent(undercoveredTransaction.transaction.id)}/validate`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  const undercoveredAbort = await api(`/transactions/${encodeURIComponent(undercoveredTransaction.transaction.id)}/abort`, {
    method: 'POST',
    body: JSON.stringify({ reason: 'serializable_snapshot_undercovered' }),
  });

  return {
    skipped: {
      transactionId: skippedTransaction.transaction.id,
      ok: skippedValidation.decision.ok,
      abortStatus: skippedAbort.transaction.status,
      reasonCodes: skippedValidation.decision.reasonCodes || [],
      requiredReadSet: skippedValidation.decision.repoSnapshot?.requiredReadSet || [],
      missingReadSet: skippedValidation.decision.repoSnapshot?.missingReadSet || [],
    },
    undercovered: {
      transactionId: undercoveredTransaction.transaction.id,
      ok: undercoveredValidation.decision.ok,
      abortStatus: undercoveredAbort.transaction.status,
      reasonCodes: undercoveredValidation.decision.reasonCodes || [],
      snapshotReadSet: undercoveredValidation.decision.repoSnapshot?.snapshotReadSet || [],
      missingReadSet: undercoveredValidation.decision.repoSnapshot?.missingReadSet || [],
    },
  };
}

function proofHtml(proof) {
  const summary = [
    ['Workspace', proof.slug],
    ['Project', proof.project.title],
    ['Schema clearance', `${proof.clearance.callsign} ${proof.clearance.status}`],
    ['Governance permit', `${proof.clearance.governancePermit?.id || 'missing'} ${proof.clearance.governancePolicy?.verified ? 'verified' : 'unverified'}`],
    ['Transaction', `${proof.transaction.id} ${proof.transaction.status}`],
    ['Auth actors', `${proof.auth.mode}: schema=${proof.auth.actors?.schema?.userId || 'missing'}, api=${proof.auth.actors?.api?.userId || 'missing'}`],
    ['Git commit', `${proof.git?.proofBundleCommitSha || 'missing'} trailers=${proof.git?.trailersPresent ? 'verified' : 'missing'}`],
    ['Runtime attestations', `${proof.runtimeAttestations?.length || 0} linked`],
    ['Stale assumption', `${proof.assumption?.stale?.status || 'missing'} by ${proof.assumption?.stale?.invalidatedBy || 'n/a'}`],
    ['Serializable gate', `skip=${proof.serializableSnapshotGate.skipped.ok ? 'allowed' : 'blocked'}, coverage=${proof.serializableSnapshotGate.undercovered.ok ? 'allowed' : 'blocked'}`],
    ['Proof bundle', `${proof.proofBundle.id} ${proof.proofBundle.bundleDigest}`],
    ['Black-box replay', `${proof.blackBox?.incidentId || 'missing'} ${proof.blackBox?.replayDigest || 'missing digest'} missing=${proof.blackBox?.missingRequiredEventTypes?.length ?? 'n/a'}`],
    ['Codex sessions', `${proof.agentWorkflow?.codexSessionCount || 0} registered, ${proof.agentWorkflow?.exportedAgentSessionPaths?.length || 0} exported`],
    ['Agent execution', `${proof.agentWorkflow?.executionEvidence?.filter((item) => item.validForProof).length || 0} role proofs, ${proof.agentWorkflow?.executionEvidenceDir || 'missing'}`],
    ['Runtime boundary', `host=${proof.runtimeBoundary?.terminalHostMode || 'missing'}, container=${proof.runtimeBoundary?.terminalContainerMode || 'missing'}`],
    ['CodeSiteFS', `${proof.codesiteFs.read.disposition}, ${proof.codesiteFs.denied.disposition}, ${proof.codesiteFs.quarantined.disposition}`],
    ['Counterfactuals', `${proof.counterfactual.projectRunCount} runs, ${proof.counterfactual.policyDeltaCount} policy deltas`],
    ['Coordination', `${proof.coordination.documentCount} documents, ${proof.coordination.inboxItemCount} inbox items`],
    ['Line provenance', proof.lineProvenance.map((row) => `${row.filePath} ${row.lineAnchor}`).join(', ')],
  ];
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CodeSite Full Workflow Proof</title>
<style>
:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#08090e;color:#f4f5f8}
body{margin:0;padding:28px;background:#08090e}
main{max-width:1180px;margin:0 auto}
.hero{border:1px solid #2a3147;border-radius:8px;background:#11131d;padding:22px;margin-bottom:16px}
.pass{display:inline-block;border-radius:6px;background:#123b27;color:#9df2bd;padding:4px 8px;font-size:12px;font-weight:700}
h1{margin:0 0 8px;font-size:24px;letter-spacing:0}
h2{font-size:18px;margin:22px 0 10px}
p{color:#9ba2b8;line-height:1.5}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}
.card{border:1px solid #24283a;border-radius:8px;background:#10121b;padding:14px;min-height:70px}
.label{color:#9ba2b8;font-size:12px}
.value{margin-top:6px;font-size:14px;overflow-wrap:anywhere}
pre{white-space:pre-wrap;border:1px solid #24283a;border-radius:8px;background:#05060a;padding:14px;color:#cbd1e3;font-size:12px}
</style>
</head>
<body>
<main>
<section class="hero">
<span class="pass">PASS</span>
<h1>CodeSite Full Workflow Proof</h1>
<p>Live Docker workflow: schema-first clearance, serializable read-snapshot gates, CodeSiteFS denial and quarantine, transaction write with line provenance, landing inspection, proof bundle, commit trailers, artifact export, and browser UI capture.</p>
</section>
<section class="grid">
${summary.map(([label, value]) => `<div class="card"><div class="label">${escapeHtml(label)}</div><div class="value">${escapeHtml(value)}</div></div>`).join('\n')}
</section>
<h2>Assertions</h2>
<pre>${escapeHtml(JSON.stringify(proof.assertions, null, 2))}</pre>
<h2>Serializable Snapshot Gate</h2>
<pre>${escapeHtml(JSON.stringify(proof.serializableSnapshotGate, null, 2))}</pre>
	<h2>Commit Trailers</h2>
	<pre>${escapeHtml(Object.entries(proof.proofBundle.trailers || {}).map(([key, value]) => `${key}: ${value}`).join('\n'))}</pre>
	<h2>Git Commit Evidence</h2>
	<pre>${escapeHtml(JSON.stringify(proof.git, null, 2))}</pre>
	<h2>Auth Actors</h2>
	<pre>${escapeHtml(JSON.stringify(proof.auth, null, 2))}</pre>
	<h2>Codex Agent Execution</h2>
	<pre>${escapeHtml(JSON.stringify(proof.agentWorkflow?.executionEvidence || [], null, 2))}</pre>
	<h2>Runtime Attestations</h2>
	<pre>${escapeHtml(JSON.stringify(proof.runtimeAttestations, null, 2))}</pre>
	<h2>Assumptions</h2>
	<pre>${escapeHtml(JSON.stringify(proof.assumption, null, 2))}</pre>
	<h2>Black Box Handover</h2>
	<pre>${escapeHtml(JSON.stringify(proof.blackBox, null, 2))}</pre>
	<h2>Counterfactual Policy</h2>
	<pre>${escapeHtml(JSON.stringify(proof.counterfactual, null, 2))}</pre>
	<h2>Coordination</h2>
	<pre>${escapeHtml(JSON.stringify(proof.coordination, null, 2))}</pre>
	<h2>Line Inspector</h2>
	<pre>${escapeHtml(JSON.stringify(proof.lineInspector, null, 2))}</pre>
	</main>
	</body>
	</html>`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function screenshotHtml(htmlPath, pngPath, summaryPngPath = null) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 980 }, deviceScaleFactor: 1 });
  await page.goto(`file://${htmlPath}`, { waitUntil: 'load' });
  if (summaryPngPath) {
    await page.screenshot({ path: summaryPngPath, fullPage: false });
  }
  await page.screenshot({ path: pngPath, fullPage: true });
  await browser.close();
}

function isIgnorableBrowserConsoleError(messageText) {
  const text = String(messageText || '');
  return text.includes('Cross-Origin-Opener-Policy header has been ignored')
    && text.includes('origin was untrustworthy')
    && text.includes('HTTPS protocol')
    && text.includes('localhost');
}

async function installBrowserProofCaptureStyles(page) {
  await page.addStyleTag({
    content: `
      nextjs-portal,
      [data-nextjs-toast],
      [data-nextjs-dialog-overlay],
      [data-nextjs-build-indicator],
      [data-next-badge-root],
      [data-nextjs-dev-tools-button],
      button[aria-label="Open Next.js Dev Tools"] {
        display: none !important;
        visibility: hidden !important;
        pointer-events: none !important;
      }
    `,
  });
}

function browserLayoutCheckScript() {
  const selectors = [
    '[data-testid="codesite-panel"]',
    '[data-testid="codesite-line-provenance-row"]',
    '[data-testid="codesite-line-inspector"]',
    '[data-testid="codesite-causal-replay-handover"]',
  ];
  const rects = selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)).map((element) => {
    const rect = element.getBoundingClientRect();
    return {
      selector,
      width: rect.width,
      left: rect.left,
      right: rect.right,
      fitsViewport: rect.width <= window.innerWidth + 4 && rect.left >= -4 && rect.right <= window.innerWidth + 4,
    };
  }));
  const touchSelectors = [
    '[data-testid="codesite-project-select"]',
    '[data-testid="codesite-refresh"]',
    '[data-testid="codesite-export"]',
  ];
  const touchTargets = touchSelectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)).map((element) => {
    const rect = element.getBoundingClientRect();
    return {
      selector,
      width: rect.width,
      height: rect.height,
      meetsMinimum: rect.width >= 44 && rect.height >= 44,
    };
  }));
  const overlaySelectors = [
    'nextjs-portal',
    '[data-nextjs-toast]',
    '[data-next-badge-root]',
    '[data-nextjs-dev-tools-button]',
    'button[aria-label="Open Next.js Dev Tools"]',
  ];
  const visibleDevOverlays = overlaySelectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)).filter((element) => {
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  }).map((element) => ({
    selector,
    text: (element.textContent || '').trim().slice(0, 80),
  })));
  const lineInspectorStatus = document.querySelector('[data-testid="codesite-line-inspector-status"]')?.textContent?.trim() || null;
  return {
    rects,
    rectsFitViewport: rects.every((rect) => rect.fitsViewport),
    touchTargets,
    touchTargetsOk: touchTargets.every((target) => target.meetsMinimum),
    visibleDevOverlays,
    devOverlayHidden: visibleDevOverlays.length === 0,
    lineInspectorStatus,
    lineInspectorSettled: lineInspectorStatus !== 'loading',
  };
}

async function waitForRouteReady(url, {
  timeoutMs = DEFAULT_LIVE_UI_ROUTE_TIMEOUT_MS,
  perAttemptTimeoutMs = 90000,
  intervalMs = 2000,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  const attempts = [];
  while (Date.now() < deadline) {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.min(perAttemptTimeoutMs, Math.max(1000, deadline - startedAt)));
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { accept: 'text/html,*/*' },
        signal: controller.signal,
      });
      const text = await response.text();
      const durationMs = Date.now() - startedAt;
      attempts.push({
        status: response.status,
        ok: response.ok,
        bytes: Buffer.byteLength(text, 'utf8'),
        durationMs,
      });
      if (response.ok && text.includes('__next')) {
        return { ok: true, attempts, durationMs };
      }
    } catch (error) {
      attempts.push({
        error: error?.name === 'AbortError' ? 'timeout' : (error?.message || String(error)),
        durationMs: Date.now() - startedAt,
      });
    } finally {
      clearTimeout(timeout);
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, Math.max(0, deadline - Date.now()))));
  }
  const error = new Error(`CodeSite UI route was not ready within ${timeoutMs}ms`);
  error.attempts = attempts;
  throw error;
}

async function screenshotLiveUi({ baseUrl, slug, pngPath, proofSectionPngPath, coordinationPngPath, lineInspectorPngPath, handoverPngPath, mobilePngPath, authCookie = '' }) {
  const liveUiUrl = `${baseUrl.replace(/\/+$/, '')}/workspace/${encodeURIComponent(slug)}/codesite`;
  await waitForRouteReady(liveUiUrl, {
    timeoutMs: proofTimeoutMs('CODESITE_PROOF_LIVE_UI_ROUTE_TIMEOUT_MS', DEFAULT_LIVE_UI_ROUTE_TIMEOUT_MS),
    perAttemptTimeoutMs: proofTimeoutMs('CODESITE_PROOF_LIVE_UI_ROUTE_ATTEMPT_TIMEOUT_MS', 120000),
  });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 1 });
  const cookies = authCookiesForBaseUrl(baseUrl, authCookie);
  if (cookies.length) {
    await context.addCookies(cookies);
  }
  const page = await context.newPage();
  const consoleErrors = [];
  const ignoredConsoleErrors = [];
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (isIgnorableBrowserConsoleError(text)) {
      ignoredConsoleErrors.push(text);
      return;
    }
    consoleErrors.push(text);
  });
  await page.goto(liveUiUrl, {
    waitUntil: 'domcontentloaded',
    timeout: proofTimeoutMs('CODESITE_PROOF_LIVE_UI_NAVIGATION_TIMEOUT_MS', DEFAULT_LIVE_UI_NAVIGATION_TIMEOUT_MS),
  });
  await installBrowserProofCaptureStyles(page);
  await page.waitForSelector('[data-testid="codesite-panel"]', { timeout: 60000 });
  await page.waitForSelector('[data-testid="codesite-radar-graph"]', { timeout: 60000 });
  await page.waitForSelector('[data-testid="codesite-causal-replay-handover"]', { timeout: 60000 });
  await page.waitForSelector('text=CodeSite-Black-Box', { timeout: 60000 });
  await page.waitForSelector('text=transaction.committed', { timeout: 60000 });
  await page.waitForSelector('text=black_box.closed', { timeout: 60000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: pngPath, fullPage: false });
  await page.waitForSelector('text=CodeSite-Transaction', { timeout: 60000 });
  await page.waitForSelector('text=Line Provenance', { timeout: 60000 });
  await page.waitForSelector('text=synthi/prisma/schema.prisma', { timeout: 60000 });
  await page.getByText('CodeSite-Transaction').first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  if (proofSectionPngPath) {
    await page.screenshot({ path: proofSectionPngPath, fullPage: false });
  }
  await page.waitForSelector('text=Agent Inbox', { timeout: 60000 });
  await page.waitForSelector('text=Line Provenance', { timeout: 60000 });
  await page.waitForSelector('text=change_order', { timeout: 60000 });
  await page.getByText('Agent Inbox').first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  if (coordinationPngPath) {
    await page.screenshot({ path: coordinationPngPath, fullPage: false });
  }
  const firstLineRow = page.locator('[data-testid="codesite-line-provenance-row"]').first();
  await firstLineRow.scrollIntoViewIfNeeded();
  await firstLineRow.click();
  await page.waitForSelector('[data-testid="codesite-line-inspector"]', { timeout: 60000 });
  await page.waitForSelector('text=change_order:', { timeout: 60000 });
  await page.waitForSelector('text=dojo:proof:', { timeout: 60000 });
  await page.waitForFunction(() => {
    const status = document.querySelector('[data-testid="codesite-line-inspector-status"]')?.textContent?.trim();
    return status && status !== 'loading';
  }, { timeout: 60000 });
  const lineInspector = page.locator('[data-testid="codesite-line-inspector"]').first();
  if (lineInspectorPngPath) {
    await lineInspector.screenshot({ path: lineInspectorPngPath });
  }
  const handoverPanel = page.locator('[data-testid="codesite-causal-replay-handover"]').first();
  await handoverPanel.scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  const desktopLayout = await page.evaluate(browserLayoutCheckScript);
  const desktopChecks = await page.evaluate(() => ({
    panelVisible: Boolean(document.querySelector('[data-testid="codesite-causal-replay-handover"]')),
    codeSiteBlackBoxVisible: Boolean(document.body.textContent.includes('CodeSite-Black-Box')),
    transactionCommittedVisible: Boolean(document.body.textContent.includes('transaction.committed')),
    blackBoxClosedVisible: Boolean(document.body.textContent.includes('black_box.closed')),
    agentInboxVisible: Boolean(document.body.textContent.includes('Agent Inbox')),
    changeOrderVisible: Boolean(document.body.textContent.includes('change_order:')),
    lineInspectorVisible: Boolean(document.querySelector('[data-testid="codesite-line-inspector"]')),
    dojoRefsVisible: Boolean(document.body.textContent.includes('dojo:proof:')),
    noHorizontalOverflow: document.documentElement.scrollWidth <= window.innerWidth + 4,
    scrollWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
  }));
  Object.assign(desktopChecks, desktopLayout);
  if (handoverPngPath) {
    await handoverPanel.screenshot({ path: handoverPngPath });
  }
  let mobileChecks = null;
  if (mobilePngPath) {
    await page.setViewportSize({ width: 390, height: 900 });
    await installBrowserProofCaptureStyles(page);
    await handoverPanel.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    const mobileLayout = await page.evaluate(browserLayoutCheckScript);
    mobileChecks = await page.evaluate(() => ({
      panelVisible: Boolean(document.querySelector('[data-testid="codesite-causal-replay-handover"]')),
      codeSiteBlackBoxVisible: Boolean(document.body.textContent.includes('CodeSite-Black-Box')),
      transactionCommittedVisible: Boolean(document.body.textContent.includes('transaction.committed')),
      blackBoxClosedVisible: Boolean(document.body.textContent.includes('black_box.closed')),
      noHorizontalOverflow: document.documentElement.scrollWidth <= window.innerWidth + 4,
      scrollWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    }));
    Object.assign(mobileChecks, mobileLayout);
    await page.screenshot({ path: mobilePngPath, fullPage: true });
  }
  await browser.close();
  return { consoleErrors, ignoredConsoleErrors, desktopChecks, mobileChecks };
}

async function main() {
  const baseUrl = process.env.CODESITE_PROOF_BASE_URL || DEFAULT_BASE_URL;
  const slug = process.env.CODESITE_PROOF_WORKSPACE_SLUG || slugNow();
  const dir = outDir();
  const runStartedAt = new Date();
  const runPaths = proofOutputPaths(dir, slug);
  fs.mkdirSync(runPaths.runDir, { recursive: true });
  await writeLegacyProofRunningMarker(dir, { slug, runDir: runPaths.runDir, runStartedAt });
  let runtimeAttestations = [];

  const changedPath = 'synthi/prisma/schema.prisma';
  const readPath = 'synthi/prisma/schema-contract-read.txt';
  const proofRepo = await prepareProofRepo({ dir, slug, changedPath, readPath });
  const actorProof = await proofActors(baseUrl, slug);
  const ownerApi = createApi(baseUrl, slug, { authCookie: actorProof.actors.owner.authCookie });
  const schemaApi = createApi(baseUrl, slug, { authCookie: actorProof.actors.schema.authCookie });
  const apiAgentApi = createApi(baseUrl, slug, { authCookie: actorProof.actors.api.authCookie });
  const testApi = createApi(baseUrl, slug, { authCookie: actorProof.actors.test.authCookie });
  const api = schemaApi;
  const proofFetch = createAuthenticatedFetch(actorProof.actors.schema.authCookie);
  const undercoveredSnapshotEvidence = await buildContainerReadableSnapshot([readPath], proofRepo.hostRoot, proofRepo.containerRoot, { scope: 'read_set' });
  const dojoProof = signedDojoProof(slug);
  const proofPolicySourceDigest = digest({ slug, source: 'codesite-full-workflow-policy-source-v1' });
  const proofPolicyDigest = digest({ slug, policy: 'codesite-full-workflow-airspace-policy-v1' });
  let projectPolicySourceDigest = proofPolicySourceDigest;
  const codexRuntime = await collectCodexRuntimeEvidence();
  assertProof(codexRuntime.cliEvidenceOk, 'Codex CLI runtime evidence is required for the full workflow proof');
  assertProof(codexRuntime.providerSessionRefs.length >= 3, 'three real Codex provider session refs are required for the multi-agent proof');
  const agentFlightSpecs = [
    {
      callsign: 'SCHEMA-01',
      domain: 'schema',
      mission: 'Schema first',
      status: 'preflight',
      route: ['synthi/prisma/**'],
      requestedTools: ['file_write', 'npm_test'],
      permissions: ['synthi_codesite_get_radar', 'synthi_codesite_open_transaction', 'synthi_codesite_apply_patch', 'synthi_codesite_record_assumption'],
      providerSessionRef: codexRuntime.providerSessionRefs[0],
      pilotLicenseSnapshot: {
        licenseLevel: 'IFR',
        licenseStatus: 'active',
        repoScope: slug,
        authorizedAirspace: [
          'packages/schemas/**',
          'openapi/**',
          'packages/*/src/index.ts',
          'synthi/prisma/**',
          'backend/collab-server/permissionMiddleware.js',
        ],
        requiredRadar: ['typecheck', 'tests'],
        earnedBy: ['dojo:full-workflow-checkride'],
        expiresOn: ['source_drift'],
        sourceDigest: proofPolicySourceDigest,
        evidenceRefs: ['dojo:evidence:full-workflow-checkride'],
      },
    },
    {
      callsign: 'API-02',
      domain: 'backend',
      mission: 'Dependent API',
      status: 'holding',
      route: ['synthi/prisma/**', 'synthi/src/app/api/auth/**'],
      requestedTools: ['file_write', 'npm_test'],
      permissions: ['synthi_codesite_get_radar', 'synthi_codesite_get_inbox', 'synthi_codesite_ack_event', 'synthi_codesite_file_change_order'],
      providerSessionRef: codexRuntime.providerSessionRefs[1],
    },
    {
      callsign: 'TEST-03',
      domain: 'inspection',
      mission: 'Landing radar',
      status: 'holding',
      route: ['synthi/src/lib/codesite/__tests__/**'],
      requestedTools: ['npm_test'],
      permissions: ['synthi_codesite_get_radar', 'synthi_codesite_request_landing', 'synthi_codesite_get_metrics'],
      providerSessionRef: codexRuntime.providerSessionRefs[2],
    },
  ];
  const projectResponse = await ownerApi('/projects', {
    method: 'POST',
    body: JSON.stringify({
      title: 'Full workflow proof',
      request: 'Land schema contract before dependent backend mutation',
      strategy: 'airspace_survey_first',
      repoPolicyCompiler: false,
      zonePolicy: {
        zones: [{ zoneKey: 'schema', label: 'Schema runway', class: 'B', paths: ['synthi/prisma/**'], risk: 'high' }],
        noFlyZones: ['secrets/**'],
        compiler: {
          sourceDigest: proofPolicySourceDigest,
          policyDigest: proofPolicyDigest,
          source: 'codesite_full_workflow_fixture',
        },
      },
      missions: agentFlightSpecs.map(({ providerSessionRef, permissions, pilotLicenseSnapshot, ...mission }) => ({
        ...mission,
        ownerUserId: actorProof.actors[mission.domain === 'schema' ? 'schema' : mission.domain === 'backend' ? 'api' : 'test'].userId,
      })),
    }),
  });
  const createdProject = projectResponse.project;
  projectPolicySourceDigest = createdProject.zonePolicy?.compiler?.sourceDigest || proofPolicySourceDigest;
  const schemaFlightSpec = agentFlightSpecs.find((spec) => spec.callsign === 'SCHEMA-01');
  if (schemaFlightSpec?.pilotLicenseSnapshot) {
    schemaFlightSpec.pilotLicenseSnapshot.sourceDigest = projectPolicySourceDigest;
  }
  const projectMembershipGrants = [];
  for (const actorKey of ['schema', 'api', 'test']) {
    const actor = actorProof.actors[actorKey];
    assertProof(actor?.userId, `proof actor ${actorKey} is missing a user id`);
    const memberResponse = await ownerApi(`/projects/${encodeURIComponent(createdProject.id)}/members`, {
      method: 'POST',
      body: JSON.stringify({
        userId: actor.userId,
        role: 'agent',
        permissions: ['project:read', 'project:write', 'agent:own', 'document:file', 'mayday:declare'],
        redactionPolicy: proofProjectRedactionPolicy(),
      }),
    });
    projectMembershipGrants.push({
      actorKey,
      userId: actor.userId,
      member: memberResponse.member,
    });
  }
  const agentRegistrations = [];
  for (const spec of agentFlightSpecs) {
    const actorKey = spec.domain === 'schema' ? 'schema' : spec.domain === 'backend' ? 'api' : 'test';
    const actorApi = actorKey === 'schema' ? schemaApi : actorKey === 'api' ? apiAgentApi : testApi;
    const sessionResponse = await actorApi(`/projects/${encodeURIComponent(createdProject.id)}/agent-sessions`, {
      method: 'POST',
      body: JSON.stringify({
        ownerUserId: actorProof.actors[actorKey].userId,
        displayCallsign: spec.callsign,
        agentProvider: codexRuntime.provider,
        agentRuntime: codexRuntime.runtime,
        providerSessionRef: spec.providerSessionRef,
        toolList: spec.permissions,
        dojoPilotLicenseRef: dojoProof.dojoProofCapsule.license_version,
        dojoProofRef: dojoProof.dojoProofCapsule.capsule_id,
        dojoEvidenceRefs: dojoProof.dojoProofCapsule.evidence_record_ids.map((id) => `dojo:evidence:${id}`),
        dojoDecisionDigest: digest({
          providerSessionRef: spec.providerSessionRef,
          callsign: spec.callsign,
          capsuleId: dojoProof.dojoProofCapsule.capsule_id,
        }),
        pilotLicenseSnapshot: spec.pilotLicenseSnapshot || {
          licenseLevel: 'VFR',
          licenseStatus: 'active',
          repoScope: slug,
          authorizedAirspace: spec.route,
          requiredRadar: spec.domain === 'inspection' ? ['tests'] : ['typecheck', 'tests'],
          earnedBy: ['dojo:full-workflow-checkride'],
        },
      }),
    });
    const planResponse = await actorApi(`/projects/${encodeURIComponent(createdProject.id)}/execution-plans`, {
      method: 'POST',
      body: JSON.stringify({
        agentSessionId: sessionResponse.agentSession.id,
        displayCallsign: spec.callsign,
        mission: spec.mission,
        domain: spec.domain,
        status: spec.status,
        route: spec.route,
        requestedTools: spec.requestedTools,
        abortConditions: ['required radar failed', 'tower reroute issued'],
      }),
    });
    agentRegistrations.push({
      spec,
      agentSession: sessionResponse.agentSession,
      executionPlan: planResponse.executionPlan,
    });
  }
  const refreshedProjectResponse = await ownerApi(`/projects/${encodeURIComponent(createdProject.id)}`);
  const project = refreshedProjectResponse.project;
  const schemaPlan = requireValue(agentRegistrations.find((entry) => entry.spec.callsign === 'SCHEMA-01')?.executionPlan, 'schema execution plan missing');
  const apiPlan = requireValue(agentRegistrations.find((entry) => entry.spec.callsign === 'API-02')?.executionPlan, 'api execution plan missing');
  const testPlan = requireValue(agentRegistrations.find((entry) => entry.spec.callsign === 'TEST-03')?.executionPlan, 'test execution plan missing');

  const schemaGovernancePermitResponse = await ownerApi(`/projects/${encodeURIComponent(createdProject.id)}/permits`, {
    method: 'POST',
    body: JSON.stringify({
      permitType: 'schema_work_permit',
      status: 'issued',
      title: 'Schema runway work permit for full workflow proof',
      executionPlanId: schemaPlan.id,
      displayCallsign: 'SCHEMA-01',
      allowedPaths: ['synthi/prisma/**'],
      affectedZones: ['schema'],
      contractRefs: ['auth.signup.schema.v1'],
      rationale: 'Permit the schema-first leader to enter restricted schema airspace after tower membership and execution-plan registration.',
      evidenceRefs: ['codesite:governance:full-workflow-schema-permit'],
    }),
  });
  const schemaGovernancePermit = schemaGovernancePermitResponse.permit;
  assertProof(schemaGovernancePermit?.id, 'schema governance permit was not issued before restricted-airspace clearance');

  const leaseResponse = await api(`/execution-plans/${encodeURIComponent(schemaPlan.id)}/mutation-leases`, {
    method: 'POST',
    body: JSON.stringify({
      allowedPaths: ['synthi/prisma/**'],
      blockedPaths: ['secrets/**'],
      allowedTools: ['file_write'],
      requiredRadar: ['typecheck', 'tests'],
      permitId: schemaGovernancePermit.id,
      ...dojoProof,
    }),
  });
  const lease = leaseResponse.mutationLease;
  const serializableSnapshotGate = await proveSerializableSnapshotGate({
    api,
    lease,
    readPath,
    changedPath,
    baseSnapshotEvidence: undercoveredSnapshotEvidence,
  });

  const transactionResponse = await api(`/mutation-leases/${encodeURIComponent(lease.id)}/transactions`, {
    method: 'POST',
    body: JSON.stringify({
      repoRoot: proofRepo.containerRoot,
      snapshotScope: 'repo_wide',
      readSet: [readPath],
      writeSet: [changedPath],
      invariants: ['clearance.diff.inside_route'],
    }),
  });
  const transaction = transactionResponse.transaction;
  const baseSnapshotEvidence = transaction.baseSnapshotEvidence;
  assertProof(baseSnapshotEvidence?.status === 'recorded' && baseSnapshotEvidence.scope === 'repo_wide', 'server-generated repo-wide base snapshot evidence is required for schema transaction');
  const assumptionResponse = await api(`/transactions/${encodeURIComponent(transaction.id)}/assumptions`, {
    method: 'POST',
    body: JSON.stringify({
      assumptionKey: 'auth.signup.schema.v1',
      dependsOn: [{ ref: 'auth.signup.schema', version: 'v1', path: readPath }],
      usedBy: ['synthi/src/app/api/auth/signup.ts'],
    }),
  });
  const apiLeaseResponse = await apiAgentApi(`/execution-plans/${encodeURIComponent(apiPlan.id)}/mutation-leases`, {
    method: 'POST',
    body: JSON.stringify({
      allowedPaths: ['synthi/src/app/api/auth/**'],
      blockedPaths: ['secrets/**'],
      allowedTools: ['file_write'],
      requiredRadar: ['tests'],
    }),
  });
  const apiLease = apiLeaseResponse.mutationLease;
  const apiTransactionResponse = await apiAgentApi(`/mutation-leases/${encodeURIComponent(apiLease.id)}/transactions`, {
    method: 'POST',
    body: JSON.stringify({
      repoRoot: proofRepo.containerRoot,
      snapshotScope: 'repo_wide',
      readSet: [changedPath],
      writeSet: ['synthi/src/app/api/auth/signup.ts'],
      invariants: ['schema.assumption.refresh_before_api_landing'],
    }),
  });
  const apiTransaction = apiTransactionResponse.transaction;
  const apiBaseSnapshotEvidence = apiTransaction.baseSnapshotEvidence;
  assertProof(apiBaseSnapshotEvidence?.status === 'recorded' && apiBaseSnapshotEvidence.scope === 'repo_wide', 'server-generated repo-wide base snapshot evidence is required for API transaction');
  const staleAssumptionResponse = await apiAgentApi(`/transactions/${encodeURIComponent(apiTransaction.id)}/assumptions`, {
    method: 'POST',
    body: JSON.stringify({
      assumptionKey: 'api.signup.depends_on_schema.v1',
      dependsOn: [{ ref: 'auth.signup.schema', version: 'v1', path: changedPath }],
      usedBy: ['synthi/src/app/api/auth/signup.ts'],
    }),
  });
  const shadowSimulation = await api(`/projects/${encodeURIComponent(project.id)}/shadow-merge-simulate`, {
    method: 'POST',
    body: JSON.stringify({
      strategies: ['schema_first', 'frontend_backend_parallel'],
      shadowJobRef: `shadow:${slug}:schema-first`,
      baseSnapshot: baseSnapshotEvidence.snapshotDigest,
      requireExternalRunnerEvidence: true,
      proofMaturity: 'mature',
      shadowExecutionPlan: proofShadowExecutionPlan(proofRepo, changedPath),
    }),
  });
  const counterfactualResponse = await api(`/projects/${encodeURIComponent(project.id)}/counterfactual-runs`, {
    method: 'POST',
    body: JSON.stringify({
      shadowJobRef: `shadow:${slug}:counterfactual-choice`,
      baseSnapshot: baseSnapshotEvidence.snapshotDigest,
      universes: [
        {
          universe: 'schema-first',
          result: 'passed',
          route: [changedPath],
          inspectionCost: 3,
          staleAssumptions: 0,
          reasonCodes: ['schema_first_contract_landed'],
        },
        {
          universe: 'frontend-backend-parallel',
          result: 'near_miss',
          route: [changedPath, 'synthi/src/app/api/auth/**'],
          inspectionCost: 8,
          staleAssumptions: 2,
          reasonCodes: ['parallel_schema_contract_near_miss'],
        },
      ],
      arbiterVerdict: {
        selected: 'schema-first',
        verdict: 'schema-first',
        reasonCodes: ['avoid_parallel_schema_contract_near_miss'],
        policyDeltaCandidates: [{
          rule: 'schema_contract_first_before_api_parallelism',
          preferredStrategies: ['schema_first'],
          avoidStrategies: ['frontend_backend_parallel'],
          affectedRoutes: [changedPath, 'synthi/src/app/api/auth/**'],
          requiredTowerActions: ['refresh_downstream_assumptions', 'hold_dependent_api_until_schema_lands'],
          expectedRiskReduction: 0.31,
          confidence: 0.84,
        }],
      },
      validityStrength: 'strong',
      evidenceRefs: ['codesite:shadow:full-workflow-counterfactual'],
    }),
  });
  const counterfactualProjectForPromotion = await api(`/projects/${encodeURIComponent(project.id)}`);
  const proposedPolicyDelta = requireValue(
    asArray(counterfactualProjectForPromotion.project?.policyDeltas).find((delta) => (
      delta.promotionState === 'proposed'
      && asArray(delta.replayRefs).some((ref) => String(ref).includes(counterfactualResponse.counterfactualRun.id))
    )),
    'proposed counterfactual policy delta missing before promotion',
  );
  const promotedPolicyDeltaResponse = await api(`/projects/${encodeURIComponent(project.id)}/policy-deltas/${encodeURIComponent(proposedPolicyDelta.id)}/promote`, {
    method: 'POST',
    body: JSON.stringify({
      targetState: 'active',
      validationStatus: 'validated',
      reviewedBy: actorProof.actors.owner.userId,
      replayRefs: [`codesite:counterfactual-run:${counterfactualResponse.counterfactualRun.id}`],
      evidenceRefs: [
        'codesite:counterfactual-policy-validation:full-workflow',
        `codesite:shadow:${slug}:counterfactual-choice`,
      ],
    }),
  });
  const learnedPolicySimulation = await api(`/projects/${encodeURIComponent(project.id)}/shadow-merge-simulate`, {
    method: 'POST',
    body: JSON.stringify({
      strategies: ['schema_first', 'frontend_backend_parallel'],
      shadowJobRef: `shadow:${slug}:learned-policy-memory`,
      baseSnapshot: baseSnapshotEvidence.snapshotDigest,
      requireExternalRunnerEvidence: true,
      proofMaturity: 'mature',
      shadowExecutionPlan: proofShadowExecutionPlan(proofRepo, changedPath),
    }),
  });
  const rfiResponse = await api(`/projects/${encodeURIComponent(project.id)}/documents`, {
    method: 'POST',
    body: JSON.stringify({
      kind: 'rfi',
      title: 'Confirm schema-first contract before API route',
      fromSessionId: schemaPlan.agentSessionId,
      fromCallsign: 'SCHEMA-01',
      toSessionId: apiPlan.agentSessionId,
      requiresResponse: true,
      blocking: true,
      executionPlanId: schemaPlan.id,
      mutationLeaseId: lease.id,
      transactionId: transaction.id,
      affectedZones: [changedPath],
      contractRefs: [readPath],
      body: {
        question: 'Confirm API flight will hold until auth.signup.schema.v1 lands.',
        proposedContract: readPath,
        transactionId: transaction.id,
      },
    }),
  });
  const apiInbox = await apiAgentApi(`/agent-sessions/${encodeURIComponent(apiPlan.agentSessionId)}/inbox`);
  const rfiInboxItem = requireValue(
    apiInbox.inbox.find((item) => item.documentId === rfiResponse.document.id),
    'RFI inbox item missing for API-02',
  );
  const rfiAck = await apiAgentApi(`/agent-sessions/${encodeURIComponent(apiPlan.agentSessionId)}/inbox/${encodeURIComponent(rfiInboxItem.eventId)}`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  const changeOrderResponse = await apiAgentApi(`/projects/${encodeURIComponent(project.id)}/documents`, {
    method: 'POST',
    body: JSON.stringify({
      kind: 'change_order',
      title: 'API flight accepts schema-first hold',
      fromSessionId: apiPlan.agentSessionId,
      fromCallsign: 'API-02',
      toSessionId: schemaPlan.agentSessionId,
      requiresResponse: false,
      executionPlanId: apiPlan.id,
      mutationLeaseId: lease.id,
      transactionId: transaction.id,
      affectedZones: [changedPath],
      contractRefs: [readPath],
      body: {
        answerToDocumentId: rfiResponse.document.id,
        decision: 'accepted',
        towerInstruction: 'API-02 remains holding until SCHEMA-01 proof bundle lands.',
      },
    }),
  });
  const schemaInbox = await schemaApi(`/agent-sessions/${encodeURIComponent(schemaPlan.agentSessionId)}/inbox`);
  const changeOrderInboxItem = requireValue(
    schemaInbox.inbox.find((item) => item.documentId === changeOrderResponse.document.id),
    'change-order inbox item missing for SCHEMA-01',
  );
  const changeOrderAck = await schemaApi(`/agent-sessions/${encodeURIComponent(schemaPlan.agentSessionId)}/inbox/${encodeURIComponent(changeOrderInboxItem.eventId)}`, {
    method: 'POST',
    body: JSON.stringify({}),
  });

  const codesiteContext = {
    active: true,
    required: true,
    managedAgent: true,
    workspaceSlug: slug,
    transactionId: transaction.id,
    mutationLeaseId: lease.id,
    displayCallsign: 'SCHEMA-01',
    allowedTools: ['file_write'],
    controlPlaneUrl: api.baseUrl,
    controlPlaneTrusted: true,
    processAncestry: ['mcp:synthi_codesite_apply_patch', 'codex:tmp-proof-session'],
  };
  const codesiteFs = createCodeSiteFS(codesiteContext, {
    fetch: proofFetch,
    repoRoot: proofRepo.hostRoot,
    requireAuthoritativeContext: true,
  });
  const managedRead = await codesiteFs.read({
    path: readPath,
    tool: 'file_read',
    kind: 'schema-contract-read',
    evidenceRefs: ['mcp:audit:read-full-workflow'],
    processAncestry: ['mcp:synthi_codesite_read_file', 'codex:tmp-proof-session'],
  }, async () => fs.promises.readFile(path.join(proofRepo.hostRoot, readPath), 'utf8'));
  assertProof(
    managedRead.phase === 'read'
      && managedRead.disposition === 'read_observed'
      && managedRead.readResult.trim() === 'schema-contract-read-v1',
    'CodeSiteFS managed read did not record the schema contract read',
  );
  let deniedApplyCalled = false;
  let deniedError = null;
  try {
    await codesiteFs.apply({
      path: 'secrets/prod.env',
      tool: 'file_write',
      kind: 'raw-terminal-write',
      evidenceRefs: ['mcp:audit:codesitefs-denied-full-workflow'],
    }, async () => {
      deniedApplyCalled = true;
      await fs.promises.mkdir(path.join(proofRepo.hostRoot, 'secrets'), { recursive: true });
      await fs.promises.writeFile(path.join(proofRepo.hostRoot, 'secrets/prod.env'), 'DATABASE_URL=postgres://prod\n', 'utf8');
    });
  } catch (error) {
    deniedError = error;
  }
  assertProof(deniedError?.code === 'CODESITE_WRITE_DENIED', 'CodeSiteFS denied write did not fail closed');

  const quarantine = await createCodeSiteQuarantineWorkspace(codesiteContext, proofRepo.hostRoot, {
    baseDir: path.join(dir, 'codesite-full-workflow-quarantine'),
    operation: 'raw_terminal',
  });
  const realContentBeforeQuarantine = await fs.promises.readFile(path.join(proofRepo.hostRoot, changedPath), 'utf8');
  const realContentBeforeQuarantineDigest = digest(realContentBeforeQuarantine);
  const quarantinedContent = proofRepo.after.replace('AuditEvent', 'QuarantinedAuditEvent');
  const overlayMutation = await run(process.execPath, [
    '-e',
    `require('fs').writeFileSync(${JSON.stringify(changedPath)}, ${JSON.stringify(quarantinedContent)}, 'utf8')`,
  ], { cwd: quarantine.cwd });
  const realContentAfterOverlayMutation = await fs.promises.readFile(path.join(proofRepo.hostRoot, changedPath), 'utf8');
  const realContentAfterOverlayMutationDigest = digest(realContentAfterOverlayMutation);
  const overlayContentAfterMutation = await fs.promises.readFile(path.join(quarantine.cwd, changedPath), 'utf8');
  const runtimeBoundary = {
    terminalHostMode: codeSiteTerminalLaunchMode({
      codeSiteContext: codesiteContext,
      workspaceSlug: slug,
    }),
    terminalContainerMode: codeSiteTerminalLaunchMode({
      codeSiteContext: codesiteContext,
      enableContainerRuntime: true,
      workspaceRuntime: { proof: true },
      workspaceSlug: slug,
    }),
    terminalRuntimePodMode: codeSiteTerminalLaunchMode({
      codeSiteContext: codesiteContext,
      usesRuntimePodTerminal: true,
      workspaceSlug: slug,
    }),
    terminalRuntimePodWithOverlayMode: codeSiteTerminalLaunchMode({
      codeSiteContext: codesiteContext,
      usesRuntimePodTerminal: true,
      enableContainerRuntime: true,
      workspaceRuntime: { proof: true },
      workspaceSlug: slug,
    }),
    programHeadlessMode: codeSiteProgramRuntimeLaunchMode({
      codeSiteContext: codesiteContext,
      runtimeType: 'web',
      sysboxEnabled: false,
      hasHybrid: false,
    }),
    programHybridMode: codeSiteProgramRuntimeLaunchMode({
      codeSiteContext: codesiteContext,
      runtimeType: 'container',
      sysboxEnabled: false,
      hasHybrid: true,
    }),
    programRuntimePodMode: codeSiteProgramRuntimeLaunchMode({
      codeSiteContext: codesiteContext,
      runtimeType: 'container',
      sysboxEnabled: true,
      hasHybrid: false,
    }),
    programRuntimePodWithOverlayMode: codeSiteProgramRuntimeLaunchMode({
      codeSiteContext: codesiteContext,
      runtimeType: 'container',
      sysboxEnabled: true,
      hasHybrid: true,
    }),
    rawShellOverlay: {
      scenario: 'unmanaged-terminal-write-through-quarantine-overlay',
      executable: process.execPath,
      command: 'node -e fs.writeFileSync(path, content)',
      attemptedPath: changedPath,
      cwd: path.relative(repoRoot(), quarantine.cwd).split(path.sep).join('/'),
      stdout: overlayMutation.stdout.trim(),
      stderr: overlayMutation.stderr.trim(),
      realRepoUnchangedBeforeFinalize: realContentAfterOverlayMutation === realContentBeforeQuarantine,
      realRepoDigestBefore: realContentBeforeQuarantineDigest,
      realRepoDigestAfterOverlayWrite: realContentAfterOverlayMutationDigest,
      overlayDigestAfterWrite: digest(overlayContentAfterMutation),
      overlayOnlyMutationObserved: overlayContentAfterMutation === quarantinedContent,
    },
    unmanagedTerminalWriteBoundary: {
      outcome: 'quarantined_before_real_repo_mutation',
      attemptedPath: changedPath,
      hostTerminalMode: 'block-host',
      runtimeTerminalMode: 'overlay-runtime',
      realRepoUnchangedBeforeFinalize: realContentAfterOverlayMutation === realContentBeforeQuarantine,
      overlayOnlyMutationObserved: overlayContentAfterMutation === quarantinedContent,
    },
  };
  runtimeAttestations = await writeRuntimeBoundaryAttestations(runPaths.runDir, {
    slug,
    project,
    transaction,
    lease,
    runtimeBoundary,
  });
  const quarantineResult = await finalizeCodeSiteQuarantineWorkspace(codesiteContext, quarantine, {
    fetch: proofFetch,
    cleanup: true,
  });
  const quarantinedRecord = quarantineResult.recorded.find((item) => item.path === changedPath);
  const lineProvenance = deriveLineProvenanceFromContentChange(changedPath, proofRepo.before, proofRepo.after, {
    reasonRef: `change_order:${changeOrderResponse.document.id}`,
    evidenceRefs: [
      'mcp:audit:write-full-workflow',
      `codesite:document:${rfiResponse.document.id}`,
      `codesite:document:${changeOrderResponse.document.id}`,
      `codesite:inbox:${rfiAck.inboxItem.id}`,
      `codesite:inbox:${changeOrderAck.inboxItem.id}`,
      `codesite:assumption:${assumptionResponse.assumption.id}`,
      `codesite:assumption:${staleAssumptionResponse.assumption.id}`,
      `codesite:counterfactual-run:${counterfactualResponse.counterfactualRun.id}`,
    ],
    processAncestry: ['mcp:synthi_codesite_apply_patch', 'codex:tmp-proof-session'],
    promptSummary: 'Land schema-first full workflow proof',
  }).map((row) => ({
    ...row,
    dojoSourceRefs: [
      `dojo:proof:${lease.dojoProofRef}`,
      `dojo:decision:${lease.dojoDecisionDigest}`,
      ...asArray(lease.dojoEvidenceRefs || []),
    ].filter(Boolean),
  }));
  const allowedApply = await codesiteFs.apply({
    path: changedPath,
    tool: 'file_write',
    kind: 'write-file',
    lineProvenance,
    evidenceRefs: [
      'mcp:audit:write-full-workflow',
      `codesite:document:${changeOrderResponse.document.id}`,
      `codesite:counterfactual-run:${counterfactualResponse.counterfactualRun.id}`,
    ],
    processAncestry: ['mcp:synthi_codesite_apply_patch', 'codex:tmp-proof-session'],
  }, async () => {
    await fs.promises.writeFile(path.join(proofRepo.hostRoot, changedPath), proofRepo.after, 'utf8');
    return { bytesWritten: Buffer.byteLength(proofRepo.after, 'utf8') };
  });
  const writeResponse = allowedApply.eventRecord;
  const apiAbortResponse = await apiAgentApi(`/transactions/${encodeURIComponent(apiTransaction.id)}/abort`, {
    method: 'POST',
    body: JSON.stringify({ reason: 'schema_contract_refreshed_assumption_invalidated' }),
  });
  const landingCommit = await gitCommitAll(proofRepo, 'Land schema-first CodeSite proof');
  const repoState = await collectCodeSiteRepoState(proofRepo.hostRoot, {
    workspaceSlug: slug,
    transactionId: transaction.id,
    baseSnapshot: baseSnapshotEvidence.snapshotDigest,
    writePaths: [changedPath],
    env: proofRepo.gitEnv,
  });

  const inspectionResponse = await testApi(`/projects/${encodeURIComponent(project.id)}/inspection-runs`, {
    method: 'POST',
    body: JSON.stringify({
      executionPlanId: schemaPlan.id,
      displayCallsign: 'SCHEMA-01',
      changedPaths: [changedPath],
      execute: true,
      repoRoot: proofRepo.containerRoot,
      commands: [
        { key: 'typecheck', command: 'npm', args: ['run', 'typecheck'], timeoutMs: 60000 },
        { key: 'tests', command: 'npm', args: ['test'], timeoutMs: 60000 },
      ],
      inspectionSignals: [{
        key: 'governance',
        status: 'passed',
        evidenceRefs: [
          `codesite:permit:${schemaGovernancePermit.id}`,
          'codesite:governance:full-workflow-schema-permit',
        ],
        reasonCodes: ['governance_clearance_evidence_verified'],
      }],
      evidenceRefs: [
        'runtime:event:inspection-full-workflow',
        `codesite:permit:${schemaGovernancePermit.id}`,
      ],
    }),
  });
  const schemaLandingHealthResponse = await testApi(`/projects/${encodeURIComponent(project.id)}/inspection-runs`, {
    method: 'POST',
    body: JSON.stringify({
      executionPlanId: schemaPlan.id,
      displayCallsign: 'SCHEMA-01',
      status: 'passed',
      changedPaths: [changedPath],
      inspectionSignals: [{ key: 'landing-health', status: 'passed', evidenceRefs: ['codesite:landing:passed-health-proof'] }],
      evidenceRefs: ['codesite:landing:passed-health-proof'],
    }),
  });
  const currentPilotSessionResponse = await schemaApi(`/projects/${encodeURIComponent(project.id)}/agent-sessions`, {
    method: 'POST',
    body: JSON.stringify({
      ownerUserId: actorProof.actors.schema.userId,
      displayCallsign: 'CURRENT-04',
      agentProvider: 'codesite-proof-harness',
      agentRuntime: 'pilot-license-current-source-proof',
      providerSessionRef: `codesite-health:${slug}:source-current`,
      permissions: ['synthi_codesite_request_landing'],
      dojoPilotLicenseRef: dojoProof.dojoProofCapsule.license_version,
      dojoProofRef: dojoProof.dojoProofCapsule.capsule_id,
      dojoEvidenceRefs: ['dojo:evidence:source-current-checkride'],
      dojoDecisionDigest: digest({ slug, callsign: 'CURRENT-04', scenario: 'source-current' }),
      pilotLicenseSnapshot: {
        licenseLevel: 'IFR',
        licenseStatus: 'active',
        repoScope: slug,
        authorizedAirspace: ['synthi/prisma/**'],
        requiredRadar: ['typecheck', 'tests'],
        earnedBy: ['dojo:evidence:source-current-checkride'],
        expiresOn: ['source_drift'],
        sourceDigest: projectPolicySourceDigest,
        evidenceRefs: ['dojo:evidence:source-current-checkride'],
      },
    }),
  });
  const currentPilotPlanResponse = await schemaApi(`/projects/${encodeURIComponent(project.id)}/execution-plans`, {
    method: 'POST',
    body: JSON.stringify({
      agentSessionId: currentPilotSessionResponse.agentSession.id,
      displayCallsign: 'CURRENT-04',
      mission: 'Exercise current source pilot health',
      domain: 'schema',
      status: 'preflight',
      route: ['synthi/prisma/**'],
      requestedTools: ['npm_test'],
    }),
  });
  const currentPilotLandingResponse = await testApi(`/projects/${encodeURIComponent(project.id)}/inspection-runs`, {
    method: 'POST',
    body: JSON.stringify({
      executionPlanId: currentPilotPlanResponse.executionPlan.id,
      displayCallsign: 'CURRENT-04',
      status: 'passed',
      changedPaths: [changedPath],
      inspectionSignals: [{ key: 'landing-health', status: 'passed', evidenceRefs: ['codesite:landing:current-source-proof'] }],
      evidenceRefs: ['codesite:landing:current-source-proof'],
    }),
  });
  const stalePilotSessionResponse = await schemaApi(`/projects/${encodeURIComponent(project.id)}/agent-sessions`, {
    method: 'POST',
    body: JSON.stringify({
      ownerUserId: actorProof.actors.schema.userId,
      displayCallsign: 'DRIFT-04',
      agentProvider: 'codesite-proof-harness',
      agentRuntime: 'pilot-license-source-drift-proof',
      providerSessionRef: `codesite-health:${slug}:source-drift`,
      permissions: ['synthi_codesite_request_clearance'],
      dojoPilotLicenseRef: dojoProof.dojoProofCapsule.license_version,
      dojoProofRef: dojoProof.dojoProofCapsule.capsule_id,
      dojoEvidenceRefs: ['dojo:evidence:source-drift-checkride'],
      dojoDecisionDigest: digest({ slug, callsign: 'DRIFT-04', scenario: 'source-drift' }),
      pilotLicenseSnapshot: {
        licenseLevel: 'IFR',
        licenseStatus: 'active',
        repoScope: slug,
        authorizedAirspace: ['synthi/prisma/**'],
        requiredRadar: ['typecheck', 'tests'],
        earnedBy: ['dojo:evidence:source-drift-checkride'],
        expiresOn: ['source_drift'],
        sourceDigest: `sha256:${'0'.repeat(64)}`,
        evidenceRefs: ['dojo:evidence:source-drift-checkride'],
      },
    }),
  });
  const stalePilotPlanResponse = await schemaApi(`/projects/${encodeURIComponent(project.id)}/execution-plans`, {
    method: 'POST',
    body: JSON.stringify({
      agentSessionId: stalePilotSessionResponse.agentSession.id,
      displayCallsign: 'DRIFT-04',
      mission: 'Attempt stale source clearance',
      domain: 'schema',
      status: 'preflight',
      route: ['synthi/prisma/**'],
      requestedTools: ['file_write'],
    }),
  });
  const stalePilotLeaseResponse = await schemaApi(`/execution-plans/${encodeURIComponent(stalePilotPlanResponse.executionPlan.id)}/mutation-leases`, {
    method: 'POST',
    body: JSON.stringify({
      allowedPaths: ['synthi/prisma/**'],
      requiredRadar: ['typecheck', 'tests'],
      ...dojoProof,
    }),
  });
  const violationPilotSessionResponse = await testApi(`/projects/${encodeURIComponent(project.id)}/agent-sessions`, {
    method: 'POST',
    body: JSON.stringify({
      ownerUserId: actorProof.actors.test.userId,
      displayCallsign: 'VIOLATION-05',
      agentProvider: 'codesite-proof-harness',
      agentRuntime: 'pilot-license-violation-proof',
      providerSessionRef: `codesite-health:${slug}:violation`,
      permissions: ['synthi_codesite_request_landing'],
      dojoPilotLicenseRef: dojoProof.dojoProofCapsule.license_version,
      dojoProofRef: dojoProof.dojoProofCapsule.capsule_id,
      dojoEvidenceRefs: ['dojo:evidence:landing-health-checkride'],
      dojoDecisionDigest: digest({ slug, callsign: 'VIOLATION-05', scenario: 'landing-health' }),
      pilotLicenseSnapshot: {
        licenseLevel: 'IFR',
        licenseStatus: 'active',
        repoScope: slug,
        authorizedAirspace: ['synthi/prisma/**'],
        requiredRadar: ['security', 'tests'],
        earnedBy: ['dojo:evidence:landing-health-checkride'],
        expiresOn: ['source_drift'],
        sourceDigest: projectPolicySourceDigest,
        evidenceRefs: ['dojo:evidence:landing-health-checkride'],
      },
    }),
  });
  const violationPilotPlanResponse = await testApi(`/projects/${encodeURIComponent(project.id)}/execution-plans`, {
    method: 'POST',
    body: JSON.stringify({
      agentSessionId: violationPilotSessionResponse.agentSession.id,
      displayCallsign: 'VIOLATION-05',
      mission: 'Exercise failed landing health',
      domain: 'inspection',
      status: 'holding',
      route: ['synthi/prisma/**'],
      requestedTools: ['npm_test'],
    }),
  });
  const violationLandingOne = await testApi(`/projects/${encodeURIComponent(project.id)}/inspection-runs`, {
    method: 'POST',
    body: JSON.stringify({
      executionPlanId: violationPilotPlanResponse.executionPlan.id,
      displayCallsign: 'VIOLATION-05',
      status: 'failed',
      changedPaths: [changedPath],
      inspectionSignals: [{ key: 'security', status: 'failed', evidenceRefs: ['security:failed:violation-proof-1'] }],
      evidenceRefs: ['security:failed:violation-proof-1'],
    }),
  });
  const violationLandingTwo = await testApi(`/projects/${encodeURIComponent(project.id)}/inspection-runs`, {
    method: 'POST',
    body: JSON.stringify({
      executionPlanId: violationPilotPlanResponse.executionPlan.id,
      displayCallsign: 'VIOLATION-05',
      status: 'failed',
      changedPaths: [changedPath],
      inspectionSignals: [{ key: 'tests', status: 'failed', evidenceRefs: ['test:failed:violation-proof-2'] }],
      evidenceRefs: ['test:failed:violation-proof-2'],
    }),
  });
  const violationIncidentResponse = await testApi(`/projects/${encodeURIComponent(project.id)}/incidents`, {
    method: 'POST',
    body: JSON.stringify({
      category: 'security',
      severity: 'critical',
      participants: ['VIOLATION-05'],
      affectedZones: [changedPath],
      evidenceRefs: ['codesite:incident:critical-violation-proof'],
      body: { reasonCodes: ['security_policy_violation', 'entered_no_fly_zone'] },
    }),
  });
  const agentExecutionEvidence = await generateAgentExecutionEvidence({
    dir,
    slug,
    projectId: project.id,
    proofRepo,
    agentFlightSpecs,
    agentRegistrations,
    workflowContext: {
      project,
      lease,
      transaction,
      schemaAssumption: assumptionResponse.assumption,
      staleAssumption: staleAssumptionResponse.assumption,
      apiLease,
      apiTransaction,
      apiAbort: apiAbortResponse.transaction,
      rfiDocument: rfiResponse.document,
      rfiInboxItem,
      rfiAck: rfiAck.inboxItem,
      changeOrderDocument: changeOrderResponse.document,
      changeOrderInboxItem,
      changeOrderAck: changeOrderAck.inboxItem,
      inspectionRun: inspectionResponse.inspectionRun,
      counterfactualRun: counterfactualResponse.counterfactualRun,
      changedPath,
      readPath,
      patch: {
        afterSha256: sha256Text(proofRepo.after),
        reasonRef: `change_order:${changeOrderResponse.document.id}`,
        evidenceRefs: [
          `codesite:document:${rfiResponse.document.id}`,
          `codesite:document:${changeOrderResponse.document.id}`,
          `codesite:counterfactual-run:${counterfactualResponse.counterfactualRun.id}`,
        ],
      },
      documentCount: 2,
      inboxItemCount: 2,
    },
  });
  assertProof(
    agentExecutionEvidence.missingCallsigns.length === 0,
    `missing Codex execution evidence for ${agentExecutionEvidence.missingCallsigns.join(', ')}: ${JSON.stringify(agentExecutionEvidence.records.map((record) => ({
      callsign: record.callsign,
      providerSessionRef: record.providerSessionRef,
      validForProof: record.validForProof,
      validationErrors: record.validationErrors,
    })))}`
  );

  const commitResponse = await api(`/transactions/${encodeURIComponent(transaction.id)}/commit`, {
    method: 'POST',
    body: JSON.stringify({
      commitSha: landingCommit.sha,
      repoState,
      evidenceRefs: [
        'mcp:audit:commit-full-workflow',
        `git:commit:${landingCommit.sha}`,
        ...runtimeAttestations.map((attestation) => `codesite:runtime-attestation:${attestation.digest}`),
      ],
    }),
  });
  assertProof(commitResponse.transaction?.status === 'committed', `transaction did not commit: ${JSON.stringify(commitResponse)}`);

  let proofBundle = commitResponse.proofBundle;
  const trailerCommit = await gitAmendHead(proofRepo, commitMessageWithTrailers('Land schema-first CodeSite proof', proofBundle.trailers));
  assertProof(landingCommit.tree === trailerCommit.tree, 'trailer commit changed the landed file tree');
  assertProof(commitMessageContainsTrailers(trailerCommit.message, proofBundle.trailers), 'final git commit does not contain CodeSite trailers');
  const attachedProofBundle = await api(`/proof-bundles/${encodeURIComponent(proofBundle.id)}/commit`, {
    method: 'POST',
    body: JSON.stringify({
      commitSha: trailerCommit.sha,
      commitMessage: trailerCommit.message,
      trailers: proofBundle.trailers,
      evidenceRefs: [`git:commit:${landingCommit.sha}`, `git:commit:${trailerCommit.sha}`],
    }),
  });
  proofBundle = attachedProofBundle.proofBundle;

  const exported = await api(`/projects/${encodeURIComponent(project.id)}/artifacts/export`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  const [projectAfter, controlState, events] = await Promise.all([
    api(`/projects/${encodeURIComponent(project.id)}`),
    api(`/projects/${encodeURIComponent(project.id)}/control-state`),
    api(`/projects/${encodeURIComponent(project.id)}/events`),
  ]);
  const lineRows = projectAfter.project.lineProvenance || [];
  const documents = projectAfter.project.documents || [];
  const inboxItems = projectAfter.project.inboxItems || [];
  const assumptions = projectAfter.project.assumptions || [];
  const schemaAssumption = assumptions.find((item) => item.id === assumptionResponse.assumption.id) || assumptionResponse.assumption;
  const staleAssumption = assumptions.find((item) => item.id === staleAssumptionResponse.assumption.id) || staleAssumptionResponse.assumption;
  const counterfactualRuns = projectAfter.project.counterfactualRuns || [];
  const policyDeltas = projectAfter.project.policyDeltas || [];
  const agentSessions = projectAfter.project.agentSessions || [];
  const executionPlans = projectAfter.project.executionPlans || [];
  const pilotLicenseHealthRecords = controlState.pilotLicenseHealth || [];
  const schemaPilotHealth = pilotLicenseHealthRecords.find((record) => record.displayCallsign === 'SCHEMA-01') || null;
  const currentPilotHealth = pilotLicenseHealthRecords.find((record) => record.displayCallsign === 'CURRENT-04') || null;
  const stalePilotHealth = pilotLicenseHealthRecords.find((record) => record.displayCallsign === 'DRIFT-04') || null;
  const violationPilotHealth = pilotLicenseHealthRecords.find((record) => record.displayCallsign === 'VIOLATION-05') || null;
  const inspectedLineRow = lineRows.find((row) => row.filePath === changedPath) || lineRows[0] || null;
  const lineInspectorRows = inspectedLineRow
    ? (await api(`/provenance/line?projectId=${encodeURIComponent(project.id)}&filePath=${encodeURIComponent(inspectedLineRow.filePath)}&lineAnchor=${encodeURIComponent(inspectedLineRow.lineAnchor)}&lineNumber=${encodeURIComponent(inspectedLineRow.startLine || 1)}`)).lineProvenance || []
    : [];
  const exportPaths = (exported.files || []).map((file) => (
    typeof file === 'string' ? file : file.relativePath || file.path
  )).filter(Boolean);
  const eventTypes = events.events.map((event) => event.eventType);
  const verifier = await runVerifier({
    proofBundle,
    exportPaths,
    slug,
    repoRoot: proofRepo.hostRoot,
    commitSha: proofBundle.commitSha,
  });
  const counterfactualRunRef = `codesite:counterfactual-run:${counterfactualResponse.counterfactualRun.id}`;
  const counterfactualRunRecorded = counterfactualRuns.some((run) => (
    run.id === counterfactualResponse.counterfactualRun.id
    || run.counterfactualRunId === counterfactualResponse.counterfactualRun.id
    || run.counterfactual_run_id === counterfactualResponse.counterfactualRun.id
    || run.shadowJobRef === counterfactualResponse.counterfactualRun.shadowJobRef
    || asArray(run.evidenceRefs).some((ref) => String(ref).includes(counterfactualResponse.counterfactualRun.id))
  ));
  const counterfactualPolicyDeltaRefsRun = policyDeltas.some((delta) => (
    asArray(delta.replayRefs).some((ref) => String(ref).includes(counterfactualResponse.counterfactualRun.id))
    || asArray(delta.evidenceRefs).some((ref) => String(ref).includes(counterfactualResponse.counterfactualRun.id))
  ));
  const artifactPathHistoryPath = verifier.artifactRoot
    ? path.join(verifier.artifactRoot, 'artifact-path-history.jsonl')
    : null;
  const artifactPathHistory = artifactPathHistoryPath && fs.existsSync(artifactPathHistoryPath)
    ? fs.readFileSync(artifactPathHistoryPath, 'utf8')
    : '';
  const exportedAgentSessionPaths = exportPaths.filter((item) => item.endsWith('/agent-session.json'));
  const exportedAgentSessions = verifier.artifactRoot
    ? exportedAgentSessionPaths.map((relativePath) => ({
      path: relativePath,
      json: JSON.parse(fs.readFileSync(path.join(verifier.artifactRoot, relativePath), 'utf8')),
    }))
    : [];
  const expectedAgentSessionRefs = agentFlightSpecs.map((spec) => spec.providerSessionRef);
  const browserShot = runPaths.browserShot;
  const browserProofSectionShot = runPaths.browserProofSectionShot;
  const browserCoordinationShot = runPaths.browserCoordinationShot;
  const browserLineInspectorShot = runPaths.browserLineInspectorShot;
  const browserHandoverShot = runPaths.browserHandoverShot;
  const browserMobileShot = runPaths.browserMobileShot;
  const blackBoxIncident = (projectAfter.project.incidents || []).find((incident) => (
    incident.category === 'black_box'
    && incident.replayDigest
    && incident.replayDigest === proofBundle.incidentReplayDigest
  ));
  const blackBoxReplay = blackBoxIncident
    ? await api(`/incidents/${encodeURIComponent(blackBoxIncident.id)}/replay`)
    : null;
  const blackBoxMissingEventTypes = missingEventTypes(blackBoxReplay);
  const browserProof = await screenshotLiveUi({
    baseUrl,
    slug,
    pngPath: browserShot,
    proofSectionPngPath: browserProofSectionShot,
    coordinationPngPath: browserCoordinationShot,
    lineInspectorPngPath: browserLineInspectorShot,
    handoverPngPath: browserHandoverShot,
    mobilePngPath: browserMobileShot,
    authCookie: actorProof.actors.owner.authCookie,
  });
  const browserArtifactValidation = await validateProofArtifacts({
    slug,
    runStartedAt,
    visualPaths: [
      browserShot,
      browserProofSectionShot,
      browserCoordinationShot,
      browserLineInspectorShot,
      browserHandoverShot,
      browserMobileShot,
    ],
  });
  assertProof(browserArtifactValidation.ok, `browser visual proof failed validation: ${JSON.stringify(browserArtifactValidation.invalidArtifacts)}`);
  const inspectionSignals = Array.isArray(inspectionResponse.inspectionRun?.inspectionSignals)
    ? inspectionResponse.inspectionRun.inspectionSignals
    : [];
  const typecheckInspectionExecuted = inspectionSignals.some((signal) => (
    signal?.source === 'codesite_inspection_executor'
    && ['typecheck', 'type'].includes(String(signal.key || signal.adapter?.key || ''))
    && signal.command?.executable === 'npm'
    && asArray(signal.command?.args).includes('typecheck')
    && Array.isArray(signal.evidenceRefs)
    && signal.evidenceRefs.some((ref) => String(ref).startsWith('typecheck:run:'))
  ));
  const testsInspectionExecuted = inspectionSignals.some((signal) => (
    signal?.source === 'codesite_inspection_executor'
    && ['tests', 'test'].includes(String(signal.key || signal.adapter?.key || ''))
    && signal.command?.executable === 'npm'
    && asArray(signal.command?.args).includes('test')
    && Array.isArray(signal.evidenceRefs)
    && signal.evidenceRefs.some((ref) => String(ref).startsWith('test:run:'))
  ));

  const [gitHead, proofScriptSha256] = await Promise.all([
    currentGitHead(),
    fileSha256(fileURLToPath(import.meta.url)),
  ]);
  const proof = {
    schemaVersion: 'synthi.codesite.fullWorkflowProof.v1',
    generatedAt: new Date().toISOString(),
    runStartedAt: runStartedAt.toISOString(),
    baseUrl,
    slug,
    run: {
      status: 'validated_before_publication',
      runDir: relativeProofPath(runPaths.runDir),
      gitHead,
      proofScript: relativeProofPath(fileURLToPath(import.meta.url)),
      proofScriptSha256,
      legacyTopLevelArtifactsInvalidatedAtStart: true,
    },
    project: {
      id: project.id,
      title: project.title,
      route: `/workspace/${slug}/codesite`,
    },
    auth: {
      mode: actorProof.mode,
      seededWorkspaceSlug: slug,
      workspace: actorProof.workspace,
      projectMembershipGrants,
      actors: Object.fromEntries(Object.entries(actorProof.actors).map(([key, actor]) => [key, {
        email: actor.email,
        userId: actor.userId,
        role: actor.role,
      }])),
    },
    codexRuntime,
    agentWorkflow: {
      expectedProviderSessionRefs: expectedAgentSessionRefs,
      registrations: agentRegistrations.map((entry) => ({
        callsign: entry.spec.callsign,
        providerSessionRef: entry.spec.providerSessionRef,
        agentSessionId: entry.agentSession.id,
        executionPlanId: entry.executionPlan.id,
        permissions: entry.agentSession.permissions,
        requestedTools: entry.executionPlan.requestedTools,
      })),
      agentSessions,
      executionPlans,
      exportedAgentSessionPaths,
      exportedAgentSessions,
      executionEvidenceDir: agentExecutionEvidence.evidenceDir,
      executionEvidence: agentExecutionEvidence.records.map((record) => ({
        path: record.path,
        callsign: record.callsign,
        providerSessionRef: record.providerSessionRef,
        role: record.role,
        validForProof: record.validForProof,
        validationErrors: record.validationErrors,
        commandCount: record.commands.length,
        workflowActionCount: record.workflowActions.length,
        transcriptDigest: record.transcriptDigest || record.finalMessageDigest || record.transcript?.digest || null,
        evidenceDigest: record.evidenceDigest,
        actorProjection: record.actorProjection,
        workflowActions: record.workflowActions.map((action) => ({
          kind: action.kind,
          action: action.action,
          tool: action.tool,
          receiptDigest: action.receiptDigest,
          references: action.references,
          outputArtifacts: action.outputArtifacts || [],
        })),
      })),
      codexSessionCount: agentSessions.filter((session) => (
        session.agentProvider === 'codex'
        && session.agentRuntime === codexRuntime.runtime
        && expectedAgentSessionRefs.includes(session.providerSessionRef)
      )).length,
    },
    clearance: {
      id: lease.id,
      callsign: lease.displayCallsign,
      status: lease.status,
      reasonCodes: lease.policyDecision?.reasonCodes || [],
      towerInstruction: lease.lease?.towerInstruction,
      governancePermit: schemaGovernancePermit,
      governancePolicy: lease.lease?.governancePolicy || null,
      dojoProofRef: lease.dojoProofRef,
      dojoDecisionDigest: lease.dojoDecisionDigest,
      dojoImplementationStatus: dojoProof.implementationStatus,
      pilotLicenseHealth: lease.pilotLicenseHealth || null,
    },
    pilotLicenseLifecycle: {
      policySourceDigest: projectPolicySourceDigest,
      schemaPilot: {
        landingHealthInspection: schemaLandingHealthResponse.inspectionRun,
        health: schemaPilotHealth,
      },
      currentPilot: {
        session: currentPilotSessionResponse.agentSession,
        executionPlan: currentPilotPlanResponse.executionPlan,
        landingHealthInspection: currentPilotLandingResponse.inspectionRun,
        health: currentPilotHealth,
      },
      stalePilot: {
        session: stalePilotSessionResponse.agentSession,
        executionPlan: stalePilotPlanResponse.executionPlan,
        mutationLease: stalePilotLeaseResponse.mutationLease,
        health: stalePilotHealth,
      },
      violationPilot: {
        session: violationPilotSessionResponse.agentSession,
        executionPlan: violationPilotPlanResponse.executionPlan,
        failedLandings: [
          violationLandingOne.inspectionRun,
          violationLandingTwo.inspectionRun,
        ],
        incident: violationIncidentResponse.incident,
        health: violationPilotHealth,
      },
      healthSummary: controlState.pilotLicenseSummary || null,
      requiredActions: (controlState.requiredActions || []).filter((action) => /pilot_license/.test(String(action))),
    },
    serializableSnapshotGate,
    codesiteFs: {
      read: {
        phase: managedRead.phase,
        disposition: managedRead.disposition,
        path: managedRead.path,
        eventRecordOk: Boolean(managedRead.eventRecord?.transaction?.observedReadSet?.includes(readPath)),
        verification: managedRead.verification,
      },
      denied: {
        ok: false,
        disposition: deniedError.event?.type || null,
        path: deniedError.event?.path || 'secrets/prod.env',
        reasonCodes: deniedError.event?.details?.reason_codes || [],
        applyCalled: deniedApplyCalled,
        repoMutated: fs.existsSync(path.join(proofRepo.hostRoot, 'secrets/prod.env')),
      },
      quarantined: {
        ok: false,
        disposition: 'write_quarantined',
        path: quarantinedRecord?.path || null,
        recorded: Boolean(quarantinedRecord?.ok),
        changes: quarantineResult.changes.map((change) => ({ path: change.path, kind: change.kind, evidenceRef: change.quarantineEvidence?.evidenceRef || null })),
        unmanagedTerminalWriteBoundary: runtimeBoundary.unmanagedTerminalWriteBoundary,
      },
      allowed: {
        phase: allowedApply.phase,
        path: allowedApply.path,
        eventRecordOk: writeResponse?.ok === true,
        verification: allowedApply.verification,
      },
    },
    transaction: {
      id: commitResponse.transaction.id,
      status: commitResponse.transaction.status,
      readSet: commitResponse.transaction.readSet,
      observedReadSet: commitResponse.transaction.observedReadSet,
      writeSet: commitResponse.transaction.writeSet,
      proofBundleDigest: commitResponse.transaction.proofBundleDigest,
    },
    git: {
      landingCommit,
      trailerCommit,
      proofBundleCommitSha: proofBundle.commitSha,
      trailerTreeMatchesLandingTree: landingCommit.tree === trailerCommit.tree,
      trailersPresent: commitMessageContainsTrailers(trailerCommit.message, proofBundle.trailers),
    },
    runtimeAttestations,
    runtimeBoundary,
    assumption: {
      schema: schemaAssumption,
      stale: staleAssumption,
      apiLease,
      apiTransaction,
      apiAbort: apiAbortResponse.transaction,
    },
    counterfactual: {
      shadowSimulation: {
        selected: shadowSimulation.selected,
        shadowJobRef: shadowSimulation.shadowJobRef,
        universeCount: shadowSimulation.universes?.length || 0,
        policyDeltaCandidateCount: shadowSimulation.policyDeltaCandidates?.length || 0,
        shadowExecution: shadowSimulation.shadowExecution || null,
        universes: asArray(shadowSimulation.universes).map((universe) => ({
          strategy: universe.strategy,
          reasonCodes: universe.reasonCodes || [],
          evidenceRefs: universe.evidenceRefs || [],
          execution: universe.execution || null,
        })),
      },
      run: counterfactualResponse.counterfactualRun,
      promotedPolicyDelta: promotedPolicyDeltaResponse.policyDelta,
      learnedPolicySimulation: {
        selected: learnedPolicySimulation.selected,
        shadowJobRef: learnedPolicySimulation.shadowJobRef,
        appliedPolicyDeltas: learnedPolicySimulation.appliedPolicyDeltas || [],
        evidenceRefs: learnedPolicySimulation.evidenceRefs || [],
        universes: asArray(learnedPolicySimulation.universes).map((universe) => ({
          strategy: universe.strategy,
          reasonCodes: universe.reasonCodes || [],
          policyDeltaRefs: universe.policyDeltaRefs || [],
          riskScore: universe.riskScore,
        })),
      },
      runs: counterfactualRuns,
      recordedRun: {
        id: counterfactualResponse.counterfactualRun.id,
        ref: counterfactualRunRef,
        projectProjectionRecorded: counterfactualRunRecorded,
        policyDeltaReplayRecorded: counterfactualPolicyDeltaRefsRun,
      },
      projectRunCount: counterfactualRuns.length,
      policyDeltaCount: policyDeltas.length,
      policyDeltas,
    },
    coordination: {
      rfiDocument: rfiResponse.document,
      rfiInboxItem,
      rfiAck: rfiAck.inboxItem,
      changeOrderDocument: changeOrderResponse.document,
      changeOrderInboxItem,
      changeOrderAck: changeOrderAck.inboxItem,
      documentCount: documents.length,
      inboxItemCount: inboxItems.length,
      documents,
      inboxItems,
    },
    inspection: inspectionResponse.inspectionRun,
    repoState,
    proofBundle,
    blackBox: {
      incidentId: blackBoxIncident?.id || null,
      replayDigest: blackBoxIncident?.replayDigest || null,
      proofBundleIncidentReplayDigest: proofBundle?.incidentReplayDigest || null,
      codeSiteBlackBoxTrailer: proofBundle?.trailers?.['CodeSite-Black-Box'] || null,
      replayCompleteness: blackBoxReplay?.completeness || blackBoxIncident?.incidentReplay?.completeness || null,
      missingRequiredEventTypes: blackBoxMissingEventTypes,
      replayEventTypes: (blackBoxReplay?.replay?.causalEvents || blackBoxIncident?.incidentReplay?.causalEvents || []).map((event) => event.type),
      replayExported: exportPaths.some((item) => blackBoxIncident?.id && item.endsWith(`/incidents/incident-replay-${blackBoxIncident.id}.jsonl`)),
      handoverExported: exportPaths.some((item) => item.endsWith('/handover.md')),
    },
    lineProvenance: lineRows,
    lineInspector: {
      request: inspectedLineRow ? {
        projectId: project.id,
        filePath: inspectedLineRow.filePath,
        lineAnchor: inspectedLineRow.lineAnchor,
        lineNumber: inspectedLineRow.startLine || 1,
      } : null,
      rows: lineInspectorRows,
    },
    exported: {
      fileCount: exportPaths.length,
      paths: exportPaths,
      verifier: {
        ok: verifier.ok,
        artifactRoot: verifier.artifactRoot ? path.relative(repoRoot(), verifier.artifactRoot) : null,
        bundlePath: verifier.bundlePath ? path.relative(repoRoot(), verifier.bundlePath) : null,
        trailersPath: verifier.trailersPath ? path.relative(repoRoot(), verifier.trailersPath) : null,
        checks: verifier.json?.checks || [],
        errors: verifier.json?.errors || [],
        gitCommit: verifier.json?.gitCommit || null,
      },
    },
    controlState: {
      towerState: controlState.towerState,
      activeFlights: controlState.activeFlights.map((flight) => ({ callsign: flight.displayCallsign, status: flight.status, route: flight.route })),
      riskLevel: controlState.collisionForecast.riskLevel,
    },
    eventTypes,
    browserProof: {
      screenshot: path.relative(repoRoot(), browserShot),
      proofSectionScreenshot: path.relative(repoRoot(), browserProofSectionShot),
      coordinationScreenshot: path.relative(repoRoot(), browserCoordinationShot),
      lineInspectorScreenshot: path.relative(repoRoot(), browserLineInspectorShot),
      handoverScreenshot: path.relative(repoRoot(), browserHandoverShot),
      mobileScreenshot: path.relative(repoRoot(), browserMobileShot),
      artifactValidation: browserArtifactValidation,
      consoleErrors: browserProof.consoleErrors,
      ignoredConsoleErrors: browserProof.ignoredConsoleErrors,
      desktopChecks: browserProof.desktopChecks,
      mobileChecks: browserProof.mobileChecks,
    },
    assertions: {
      multiUserAuthBound: actorProof.mode === 'generated_nextauth_jwt_multi_user'
        && new Set(Object.values(actorProof.actors).map((actor) => actor.userId)).size === 4
        && agentSessions.some((session) => session.displayCallsign === 'SCHEMA-01' && session.ownerUserId === actorProof.actors.schema.userId)
        && agentSessions.some((session) => session.displayCallsign === 'API-02' && session.ownerUserId === actorProof.actors.api.userId)
        && agentSessions.some((session) => session.displayCallsign === 'TEST-03' && session.ownerUserId === actorProof.actors.test.userId),
      projectMembershipWriteBound: projectMembershipGrants.length === 3
        && projectMembershipGrants.every((grant) => (
          grant.member?.projectId === project.id
          && grant.member?.userId === grant.userId
          && grant.member?.participationStatus === 'enabled'
          && grant.member?.permissions?.includes('project:read')
          && grant.member?.permissions?.includes('project:write')
        )),
      codexRuntimeEvidenceCollected: codexRuntime.cliEvidenceOk === true
        && codexRuntime.providerSessionRefs.length >= 3
        && expectedAgentSessionRefs.every((ref) => /^codex[-_:]/i.test(ref)),
      codexAgentSessionsRegistered: agentFlightSpecs.every((spec) => {
        const session = agentSessions.find((item) => item.displayCallsign === spec.callsign);
        const plan = executionPlans.find((item) => item.displayCallsign === spec.callsign);
        return session
          && plan
          && plan.agentSessionId === session.id
          && session.agentProvider === 'codex'
          && session.agentRuntime === codexRuntime.runtime
          && session.providerSessionRef === spec.providerSessionRef
          && spec.permissions.every((permission) => session.permissions?.includes(permission))
          && session.dojoProofRef === dojoProof.dojoProofCapsule.capsule_id
          && session.dojoPilotLicenseRef === dojoProof.dojoProofCapsule.license_version;
      }),
      codexSessionsExecutedRoles: agentFlightSpecs.every((spec) => {
        const evidence = agentExecutionEvidence.recordsByCallsign.get(spec.callsign);
        return evidence?.validForProof === true
          && evidence.providerSessionRef === spec.providerSessionRef
          && evidence.commands.length > 0
          && evidence.commands.every((command) => command.source === 'codex_jsonl_command_execution' && command.transcriptEventId)
          && evidence.workflowActions.length > 0
          && evidence.transcriptBinding?.ok === true
          && evidence.actorProjectionBinding?.ok === true
          && Boolean(evidence.evidenceDigest);
      }),
      codexActorReceiptsBackedByTranscripts: agentFlightSpecs.every((spec) => {
        const evidence = agentExecutionEvidence.recordsByCallsign.get(spec.callsign);
        const transcriptCommands = (evidence?.commands || []).map((command) => normalizeCommandText(command.command));
        return evidence?.validForProof === true
          && evidence.actorProjection?.surface === 'repo_local_codesite_projection'
          && roleWorkflowActionRequirements(spec.domain).every((kind) => evidence.workflowActions.some((action) => action.kind === kind))
          && evidence.workflowActions.every((action) => (
            action.source === 'codesite_repo_local_projection_actor'
            && action.receiptDigest
            && action.projectionControlStateSha256 === evidence.actorProjection?.controlStateSha256
            && action.actionScriptSha256 === evidence.actorProjection?.actionScriptSha256
            && workflowActionBackedByTranscript(action, transcriptCommands)
          ));
      }),
      agentReadableSessionArtifactsExported: agentFlightSpecs.every((spec) => (
        exportedAgentSessions.some((artifact) => (
          artifact.json?.displayCallsign === spec.callsign
          && artifact.json?.agentProvider === 'codex'
          && artifact.json?.agentRuntime === codexRuntime.runtime
          && artifact.json?.providerSessionRef === spec.providerSessionRef
          && spec.permissions.every((permission) => artifact.json?.permissions?.includes(permission))
          && artifact.json?.dojoProofRef === dojoProof.dojoProofCapsule.capsule_id
        ))
      )),
      schemaClearanceActive: lease.status === 'active',
      restrictedAirspaceGovernanceVerified: schemaGovernancePermit.status === 'issued'
        && schemaGovernancePermit.executionPlanId === schemaPlan.id
        && schemaGovernancePermit.scope?.allowedPaths?.includes('synthi/prisma/**')
        && lease.lease?.governancePolicy?.verified === true
        && lease.lease?.governancePolicy?.evidence?.permits?.some((permit) => permit.id === schemaGovernancePermit.id)
        && lease.policyDecision?.reasonCodes?.includes('governance_clearance_evidence_verified'),
      dojoPilotLicenseRuntimeVerified: dojoProof.implementationStatus?.executable === true
        && dojoProof.implementationStatus?.productionRuntime === true
        && lease.policyDecision?.reasonCodes?.includes('dojo_clearance_proof_verified')
        && lease.policyDecision?.reasonCodes?.includes('dojo_public_proof_signature_verified')
        && lease.pilotLicenseHealth?.status === 'active'
        && lease.pilotLicenseHealth?.reasonCodes?.includes('pilot_license_health_active'),
      pilotLicenseSourceCurrentAndLandingUpdated: currentPilotHealth?.status === 'active'
        && currentPilotHealth?.sourceDrift?.monitored === true
        && currentPilotHealth?.sourceDrift?.expired === false
        && currentPilotHealth?.sourceDrift?.sourceDigest === projectPolicySourceDigest
        && currentPilotHealth?.sourceDrift?.currentSourceDigest === projectPolicySourceDigest
        && currentPilotHealth?.landingStats?.total >= 1
        && currentPilotHealth?.landingStats?.passed >= 1
        && currentPilotHealth?.violationStats?.critical === 0
        && currentPilotHealth?.requiredAction == null
        && currentPilotHealth?.evidenceRefs?.includes('codesite:landing:current-source-proof'),
      pilotLicenseSourceDriftExpirationBlocked: stalePilotLeaseResponse.mutationLease?.status === 'blocked'
        && stalePilotLeaseResponse.mutationLease?.policyDecision?.reasonCodes?.includes('pilot_license_source_drift_expired')
        && stalePilotLeaseResponse.mutationLease?.pilotLicenseHealth?.status === 'expired'
        && stalePilotLeaseResponse.mutationLease?.pilotLicenseHealth?.sourceDrift?.expired === true
        && stalePilotHealth?.status === 'expired'
        && stalePilotHealth?.sourceDrift?.expired === true
        && stalePilotHealth?.reasonCodes?.includes('pilot_license_source_drift_expired')
        && (controlState.requiredActions || []).includes(`renew_pilot_license_source:${stalePilotSessionResponse.agentSession.id}`),
      pilotLicenseViolationHealthUpdated: violationPilotHealth?.status === 'suspended'
        && violationPilotHealth?.landingStats?.failed >= 2
        && violationPilotHealth?.violationStats?.critical >= 1
        && (
          violationPilotHealth?.reasonCodes?.includes('pilot_license_critical_violation_window')
          || violationPilotHealth?.reasonCodes?.includes('pilot_license_failed_landing_threshold')
        )
        && (controlState.requiredActions || []).includes(`review_pilot_license:${violationPilotSessionResponse.agentSession.id}`),
      dependentFlightHeld: controlState.activeFlights.some((flight) => flight.displayCallsign === 'API-02' && flight.status === 'holding'),
      readSetCapturedFromCodeSiteFs: managedRead.disposition === 'read_observed'
        && managedRead.eventRecord?.transaction?.observedReadSet?.includes(readPath)
        && commitResponse.transaction.observedReadSet?.includes(readPath)
        && eventTypes.includes('read_observed')
        && blackBoxReplay?.replay?.causalEvents?.some((event) => event.type === 'read.observed'),
      runtimeBoundaryEnforced: runtimeBoundary.terminalHostMode === 'block-host'
        && runtimeBoundary.programHeadlessMode === 'block-host'
        && runtimeBoundary.terminalContainerMode === 'overlay-runtime'
        && runtimeBoundary.programHybridMode === 'overlay-runtime'
        && runtimeBoundary.terminalRuntimePodWithOverlayMode === 'overlay-runtime'
        && runtimeBoundary.programRuntimePodWithOverlayMode === 'overlay-runtime'
        && runtimeBoundary.terminalRuntimePodMode === 'block-runtime'
        && runtimeBoundary.programRuntimePodMode === 'block-runtime'
        && runtimeBoundary.rawShellOverlay.realRepoUnchangedBeforeFinalize === true,
      unmanagedTerminalWriteQuarantined: runtimeBoundary.unmanagedTerminalWriteBoundary?.outcome === 'quarantined_before_real_repo_mutation'
        && runtimeBoundary.unmanagedTerminalWriteBoundary?.realRepoUnchangedBeforeFinalize === true
        && runtimeBoundary.unmanagedTerminalWriteBoundary?.overlayOnlyMutationObserved === true
        && runtimeBoundary.rawShellOverlay.realRepoDigestBefore === runtimeBoundary.rawShellOverlay.realRepoDigestAfterOverlayWrite,
      deniedWriteRecorded: deniedError.event?.type === 'write_denied' && deniedApplyCalled === false && !fs.existsSync(path.join(proofRepo.hostRoot, 'secrets/prod.env')) && eventTypes.includes('write_denied'),
      quarantinedWriteRecorded: Boolean(quarantinedRecord?.ok) && eventTypes.includes('write_quarantined'),
      allowedWriteRecorded: writeResponse?.ok === true && allowedApply.verification?.ok === true && eventTypes.includes('write_allowed'),
      transactionCommitted: commitResponse.transaction.status === 'committed',
      proofBundleCreated: Boolean(proofBundle?.id && proofBundle?.bundleDigest),
      commitTrailersPresent: Boolean(proofBundle?.trailers?.['CodeSite-Transaction'] && proofBundle?.trailers?.['CodeSite-Clearance'])
        && proofBundle.commitSha === trailerCommit.sha
        && landingCommit.tree === trailerCommit.tree
        && commitMessageContainsTrailers(trailerCommit.message, proofBundle.trailers),
      runtimeAttestationsLinked: runtimeAttestations.length >= 2
        && runtimeAttestations.every((attestation) => proofBundle.evidenceRefs?.includes(`codesite:runtime-attestation:${attestation.digest}`)),
      blackBoxReplayDigestLinked: Boolean(proofBundle?.incidentReplayDigest)
        && proofBundle.trailers?.['CodeSite-Black-Box'] === proofBundle.incidentReplayDigest
        && proofBundle.incidentReplayDigest !== proofBundle.bundleDigest,
      blackBoxIncidentClosed: Boolean(blackBoxIncident?.id && blackBoxIncident.replayDigest === proofBundle.incidentReplayDigest),
      blackBoxReplayCausal: Boolean(blackBoxReplay?.replay?.causalEvents?.some((event) => event.type === 'transaction.committed'))
        && Boolean(blackBoxReplay?.replay?.causalEvents?.some((event) => event.type === 'black_box.closed'))
        && Boolean(blackBoxReplay?.replay?.transaction?.writeSet?.includes(changedPath)),
      blackBoxReplayComplete: blackBoxMissingEventTypes.length === 0
        && blackBoxReplay?.completeness?.score === 1,
      blackBoxExported: exportPaths.some((item) => blackBoxIncident?.id && item.endsWith(`/incidents/incident-replay-${blackBoxIncident.id}.jsonl`))
        && exportPaths.some((item) => item.endsWith('/handover.md')),
      assumptionRecorded: Boolean(assumptionResponse.assumption?.id)
        && eventTypes.includes('assumption_recorded')
        && blackBoxReplay?.replay?.causalEvents?.some((event) => event.type === 'assumption.recorded'),
      staleAssumptionInvalidated: staleAssumption?.id === staleAssumptionResponse.assumption.id
        && staleAssumption.status === 'invalidated'
        && staleAssumption.invalidatedBy === 'SCHEMA-01'
        && apiAbortResponse.transaction?.status === 'aborted'
        && eventTypes.includes('assumption_invalidated'),
      counterfactualPolicyDeltaRecorded: counterfactualRunRecorded && counterfactualPolicyDeltaRefsRun
        && shadowSimulation.shadowExecution?.status === 'completed'
        && asArray(shadowSimulation.shadowExecution?.evidenceRefs).some((ref) => String(ref).startsWith('codesite:shadow-runner'))
        && asArray(shadowSimulation.universes).some((universe) => universe.execution?.command === 'codesite-shadow-runner:repo-command-execution')
        && asArray(shadowSimulation.universes).some((universe) => asArray(universe.evidenceRefs).some((ref) => String(ref).startsWith('codesite:shadow-command:')))
        && asArray(shadowSimulation.universes).some((universe) => universe.reasonCodes?.includes('shadow_universe_repo_commands_passed'))
        && asArray(shadowSimulation.universes).some((universe) => universe.reasonCodes?.includes('shadow_universe_repo_commands_failed'))
        && eventTypes.includes('shadow_run')
        && eventTypes.includes('arbiter_verdict')
        && eventTypes.includes('policy_delta_proposed')
        && blackBoxReplay?.replay?.causalEvents?.some((event) => event.type === 'shadow.run')
        && blackBoxReplay?.replay?.causalEvents?.some((event) => event.type === 'arbiter.verdict')
        && blackBoxReplay?.replay?.causalEvents?.some((event) => event.type === 'policy_delta.proposed'),
      counterfactualPolicyPromotedAndApplied: promotedPolicyDeltaResponse.policyDelta?.promotionState === 'active'
        && eventTypes.includes('policy_delta_promoted')
        && learnedPolicySimulation.appliedPolicyDeltas?.includes(promotedPolicyDeltaResponse.policyDelta.id)
        && learnedPolicySimulation.evidenceRefs?.includes(`codesite:policy-delta:${promotedPolicyDeltaResponse.policyDelta.id}`)
        && learnedPolicySimulation.universes?.some((universe) => (
          universe.learnedPolicyDeltaRefs?.includes(promotedPolicyDeltaResponse.policyDelta.id)
          || universe.policyDeltaRefs?.includes(promotedPolicyDeltaResponse.policyDelta.id)
          || universe.reasonCodes?.includes('counterfactual_policy_delta_applied')
        )),
      coordinationWorkflowRecorded: documents.some((document) => document.id === rfiResponse.document.id && document.kind === 'rfi')
        && documents.some((document) => document.id === changeOrderResponse.document.id && document.kind === 'change_order')
        && inboxItems.some((item) => item.id === rfiAck.inboxItem.id && item.status === 'acknowledged')
        && inboxItems.some((item) => item.id === changeOrderAck.inboxItem.id && item.status === 'acknowledged')
        && rfiAck.inboxItem.recipientUserId === actorProof.actors.api.userId
        && changeOrderAck.inboxItem.recipientUserId === actorProof.actors.schema.userId
        && rfiAck.inboxItem.recipientUserId !== changeOrderAck.inboxItem.recipientUserId
        && eventTypes.includes('rfi')
        && eventTypes.includes('change_order'),
      repoSnapshotRecorded: baseSnapshotEvidence.status === 'recorded' && commitResponse.transaction.commitDecision?.repoSnapshot?.reasonCodes?.includes('repo_snapshot_stable'),
      serializableSnapshotGateBlocked: serializableSnapshotGate.skipped.ok === false
        && serializableSnapshotGate.skipped.reasonCodes.includes('repo_snapshot_required_for_serializable')
        && serializableSnapshotGate.skipped.abortStatus === 'aborted'
        && serializableSnapshotGate.undercovered.ok === false
        && serializableSnapshotGate.undercovered.reasonCodes.includes('repo_snapshot_read_set_coverage_required')
        && serializableSnapshotGate.undercovered.missingReadSet.includes(changedPath)
        && serializableSnapshotGate.undercovered.abortStatus === 'aborted',
      repoStateCollectedFromRealRepo: repoState.source === 'collab-server'
        && repoState.gitHead === landingCommit.sha
        && repoState.writeFileDigests?.some((file) => file.path === changedPath && file.exists && /^sha256:/.test(file.digest || '')),
      inspectionCommandsExecuted: inspectionResponse.inspectionRun.status === 'completed'
        && typecheckInspectionExecuted
        && testsInspectionExecuted
        && inspectionSignals.some((signal) => inspectionSignalRanNpmScript(signal, 'typecheck', 'typecheck:run:'))
        && inspectionSignals.some((signal) => inspectionSignalRanNpmScript(signal, 'test', 'test:run:')),
      governanceInspectionSignalRecorded: inspectionSignals.some((signal) => (
        String(signal.key || '').trim().toLowerCase().replace(/[-\s]+/g, '_') === 'governance'
        && signal.status === 'passed'
        && asArray(signal.evidenceRefs).includes(`codesite:permit:${schemaGovernancePermit.id}`)
      )),
      lineProvenanceSeeded: lineRows.some((row) => row.filePath === changedPath && lineProvenance.some((line) => line.lineAnchor === row.lineAnchor)),
      lineInspectorCausalContext: lineInspectorRows.some((row) => (
        row.filePath === changedPath
        && row.transaction?.id === transaction.id
        && row.mutationLease?.id === lease.id
        && row.reasonRef === `change_order:${changeOrderResponse.document.id}`
        && row.proofBundles?.some((bundle) => bundle.id === proofBundle.id && bundle.bundleDigest === proofBundle.bundleDigest)
        && row.evidenceRefs?.includes(`codesite:document:${rfiResponse.document.id}`)
        && row.evidenceRefs?.includes(`codesite:document:${changeOrderResponse.document.id}`)
        && row.dojoSourceRefs?.some((ref) => ref.startsWith('dojo:proof:'))
        && row.processAncestry?.includes('mcp:synthi_codesite_apply_patch')
      )),
      artifactsExported: exportPaths.some((item) => item.endsWith(`/proof-bundles/${proofBundle.id}.proof.json`))
        && exportPaths.some((item) => item.endsWith(`/proof-bundles/${proofBundle.id}.trailers.txt`)),
      idScopedArtifactsExported: executionPlans.every((plan) => exportPaths.some((item) => item.endsWith(`/flight-plans/${plan.id}.json`)))
        && projectAfter.project.mutationLeases.every((projectLease) => exportPaths.some((item) => item.endsWith(`/clearances/${projectLease.id}.json`))),
      artifactPathHistoryRecorded: artifactPathHistory.includes('"schemaVersion":"synthi.codesite.artifactPathHistory.v1"')
        && artifactPathHistory.includes(`/proof-bundles/${proofBundle.id}.proof.json`)
        && artifactPathHistory.includes(`/clearances/${lease.id}.json`),
      exportedProofVerifies: verifier.ok === true
        && verifier.json?.ok === true
        && verifier.json?.reasonCodes?.includes('proof_bundle_signature_valid')
        && verifier.json?.reasonCodes?.includes('proof_commit_trailers_match')
        && verifier.json?.reasonCodes?.includes('proof_git_commit_trailers_match'),
      browserUiCaptured: fs.existsSync(browserShot)
        && fs.existsSync(browserProofSectionShot)
        && fs.existsSync(browserCoordinationShot)
        && fs.existsSync(browserLineInspectorShot)
        && fs.existsSync(browserHandoverShot)
        && fs.existsSync(browserMobileShot)
        && browserArtifactValidation.ok === true
        && browserProof.consoleErrors.length === 0
        && browserProof.desktopChecks?.panelVisible
        && browserProof.desktopChecks?.codeSiteBlackBoxVisible
        && browserProof.desktopChecks?.transactionCommittedVisible
        && browserProof.desktopChecks?.blackBoxClosedVisible
        && browserProof.desktopChecks?.agentInboxVisible
        && browserProof.desktopChecks?.changeOrderVisible
        && browserProof.desktopChecks?.lineInspectorVisible
        && browserProof.desktopChecks?.dojoRefsVisible
        && browserProof.desktopChecks?.noHorizontalOverflow
        && browserProof.desktopChecks?.rectsFitViewport
        && browserProof.desktopChecks?.touchTargetsOk
        && browserProof.desktopChecks?.devOverlayHidden
        && browserProof.desktopChecks?.lineInspectorSettled
        && browserProof.mobileChecks?.panelVisible
        && browserProof.mobileChecks?.codeSiteBlackBoxVisible
        && browserProof.mobileChecks?.transactionCommittedVisible
        && browserProof.mobileChecks?.blackBoxClosedVisible
        && browserProof.mobileChecks?.noHorizontalOverflow
        && browserProof.mobileChecks?.rectsFitViewport
        && browserProof.mobileChecks?.touchTargetsOk
        && browserProof.mobileChecks?.devOverlayHidden
        && browserProof.mobileChecks?.lineInspectorSettled,
    },
  };
  const failed = Object.entries(proof.assertions).filter(([, value]) => value !== true);
  if (failed.length) {
    const failureProof = {
      ...proof,
      status: 'failed',
      failedAssertions: failed.map(([key, value]) => ({ key, value })),
    };
    fs.writeFileSync(runPaths.failureDiagnosticsPath, `${JSON.stringify(failureProof, null, 2)}\n`);
    fs.writeFileSync(runPaths.jsonPath, `${JSON.stringify(failureProof, null, 2)}\n`);
    fs.writeFileSync(runPaths.htmlPath, proofHtml(failureProof));
    try {
      await screenshotHtml(runPaths.htmlPath, runPaths.pngPath, runPaths.summaryPngPath);
    } catch (error) {
      failureProof.failurePublicationWarning = `failed to render failure proof screenshots: ${error?.message || String(error)}`;
      fs.writeFileSync(runPaths.failureDiagnosticsPath, `${JSON.stringify(failureProof, null, 2)}\n`);
      fs.writeFileSync(runPaths.jsonPath, `${JSON.stringify(failureProof, null, 2)}\n`);
      fs.writeFileSync(runPaths.htmlPath, proofHtml(failureProof));
    }
    const failureCopies = [
      [runPaths.jsonPath, path.join(dir, 'codesite-full-workflow-proof.json')],
      [runPaths.failureDiagnosticsPath, path.join(dir, 'codesite-full-workflow-failure.json')],
      [runPaths.htmlPath, path.join(dir, 'codesite-full-workflow-proof.html')],
      [runPaths.pngPath, path.join(dir, 'codesite-full-workflow-proof.png')],
      [runPaths.summaryPngPath, path.join(dir, 'codesite-full-workflow-proof-summary.png')],
      [runPaths.browserShot, path.join(dir, 'codesite-full-workflow-ui.png')],
      [runPaths.browserProofSectionShot, path.join(dir, 'codesite-full-workflow-ui-proof-section.png')],
      [runPaths.browserCoordinationShot, path.join(dir, 'codesite-full-workflow-ui-coordination.png')],
      [runPaths.browserLineInspectorShot, path.join(dir, 'codesite-full-workflow-ui-line-inspector.png')],
      [runPaths.browserHandoverShot, path.join(dir, 'codesite-full-workflow-ui-causal-replay-handover.png')],
      [runPaths.browserMobileShot, path.join(dir, 'codesite-full-workflow-ui-causal-replay-mobile.png')],
    ];
    for (const [sourcePath, targetPath] of failureCopies) {
      if (fs.existsSync(sourcePath)) await copyValidatedArtifact(sourcePath, targetPath);
    }
    throw new Error(`full workflow proof assertions failed: ${JSON.stringify(failed)}`);
  }

  fs.writeFileSync(runPaths.jsonPath, `${JSON.stringify(proof, null, 2)}\n`);
  fs.writeFileSync(runPaths.htmlPath, proofHtml(proof));
  await screenshotHtml(runPaths.htmlPath, runPaths.pngPath, runPaths.summaryPngPath);
  const finalArtifactValidation = await validateProofArtifacts({
    slug,
    runStartedAt,
    visualPaths: [
      runPaths.pngPath,
      runPaths.summaryPngPath,
      runPaths.browserShot,
      runPaths.browserProofSectionShot,
      runPaths.browserCoordinationShot,
      runPaths.browserLineInspectorShot,
      runPaths.browserHandoverShot,
      runPaths.browserMobileShot,
    ],
    textPaths: [
      runPaths.jsonPath,
      runPaths.htmlPath,
      ...runtimeAttestations.map((attestation) => path.join(repoRoot(), attestation.path)),
    ],
  });
  assertProof(finalArtifactValidation.ok, `final proof artifacts failed validation: ${JSON.stringify(finalArtifactValidation.invalidArtifacts)}`);
  const evidenceRoot = path.join(repoRoot(), agentExecutionEvidence.evidenceDir);
  const secretScan = await scanProofArtifactsForSecrets([
    runPaths.runDir,
    evidenceRoot,
    proofAppArtifactRoot(slug),
  ]);
  assertProof(secretScan.ok, `proof artifact secret scan failed: ${JSON.stringify(secretScan.findings)}`);
  const publicationReport = {
    schemaVersion: 'synthi.codesite.fullWorkflowPublication.v1',
    status: 'validated',
    slug,
    generatedAt: new Date().toISOString(),
    runDir: relativeProofPath(runPaths.runDir),
    proof: relativeProofPath(runPaths.jsonPath),
    proofSha256: await fileSha256(runPaths.jsonPath),
    html: relativeProofPath(runPaths.htmlPath),
    screenshot: relativeProofPath(runPaths.pngPath),
    summaryScreenshot: relativeProofPath(runPaths.summaryPngPath),
    browserScreenshots: [
      runPaths.browserShot,
      runPaths.browserProofSectionShot,
      runPaths.browserCoordinationShot,
      runPaths.browserLineInspectorShot,
      runPaths.browserHandoverShot,
      runPaths.browserMobileShot,
    ].map(relativeProofPath),
    assertionCount: Object.keys(proof.assertions || {}).length,
    failedAssertions: failed.map(([key, value]) => ({ key, value })),
    artifactValidation: finalArtifactValidation,
    secretScan,
  };
  await fs.promises.writeFile(runPaths.publicationPath, `${JSON.stringify(publicationReport, null, 2)}\n`, 'utf8');
  const publicationSecretScan = await scanProofArtifactsForSecrets([
    runPaths.runDir,
    evidenceRoot,
    proofAppArtifactRoot(slug),
  ]);
  assertProof(publicationSecretScan.ok, `proof publication secret scan failed: ${JSON.stringify(publicationSecretScan.findings)}`);
  publicationReport.publicationSecretScan = publicationSecretScan;
  await fs.promises.writeFile(runPaths.publicationPath, `${JSON.stringify(publicationReport, null, 2)}\n`, 'utf8');
  const latestSchemaPath = path.join(evidenceRoot, 'codex-agent-output.schema.json');
  const latestPublication = await publishValidatedProofRun({
    dir,
    slug,
    runPaths,
    proof,
    latestSchemaPath,
  });

  console.log(JSON.stringify({
    proof: path.relative(repoRoot(), runPaths.jsonPath),
    html: path.relative(repoRoot(), runPaths.htmlPath),
    screenshot: path.relative(repoRoot(), runPaths.pngPath),
    summaryScreenshot: path.relative(repoRoot(), runPaths.summaryPngPath),
    latest: latestPublication,
    artifactValidation: finalArtifactValidation,
    secretScan,
    publication: path.relative(repoRoot(), runPaths.publicationPath),
    publicationSecretScan,
    browserScreenshot: path.relative(repoRoot(), browserShot),
    browserProofSectionScreenshot: path.relative(repoRoot(), browserProofSectionShot),
    browserCoordinationScreenshot: path.relative(repoRoot(), browserCoordinationShot),
    browserLineInspectorScreenshot: path.relative(repoRoot(), browserLineInspectorShot),
    browserHandoverScreenshot: path.relative(repoRoot(), browserHandoverShot),
    browserMobileScreenshot: path.relative(repoRoot(), browserMobileShot),
    assertions: proof.assertions,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
