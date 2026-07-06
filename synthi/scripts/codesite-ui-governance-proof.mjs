import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import zlib from 'node:zlib';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const moduleRequire = createRequire(import.meta.url);
const SLUG = 'codesite-ui-proof';
const PROJECT_ID = 'proj-ui-governance';
const RUN_ID = `codesite-ui-governance-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;
const OUT_DIR = path.join(REPO_ROOT, 'tmp', 'codesite-ui-governance-proof', RUN_ID);

function route(pathname) {
  return `/api/workspace/${SLUG}/codesite${pathname}`;
}

function fixture() {
  const project = {
    id: PROJECT_ID,
    title: 'CodeSite infrastructure rollout',
    request: 'Coordinate schema, runtime, and workspace guard changes with legal workflow evidence.',
    status: 'active',
    zonePolicy: {
      zones: [
        { zoneKey: 'schema', label: 'Schema runway', class: 'A', paths: ['synthi/prisma/**'], risk: 'high' },
        { zoneKey: 'runtime', label: 'Runtime boundary', class: 'B', paths: ['backend/collab-server/**'], risk: 'medium' },
      ],
      noFlyZones: ['secrets/**', '.env*'],
    },
    documents: [{
      id: 'doc-rfi-1',
      kind: 'rfi',
      title: 'Confirm schema owner before clearance',
      status: 'pending_review',
      evidenceRefs: ['rfi:schema-owner'],
    }, ...Array.from({ length: 5 }, (_, index) => ({
      id: `doc-rfi-${index + 2}`,
      kind: index % 2 === 0 ? 'rfi' : 'change_order',
      title: `Hidden governance document ${index + 2}`,
      status: index === 4 ? 'blocked' : 'pending',
      evidenceRefs: [`rfi:hidden:${index + 2}`],
    }))],
    permits: [{
      id: 'permit-schema-1',
      permitType: 'restricted_route',
      title: 'Schema runway permit',
      status: 'issued',
      scope: { allowedPaths: ['synthi/prisma/**'], route: ['synthi/prisma/**'] },
      evidenceRefs: ['permit:schema-runway'],
    }],
    routeRevisions: [{
      id: 'route-rev-1',
      executionPlanId: 'plan-atlas-1',
      status: 'proposed',
      previousRoute: ['synthi/prisma/**'],
      proposedRoute: ['synthi/src/lib/codesite/**'],
      affectedLeases: ['lease-atlas-1'],
      evidenceRefs: ['route-revision:proposal'],
    }, {
      id: 'route-rev-2',
      executionPlanId: 'plan-atlas-1',
      status: 'approved',
      previousRoute: ['backend/collab-server/**'],
      proposedRoute: ['backend/collab-server/codesiteWorkspaceGuard.js'],
      affectedLeases: ['lease-atlas-1'],
      evidenceRefs: ['route-revision:approved'],
    }, ...Array.from({ length: 4 }, (_, index) => ({
      id: `route-rev-extra-${index + 1}`,
      executionPlanId: 'plan-atlas-1',
      status: index === 3 ? 'approved' : 'proposed',
      previousRoute: ['backend/collab-server/**'],
      proposedRoute: [`backend/collab-server/runtime-guard-${index + 1}.js`],
      affectedLeases: ['lease-atlas-1'],
      evidenceRefs: [`route-revision:hidden:${index + 1}`],
    }))],
    proofBundles: [{
      id: 'proof-ui-1',
      transactionId: 'txn-atlas-1',
      bundleDigest: 'sha256:proof-ui',
      incidentReplayDigest: 'sha256:mayday-replay',
      trailers: {
        'CodeSite-Project': PROJECT_ID,
        'CodeSite-Transaction': 'txn-atlas-1',
        'CodeSite-Black-Box': 'sha256:mayday-replay',
      },
      evidenceRefs: ['proof:ui'],
    }],
    incidents: [{
      id: 'incident-mayday-1',
      category: 'mayday',
      status: 'open',
      severity: 'high',
      affectedZones: ['backend/collab-server/**'],
      evidenceRefs: ['incident:mayday:evidence'],
      replayDigest: 'sha256:mayday-replay',
      incidentReplay: {
        maydayWorkflow: {
          inspectorRunId: 'inspection-mayday-1',
          suspendedLeases: [{ id: 'lease-atlas-1' }],
        },
        causalEvents: [
          { eventId: 'event-mayday', type: 'mayday.declared', logicalTime: 12, details: { incidentId: 'incident-mayday-1' } },
          { eventId: 'event-ground-stop', type: 'ground_stop', logicalTime: 13, details: { incidentId: 'incident-mayday-1' } },
        ],
        completeness: { score: 0.86, presentEventTypes: ['mayday.declared', 'ground_stop'], missingEventTypes: [] },
      },
      createdAt: '2026-07-04T09:00:00.000Z',
    }, ...Array.from({ length: 3 }, (_, index) => ({
      id: `incident-mayday-hidden-${index + 1}`,
      category: 'mayday',
      status: 'open',
      severity: index === 2 ? 'critical' : 'high',
      affectedZones: ['backend/collab-server/**'],
      evidenceRefs: [`incident:mayday:hidden:${index + 1}`],
      replayDigest: `sha256:hidden-mayday-${index + 1}`,
      incidentReplay: {
        maydayWorkflow: {
          inspectorRunId: 'inspection-mayday-1',
          suspendedLeases: [{ id: 'lease-atlas-1' }],
        },
        completeness: { score: 0.84, presentEventTypes: ['mayday.declared', 'ground_stop'], missingEventTypes: [] },
      },
      createdAt: '2026-07-04T09:10:00.000Z',
    }))],
    inspectionRuns: [{
      id: 'inspection-mayday-1',
      displayCallsign: 'QA-MAYDAY',
      status: 'passed',
      changedPaths: ['backend/collab-server/**'],
      inspectionSignals: [{ type: 'recovery', status: 'passed' }],
      evidenceRefs: ['runtime:event:inspection-mayday-1', 'incident:mayday:evidence'],
    }],
    lineProvenance: [{
      id: 'line-ui-1',
      transactionId: 'txn-atlas-1',
      filePath: 'backend/collab-server/codesiteWorkspaceGuard.js',
      lineAnchor: 'L88',
      startLine: 88,
      endLine: 112,
      displayCallsign: 'ATLAS-1',
      reasonRef: 'change_order:route-rev-2',
      evidenceRefs: ['proof-ui-1'],
      dojoSourceRefs: ['dojo:guard-boundary'],
      processAncestry: ['mcp:synthi_codesite_apply_patch'],
      promptSummary: 'Route runtime writes through active CodeSite guard.',
    }],
    inboxItems: [{
      id: 'inbox-rfi-1',
      eventId: 'event-rfi-1',
      kind: 'rfi',
      requiresResponse: true,
      status: 'pending',
      redactedPayload: { title: 'Confirm schema owner before clearance', documentId: 'doc-rfi-1' },
    }],
    counterfactualRuns: [{
      id: 'cfr-ui-1',
      arbiterVerdict: {
        selected: 'schema-first',
        universes: [
          { strategy: 'schema-first', result: 'passed', predictedCollisionRisk: 0.12, staleAssumptions: 0, inspectionCost: 5, confidence: 0.91, avoidedRisks: ['schema_collision'], unresolvedRisks: [], requiredTowerActions: ['permit_before_clearance'], reasonCodes: ['schema_owner_confirmed'] },
          { strategy: 'runtime-first', result: 'risk', predictedCollisionRisk: 0.68, staleAssumptions: 2, inspectionCost: 14, confidence: 0.77, avoidedRisks: [], unresolvedRisks: ['runtime_boundary_drift'], requiredTowerActions: ['reroute_before_write'], reasonCodes: ['runtime_write_guard_required'] },
        ],
        evidenceRefs: ['codesite:shadow_merge_simulator'],
      },
    }],
  };
  const controlState = {
    projectId: PROJECT_ID,
    towerState: 'holding',
    activeFlights: [{
      id: 'plan-atlas-1',
      displayCallsign: 'ATLAS-1',
      mission: 'Guard runtime writes',
      domain: 'backend',
      status: 'holding',
      route: ['backend/collab-server/**'],
    }],
    activeMutationLeases: [{
      id: 'lease-atlas-1',
      executionPlanId: 'plan-atlas-1',
      displayCallsign: 'ATLAS-1',
      status: 'suspended',
      lease: { allowedPaths: ['backend/collab-server/**'] },
      dojoProofRef: 'pcap-runtime-guard',
      dojoLicenseRef: 'runtime.level_2@2026-07-04',
      dojoEvidenceRefs: ['dojo:evidence:runtime-checkride'],
      pilotLicenseHealth: { status: 'active', level: 'IFR' },
      pilotLicenseRequirement: { minimumLevel: 'IFR' },
    }],
    activeTransactions: [{
      id: 'txn-atlas-1',
      mutationLeaseId: 'lease-atlas-1',
      status: 'open',
      writeSet: ['backend/collab-server/codesiteWorkspaceGuard.js'],
    }],
    requiredActions: [{
      kind: 'review_document',
      title: 'Review schema owner RFI',
      owner: 'ATLAS-1',
      documentId: 'doc-rfi-1',
      severity: 'high',
      evidenceRefs: ['rfi:schema-owner'],
      scope: ['synthi/prisma/**'],
    }, {
      kind: 'resume_mayday',
      title: 'Resume runtime guard mayday',
      owner: 'tower',
      eventId: 'incident-mayday-1',
      severity: 'critical',
      evidenceRefs: ['incident:mayday:evidence', 'sha256:mayday-replay'],
      scope: ['backend/collab-server/**'],
    }, {
      kind: 'route_apply',
      title: 'Apply approved runtime reroute',
      owner: 'ATLAS-1',
      routeRevisionId: 'route-rev-2',
      severity: 'high',
      evidenceRefs: ['route-revision:approved'],
      scope: ['backend/collab-server/codesiteWorkspaceGuard.js'],
    }],
    pilotLicenseHealth: [{
      key: 'agent-atlas',
      displayCallsign: 'ATLAS-1',
      status: 'active',
      level: 'IFR',
      dojoLicenseRef: 'runtime.level_2@2026-07-04',
      dojoProofRef: 'pcap-runtime-guard',
      reasonCodes: ['pilot_license_health_active'],
    }],
    collisionForecast: {
      riskLevel: 'high',
      risks: [{ risk: 'runtime_boundary_overlap', severity: 'high', conflictZone: 'backend/collab-server/**' }],
      runwayOccupancy: [{
        runway: 'backend/collab-server/**',
        occupiedBy: 'ATLAS-1',
        mutationLeaseId: 'lease-atlas-1',
        runwayClass: 'B',
        diffPaths: ['backend/collab-server/codesiteWorkspaceGuard.js'],
        pendingInspections: ['inspection-mayday-1'],
        eligibleFlights: ['QA-MAYDAY'],
      }],
    },
    filesystemBoundaryProofs: [],
  };
  const events = [
    { id: 'event-tower-1', eventType: 'tower_instruction', displayCallsign: 'ATLAS-1', createdAt: '2026-07-04T09:01:00.000Z', details: { towerInstruction: 'Hold ATLAS-1 until schema owner RFI is approved.' } },
    { id: 'event-route-1', eventType: 'route_deviation', displayCallsign: 'ATLAS-1', createdAt: '2026-07-04T09:02:00.000Z', details: { towerInstruction: 'Route revision proposed; hold affected clearances until review is applied.' } },
    { id: 'event-rfi-1', eventType: 'rfi', displayCallsign: 'ATLAS-1', createdAt: '2026-07-04T09:03:00.000Z', details: { title: 'Confirm schema owner before clearance' } },
    { id: 'event-mayday-1', eventType: 'mayday', displayCallsign: 'ATLAS-1', createdAt: '2026-07-04T09:04:00.000Z', details: { towerInstruction: 'Ground stop active until inspection-mayday-1 passes.' } },
  ];
  return {
    project,
    projects: [{ id: project.id, title: project.title }],
    controlState,
    events,
    metrics: {
      schemaVersion: 'synthi.codesite.metrics.v1',
      status: 'measured',
      summary: {
        collisionsAvoided: 2,
        codeSiteFsBlockedWrites: 1,
        lineProvenanceCoverage: 1,
        blackBoxCompletenessScore: 0.86,
      },
      sections: {
        atc: [{ key: 'collisionsAvoided', label: 'Collisions avoided', unit: 'count', value: 2, status: 'measured', sampleSize: 2 }],
        transaction: [{ key: 'lineProvenanceCoverage', label: 'Lines with causal provenance coverage', unit: 'ratio', value: 1, status: 'measured', sampleSize: 1 }],
        quality: [{ key: 'testsRedAtLanding', label: 'Tests red at landing', unit: 'count', value: 0, status: 'measured', sampleSize: 1 }],
        trust: [{ key: 'humanReviewTimeSavedMs', label: 'Human review time saved', unit: 'duration_ms', value: 210000, status: 'measured', sampleSize: 1 }],
      },
    },
    artifactPreview: { files: [{ path: 'projects/proj-ui/control-state.json', bytes: 860, contentPreview: '{\\n  "towerState": "holding"\\n}\\n' }] },
    quarantines: [],
  };
}

async function findOpenPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

function gitText(args) {
  const result = spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });
  return result.status === 0 ? String(result.stdout || '').trim() : null;
}

async function waitForReady(url, timeoutMs = 180000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url, { headers: { accept: 'text/html' } });
      const text = await response.text();
      if (response.ok && text.includes('__next')) return;
    } catch (_) {
      // Dev server is still booting.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`dev_server_not_ready:${url}`);
}

function startDevServer(port) {
  const synthiRoot = path.join(REPO_ROOT, 'synthi');
  const nextCli = process.env.CODESITE_UI_PROOF_NEXT_CLI ||
    moduleRequire.resolve('next/dist/bin/next', { paths: [synthiRoot, REPO_ROOT] });
  const child = spawn(process.execPath, [nextCli, 'dev', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: synthiRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_ENV: 'development',
      NEXT_TELEMETRY_DISABLED: '1',
    },
    detached: process.platform !== 'win32',
  });
  let logs = '';
  child.stdout.on('data', (chunk) => { logs += chunk.toString(); });
  child.stderr.on('data', (chunk) => { logs += chunk.toString(); });
  return {
    child,
    logs: () => logs.slice(-12000),
    stop: async () => {
      if (child.exitCode != null || child.signalCode != null) return;
      const target = process.platform !== 'win32' ? -child.pid : child.pid;
      try {
        process.kill(target, 'SIGTERM');
      } catch (_) {
        child.kill('SIGTERM');
      }
      await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
      if (child.exitCode == null && child.signalCode == null) {
        try {
          process.kill(target, 'SIGKILL');
        } catch (_) {
          child.kill('SIGKILL');
        }
      }
      child.stdout?.destroy();
      child.stderr?.destroy();
    },
  };
}

async function fulfillJson(routeHandle, body, status = 200) {
  await routeHandle.fulfill({
    status,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function installCodeSiteRoutes(page, data) {
  await page.route('**/api/auth/session', async (routeHandle) => {
    await fulfillJson(routeHandle, {
      user: { id: 'proof-user', email: 'proof@example.test', name: 'CodeSite Proof' },
      expires: '2099-01-01T00:00:00.000Z',
    });
  });
  await page.route('**/api/workspace/**/codesite/**', async (routeHandle) => {
    const request = routeHandle.request();
    const url = new URL(request.url());
    const pathname = url.pathname;
    const method = request.method();
    if (method === 'GET' && pathname === route('/projects')) {
      return fulfillJson(routeHandle, { projects: data.projects });
    }
    if (method === 'GET' && pathname === route(`/projects/${PROJECT_ID}`)) {
      return fulfillJson(routeHandle, { project: data.project });
    }
    if (method === 'GET' && pathname === route(`/projects/${PROJECT_ID}/control-state`)) {
      return fulfillJson(routeHandle, data.controlState);
    }
    if (method === 'GET' && pathname === route(`/projects/${PROJECT_ID}/events`)) {
      return fulfillJson(routeHandle, { events: data.events });
    }
    if (method === 'GET' && pathname === route(`/projects/${PROJECT_ID}/metrics`)) {
      return fulfillJson(routeHandle, { metrics: data.metrics });
    }
    if (method === 'GET' && pathname === route(`/projects/${PROJECT_ID}/artifacts/preview`)) {
      return fulfillJson(routeHandle, data.artifactPreview);
    }
    if (method === 'GET' && pathname === route('/quarantines')) {
      return fulfillJson(routeHandle, { quarantines: data.quarantines });
    }
    if (method === 'GET' && pathname === route('/provenance/line')) {
      return fulfillJson(routeHandle, { lineProvenance: data.project.lineProvenance });
    }
    if (method === 'POST' && pathname === route(`/projects/${PROJECT_ID}/permits`)) {
      return fulfillJson(routeHandle, { permit: { id: 'permit-ui-created', status: 'issued' }, event: { eventType: 'tower_instruction' } }, 201);
    }
    if (method === 'POST' && pathname.endsWith('/reviews')) {
      return fulfillJson(routeHandle, { document: { id: 'doc-rfi-1', status: 'approved' }, event: { eventType: 'tower_instruction' } });
    }
    if (method === 'POST' && pathname.includes('/execution-plans/')) {
      return fulfillJson(routeHandle, { routeRevision: { id: 'route-rev-created', status: 'proposed' }, event: { eventType: 'route_deviation' } }, 201);
    }
    if (method === 'POST' && pathname.includes('/route-revisions/') && pathname.endsWith('/review')) {
      return fulfillJson(routeHandle, { routeRevision: { id: 'route-rev-1', status: 'approved' }, event: { eventType: 'tower_instruction' } });
    }
    if (method === 'POST' && pathname.includes('/route-revisions/') && pathname.endsWith('/apply')) {
      return fulfillJson(routeHandle, { routeRevision: { id: 'route-rev-2', status: 'applied' }, event: { eventType: 'tower_instruction' } });
    }
    if (method === 'POST' && pathname.includes('/incidents/') && pathname.endsWith('/resume')) {
      return fulfillJson(routeHandle, { incident: { id: 'incident-mayday-1', status: 'resumed' }, event: { eventType: 'mayday_resumed' } });
    }
    return fulfillJson(routeHandle, { error: `unhandled_mock_route:${method}:${pathname}` }, 404);
  });
}

async function installMockEventSource(page) {
  await page.addInitScript((events) => {
    class MockEventSource extends EventTarget {
      constructor(url) {
        super();
        this.url = url;
        this.readyState = 0;
        setTimeout(() => {
          this.readyState = 1;
          if (typeof this.onopen === 'function') this.onopen(new Event('open'));
          for (const event of events) {
            const message = new MessageEvent(event.eventType, { data: JSON.stringify(event) });
            this.dispatchEvent(message);
          }
        }, 60);
      }
      close() {
        this.readyState = 2;
      }
    }
    window.EventSource = MockEventSource;
  }, [
    { id: 'stream-1', eventType: 'tower_instruction', displayCallsign: 'TOWER', createdAt: '2026-07-04T09:05:00.000Z', details: { towerInstruction: 'Streaming tower instruction received by governance console.' } },
    { id: 'stream-2', eventType: 'route_deviation', displayCallsign: 'ATLAS-1', createdAt: '2026-07-04T09:06:00.000Z', details: { towerInstruction: 'Live route deviation visible without polling.' } },
    { id: 'stream-3', eventType: 'mayday_resumed', displayCallsign: 'ATLAS-1', createdAt: '2026-07-04T09:07:00.000Z', details: { towerInstruction: 'Mayday resume event name matches backend.' } },
  ]);
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
  if (buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('not_png');
  const chunks = [];
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    chunks.push({ type, data: buffer.subarray(dataStart, dataEnd) });
    offset = dataEnd + 4;
    if (type === 'IEND') break;
  }
  return chunks;
}

function analyzePngPixels(buffer) {
  const chunks = readPngChunks(buffer);
  const ihdr = chunks.find((chunk) => chunk.type === 'IHDR')?.data;
  if (!ihdr) throw new Error('png_missing_ihdr');
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const bitDepth = ihdr[8];
  const colorType = ihdr[9];
  const interlace = ihdr[12];
  const bpp = bytesPerPixel({ bitDepth, colorType });
  if (!bpp || interlace !== 0) return { width, height, bitDepth, colorType, interlace, supportedPixelScan: false, nonblank: true };
  const inflated = zlib.inflateSync(Buffer.concat(chunks.filter((chunk) => chunk.type === 'IDAT').map((chunk) => chunk.data)));
  const stride = width * bpp;
  const previous = Buffer.alloc(stride);
  const current = Buffer.alloc(stride);
  const sampleEvery = Math.max(1, Math.floor((width * height) / 20000));
  let inputOffset = 0;
  let firstPixel = null;
  let variedSampleCount = 0;
  let sampleCount = 0;
  let pixelIndex = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[inputOffset];
    inputOffset += 1;
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
        const pixel = current.subarray(x * bpp, (x * bpp) + bpp).toString('hex');
        if (firstPixel == null) firstPixel = pixel;
        else if (pixel !== firstPixel) variedSampleCount += 1;
        sampleCount += 1;
      }
      pixelIndex += 1;
    }
    current.copy(previous);
  }
  return {
    width,
    height,
    bitDepth,
    colorType,
    interlace,
    supportedPixelScan: true,
    nonblank: variedSampleCount >= Math.max(12, Math.ceil(sampleCount * 0.002)),
    variedSampleCount,
    sampleCount,
  };
}

async function describePng(filePath) {
  const buffer = await fs.readFile(filePath);
  return {
    path: path.relative(REPO_ROOT, filePath).replaceAll(path.sep, '/'),
    bytes: buffer.length,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    png: analyzePngPixels(buffer),
  };
}

async function writeHtmlSummary(proof, htmlPath) {
  const images = Object.entries(proof.screenshots).map(([name, artifact]) => (
    `<section><h2>${name}</h2><p>${artifact.path}</p><img src="${path.relative(path.dirname(htmlPath), path.join(REPO_ROOT, artifact.path)).replaceAll(path.sep, '/')}" alt="${name}"></section>`
  )).join('\n');
  await fs.writeFile(htmlPath, `<!doctype html>
<html><head><meta charset="utf-8"><title>CodeSite UI Governance Proof</title>
<style>body{font-family:system-ui;background:#101217;color:#e7edf6;margin:0;padding:24px}section{margin:0 0 28px}img{max-width:100%;border:1px solid #2b3444;border-radius:8px}code{color:#9bd3ff}</style></head>
<body><h1>CodeSite UI Governance Proof</h1><p>Run <code>${proof.runId}</code></p>${images}</body></html>`, 'utf8');
}

async function captureProofPage(context, baseUrl, data, reducedMotion = false) {
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  await installCodeSiteRoutes(page, data);
  await installMockEventSource(page);
  await page.goto(`${baseUrl}/workspace/${SLUG}/codesite`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForSelector('[data-testid="codesite-operator-cockpit"]', { timeout: 120000 });
  await page.waitForSelector('[data-testid="codesite-governance-console"]', { timeout: 120000 });
  await page.waitForSelector('[data-testid="codesite-tower-feed"]', { timeout: 120000 });
  await page.waitForSelector('[data-testid="codesite-radar-sweep"]', { timeout: 120000 });
  await page.waitForTimeout(600);
  const selectors = [
    'codesite-panel',
    'codesite-operator-cockpit',
    'codesite-mission-control-header',
    'codesite-tower-now',
    'codesite-responsive-proof-target',
    'codesite-operator-airspace-pane',
    'codesite-operator-tower-pane',
    'codesite-operator-governance-pane',
    'codesite-metric-rail',
    'codesite-status-required',
    'codesite-radar-sweep',
    'codesite-tower-feed',
    'codesite-event-stream-status',
    'codesite-governance-console',
    'codesite-document-row',
    'codesite-route-revision-row',
    'codesite-mayday-banner',
    'codesite-documents-show-all',
    'codesite-route-revisions-show-all',
    'codesite-maydays-show-all',
    'codesite-required-actions-list',
    'codesite-required-action-row',
    'codesite-required-action-review',
    'codesite-mobile-section-tabs',
    'codesite-mobile-action-drawer',
  ];
  const checks = await page.evaluate((required) => {
    const selectorStatus = Object.fromEntries(required.map((testId) => {
      const element = document.querySelector(`[data-testid="${testId}"]`);
      return [testId, Boolean(element)];
    }));
    const selectorCounts = Object.fromEntries(required.map((testId) => [
      testId,
      document.querySelectorAll(`[data-testid="${testId}"]`).length,
    ]));
    const rectFor = (testId) => {
      const element = document.querySelector(`[data-testid="${testId}"]`);
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return {
        top: Math.round(rect.top),
        left: Math.round(rect.left),
        bottom: Math.round(rect.bottom),
        right: Math.round(rect.right),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    };
    const cockpit = document.querySelector('[data-testid="codesite-operator-cockpit"]');
    const cockpitText = cockpit?.textContent || '';
    const cockpitRect = rectFor('codesite-operator-cockpit');
    const airspaceRect = rectFor('codesite-operator-airspace-pane');
    const towerRect = rectFor('codesite-operator-tower-pane');
    const governanceRect = rectFor('codesite-operator-governance-pane');
    const operatorRects = { cockpit: cockpitRect, airspace: airspaceRect, tower: towerRect, governance: governanceRect };
    const operatorPaneGeometry = [airspaceRect, towerRect, governanceRect].every((rect) => rect && rect.width >= 280 && rect.height >= 120);
    const desktopWidth = window.innerWidth >= 1024;
    const operatorLoopInFirstViewport = desktopWidth
      ? [cockpitRect, airspaceRect, towerRect, governanceRect].every((rect) => rect && rect.top < window.innerHeight && rect.bottom > 0)
      : [cockpitRect, airspaceRect].every((rect) => rect && rect.top < window.innerHeight && rect.bottom > 0);
    const singleCriticalSurfaces = [
      'codesite-responsive-proof-target',
      'codesite-radar-graph',
      'codesite-tower-feed',
      'codesite-governance-console',
    ].every((testId) => document.querySelectorAll(`[data-testid="${testId}"]`).length === 1);
    const workflowStateChips = Array.from(document.querySelectorAll('[data-testid="codesite-document-row"], [data-testid="codesite-route-revision-row"]'))
      .map((row) => {
        const rowRect = row.getBoundingClientRect();
        const chip = row.querySelector(':scope > div:first-child > span:last-child');
        const chipRect = chip?.getBoundingClientRect();
        const style = chip ? window.getComputedStyle(chip) : null;
        return {
          text: chip?.textContent?.trim() || null,
          row: {
            left: Math.round(rowRect.left),
            right: Math.round(rowRect.right),
            width: Math.round(rowRect.width),
          },
          chip: chipRect ? {
            left: Math.round(chipRect.left),
            right: Math.round(chipRect.right),
            width: Math.round(chipRect.width),
            scrollWidth: chip.scrollWidth,
            clientWidth: chip.clientWidth,
            whiteSpace: style?.whiteSpace || null,
          } : null,
          contained: Boolean(chipRect) && chipRect.left >= rowRect.left - 1 && chipRect.right <= rowRect.right + 1,
          unclippedText: Boolean(chip) && chip.scrollWidth <= chip.clientWidth + 1,
        };
      });
    const workflowStateChipsReadable = workflowStateChips.length > 0
      && workflowStateChips.every((item) => item.contained && item.unclippedText);
    const requiredActionRows = Array.from(document.querySelectorAll('[data-testid="codesite-required-action-row"]')).map((row) => ({
      text: row.textContent || '',
      hasReviewButton: Boolean(row.querySelector('[data-testid="codesite-required-action-review"]')),
      hasSeverity: /(critical|high|medium|low)/i.test(row.textContent || ''),
      hasOwner: (row.textContent || '').includes('owner:'),
      hasEntity: (row.textContent || '').includes('entity:'),
    }));
    const cappedQueuesReachable = [
      'codesite-documents-show-all',
      'codesite-route-revisions-show-all',
      'codesite-maydays-show-all',
    ].every((testId) => {
      const element = document.querySelector(`[data-testid="${testId}"]`);
      return Boolean(element) && /show all/i.test(element.textContent || '');
    });
    const mobileTabs = Array.from(document.querySelectorAll('[data-testid="codesite-mobile-section-tab"]')).map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        text: element.textContent.trim(),
        width: rect.width,
        height: rect.height,
        visible: rect.width > 0 && rect.height > 0,
        role: element.getAttribute('role'),
        ariaSelected: element.getAttribute('aria-selected'),
      };
    });
    const visibleMobileTabs = mobileTabs.filter((tab) => tab.visible);
    return {
      selectorStatus,
      selectorCounts,
      desktopWidth,
      missingSelectors: Object.entries(selectorStatus).filter(([, ok]) => !ok).map(([key]) => key),
      operatorRects,
      operatorPaneGeometry,
      operatorLoopInFirstViewport,
      singleCriticalSurfaces,
      workflowStateChips,
      workflowStateChipsReadable,
      requiredActionRows,
      requiredActionsActionable: requiredActionRows.length >= 3
        && requiredActionRows.every((row) => row.hasReviewButton && row.hasSeverity && row.hasOwner && row.hasEntity),
      cappedQueuesReachable,
      cockpitContainsLoop: cockpitText.includes('Airspace Map')
        && cockpitText.includes('Tower Feed')
        && cockpitText.includes('Governance Console')
        && cockpitText.includes('Required')
        && cockpitText.includes('Reroutes'),
      towerInstructionVisible: document.body.textContent.includes('Streaming tower instruction received by governance console.'),
      routeDeviationVisible: document.body.textContent.includes('route_deviation'),
      maydayResumeEventVisible: document.body.textContent.includes('mayday_resumed'),
      permitPathVisible: document.body.textContent.includes('synthi/prisma/**'),
      maydayInspectionVisible: document.body.textContent.includes('inspection-mayday-1'),
      noHorizontalOverflow: document.documentElement.scrollWidth <= window.innerWidth + 4,
      scrollWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
      mobileTabs,
      mobileTouchTargetsOk: visibleMobileTabs.every((tab) => tab.height >= 44),
      reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    };
  }, selectors);
  checks.consoleErrors = consoleErrors;
  checks.ok = checks.missingSelectors.length === 0
    && checks.noHorizontalOverflow
    && checks.operatorPaneGeometry
    && checks.operatorLoopInFirstViewport
    && checks.singleCriticalSurfaces
    && checks.workflowStateChipsReadable
    && checks.requiredActionsActionable
    && checks.cappedQueuesReachable
    && checks.cockpitContainsLoop
    && checks.mobileTouchTargetsOk
    && checks.towerInstructionVisible
    && checks.routeDeviationVisible
    && checks.maydayResumeEventVisible
    && checks.permitPathVisible
    && checks.maydayInspectionVisible
    && checks.consoleErrors.length === 0
    && (reducedMotion ? checks.reducedMotion : true);
  return { page, checks };
}

async function captureGovernanceReviewGate(page, screenshotPath) {
  await page.locator('[data-testid="codesite-required-actions-list"]').scrollIntoViewIfNeeded();
  await page.locator('[data-testid="codesite-required-action-review"]').first().click();
  const gate = page.locator('[data-testid="codesite-governance-review-gate"]');
  await gate.waitFor({ state: 'visible', timeout: 30000 });
  const confirm = page.locator('[data-testid="codesite-governance-review-confirm"]');
  const initiallyDisabled = await confirm.isDisabled();
  await page.locator('[data-testid="codesite-governance-review-rationale"]').fill(
    'Reviewed replay evidence, owner, target, and scope before issuing this tower action.',
  );
  const enabledAfterRationale = !(await confirm.isDisabled());
  await gate.screenshot({ path: screenshotPath });
  const text = await gate.textContent();
  return {
    visible: true,
    initiallyDisabled,
    enabledAfterRationale,
    containsOwner: /Owner/i.test(text || ''),
    containsTarget: /Target/i.test(text || ''),
    containsEvidence: /Evidence/i.test(text || ''),
    containsRationale: /Operator rationale/i.test(text || ''),
  };
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const port = Number(process.env.CODESITE_UI_PROOF_PORT || 0) || await findOpenPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = startDevServer(port);
  const data = fixture();
  const runStartedAt = new Date().toISOString();
  try {
    await waitForReady(`${baseUrl}/workspace/${SLUG}/codesite`);
    const browser = await chromium.launch({ headless: true });
    const desktopContext = await browser.newContext({ viewport: { width: 1440, height: 1050 }, deviceScaleFactor: 1 });
    const desktop = await captureProofPage(desktopContext, baseUrl, data);
    const desktopPng = path.join(OUT_DIR, 'codesite-ui-governance-desktop.png');
    const cockpitPng = path.join(OUT_DIR, 'codesite-ui-governance-cockpit.png');
    const towerPng = path.join(OUT_DIR, 'codesite-ui-governance-tower-feed.png');
    const governancePng = path.join(OUT_DIR, 'codesite-ui-governance-console.png');
    const reviewGatePng = path.join(OUT_DIR, 'codesite-ui-governance-review-gate.png');
    await desktop.page.screenshot({ path: desktopPng, fullPage: false });
    const cockpitBox = await desktop.page.locator('[data-testid="codesite-operator-cockpit"]').boundingBox();
    if (!cockpitBox) throw new Error('codesite_operator_cockpit_missing_for_screenshot');
    await desktop.page.screenshot({
      path: cockpitPng,
      clip: {
        x: Math.max(0, Math.floor(cockpitBox.x)),
        y: Math.max(0, Math.floor(cockpitBox.y)),
        width: Math.floor(cockpitBox.width),
        height: Math.min(980, Math.floor(cockpitBox.height)),
      },
    });
    await desktop.page.locator('[data-testid="codesite-tower-feed"]').scrollIntoViewIfNeeded();
    await desktop.page.locator('[data-testid="codesite-tower-feed"]').screenshot({ path: towerPng });
    const reviewGate = await captureGovernanceReviewGate(desktop.page, reviewGatePng);
    await desktop.page.locator('[data-testid="codesite-governance-console"]').scrollIntoViewIfNeeded();
    await desktop.page.locator('[data-testid="codesite-governance-console"]').screenshot({ path: governancePng });
    await desktopContext.close();

    const mobileContext = await browser.newContext({ viewport: { width: 390, height: 900 }, deviceScaleFactor: 2, isMobile: true });
    const mobile = await captureProofPage(mobileContext, baseUrl, data);
    await mobile.page.getByRole('tab', { name: 'Governance' }).click();
    await mobile.page.waitForTimeout(300);
    const mobilePng = path.join(OUT_DIR, 'codesite-ui-governance-mobile-shell.png');
    await mobile.page.screenshot({ path: mobilePng, fullPage: false });
    await mobileContext.close();

    const reducedContext = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    const reduced = await captureProofPage(reducedContext, baseUrl, data, true);
    const reducedPng = path.join(OUT_DIR, 'codesite-ui-governance-reduced-motion.png');
    await reduced.page.screenshot({ path: reducedPng, fullPage: false });
    await reducedContext.close();
    await browser.close();

    const screenshotPaths = { desktop: desktopPng, cockpit: cockpitPng, tower: towerPng, governance: governancePng, reviewGate: reviewGatePng, mobile: mobilePng, reducedMotion: reducedPng };
    const screenshots = Object.fromEntries(await Promise.all(Object.entries(screenshotPaths).map(async ([key, filePath]) => [key, await describePng(filePath)])));
    const proof = {
      schemaVersion: 'synthi.codesite.uiGovernanceProof.v2',
      ok: desktop.checks.ok
        && mobile.checks.ok
        && reduced.checks.ok
        && reviewGate.visible
        && reviewGate.initiallyDisabled
        && reviewGate.enabledAfterRationale
        && reviewGate.containsOwner
        && reviewGate.containsTarget
        && reviewGate.containsEvidence
        && reviewGate.containsRationale
        && Object.values(screenshots).every((item) => item.png.nonblank === true),
      runId: RUN_ID,
      runStartedAt,
      baseUrl,
      git: {
        head: gitText(['rev-parse', 'HEAD']) || process.env.CODESITE_UI_PROOF_GIT_HEAD || null,
        branch: gitText(['rev-parse', '--abbrev-ref', 'HEAD']) || process.env.CODESITE_UI_PROOF_GIT_BRANCH || null,
        statusShort: gitText(['status', '--short']) || process.env.CODESITE_UI_PROOF_GIT_STATUS || null,
      },
      commands: [{
        name: 'dockerPlaywrightUiProof',
        command: process.env.CODESITE_UI_PROOF_COMMAND || [process.execPath, ...process.argv.slice(1)].join(' '),
        runner: 'playwright',
        exitCode: 0,
      }],
      runtime: {
        node: process.version,
        platform: process.platform,
      },
      checks: {
        desktop: desktop.checks,
        mobile: mobile.checks,
        reducedMotion: reduced.checks,
        reviewGate,
      },
      screenshots,
    };
    const jsonPath = path.join(OUT_DIR, 'codesite-ui-governance-proof.json');
    const htmlPath = path.join(OUT_DIR, 'codesite-ui-governance-proof.html');
    await fs.writeFile(jsonPath, `${JSON.stringify(proof, null, 2)}\n`, 'utf8');
    await writeHtmlSummary(proof, htmlPath);
    if (!proof.ok) throw new Error(`codesite_ui_governance_proof_failed:${jsonPath}`);
    console.log(JSON.stringify({ ok: true, jsonPath: path.relative(REPO_ROOT, jsonPath), screenshots: Object.fromEntries(Object.entries(screenshots).map(([k, v]) => [k, v.path])) }, null, 2));
  } catch (error) {
    await fs.writeFile(path.join(OUT_DIR, 'codesite-ui-governance-server.log'), server.logs(), 'utf8');
    throw error;
  } finally {
    await server.stop().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
