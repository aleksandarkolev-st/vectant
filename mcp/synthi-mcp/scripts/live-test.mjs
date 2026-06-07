#!/usr/bin/env node
// Synthi MCP live-test harness — comprehensive end-to-end tool coverage.
//
// Preconditions the script assumes are ALREADY satisfied:
//   - signaling-server running in WSL on :9000  (ws://localhost:9000)
//   - worker running in WSL (connected to above signaling)
//   - collab-server running in Windows Docker on :1234
//   - redis / y-sweet / ai-engine / gateway / frontend all up
//   - `pnpm build` has produced dist/index.js in this package
//
// Env vars (with defaults):
//   FRONTEND_URL           http://localhost:3000   (Next.js /api/workspace POST)
//   COLLAB_URL             http://localhost:1234   (collab-server /git/:slug/write-files-batch)
//   SIGNALING_URL          ws://localhost:9000     (MCP → signaling)
//   PROMETHEUS_PORT        9464                    (MCP /metrics)
//   GOOGLE_API_KEY         (required)              (Gemini API key)
//   SYNTHI_GPU_SPLIT_MODEL gemini-3.5-flash
//   SYNTHI_GPU_DELTA_MODEL gemini-3.1-flash-lite
//   SLUG                   mcp-counter-<ts>        (per-run unique to avoid collisions)
//   WORKSPACE_NAME         Synthi MCP Live Test
//   HOST_ID                mcp-live-test
//   MCP_ENTRY              ../dist/index.js
//   FIXTURE_PATH           ../tests/fixtures/button/main.cpp
//   FRONTEND_PRECOMPILED   false
//   HMR_TIMEOUT_MS         60000
//
// Tools exercised (29 total):
//   Phase A  synthi_attach
//   Phase B  synthi_health, synthi_checkpoint
//   Phase C  synthi_screenshot, synthi_describe (agent_side + server_side)
//   Phase D  synthi_get_source_state, synthi_get_usage, synthi_get_event_log
//   Phase E  synthi_locate
//   Phase F  synthi_set_quality
//   Phase G  synthi_acquire_input, synthi_release_input
//   Phase H  synthi_mouse, synthi_click, synthi_keyboard (type/key/chord), synthi_type
//   Phase I  synthi_verify (element_visible, scene_matches)
//   Phase J  synthi_compile, synthi_wait_hmr
//   Phase K  synthi_wait (motion_settled), synthi_screenshot (post-edit + pHash)
//   Phase L  synthi_report_source_state, synthi_get_source_state (post-edit)
//   Phase M  synthi_get_crash_info, synthi_acknowledge_disruption
//   Phase N  synthi_request_human, synthi_annotate_and_ask, synthi_recent_human_actions
//   Phase O  synthi_get_event_log (all), synthi_get_usage (final), synthi_checkpoint
//   Phase P  Prometheus /metrics scrape
//   Phase Q  synthi_reset_guest, synthi_reconnect, synthi_screenshot, synthi_detach

import { spawn, exec } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import {
  mcpScreenshotArgsForFrameGate,
} from './lib/gpu-hmr-visual-evidence.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CFG = {
  frontendUrl: process.env.FRONTEND_URL ?? 'http://localhost:3000',
  collabUrl: process.env.COLLAB_URL ?? 'http://localhost:1234',
  signalingUrl: process.env.SIGNALING_URL ?? 'ws://localhost:9000',
  prometheusPort: Number(process.env.PROMETHEUS_PORT ?? 9464),
  googleApiKey: process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY ?? '',
  geminiModel: process.env.SYNTHI_GEMINI_MODEL ?? process.env.SYNTHI_GPU_SPLIT_MODEL ?? 'gemini-3.5-flash',
  gpuSplitModel: process.env.SYNTHI_GPU_SPLIT_MODEL
    ?? process.env.SYNTHI_GEMINI_MODEL
    ?? 'gemini-3.5-flash',
  gpuDeltaModel: process.env.SYNTHI_GPU_DELTA_MODEL
    ?? process.env.SYNTHI_GEMINI_DELTA_MODEL
    ?? 'gemini-3.1-flash-lite',
  slug: process.env.SLUG ?? `mcp-counter-${Date.now()}`,
  workspaceName: process.env.WORKSPACE_NAME ?? 'Synthi MCP Live Test',
  hostId: process.env.HOST_ID ?? 'mcp-live-test',
  mcpEntry: path.resolve(__dirname, process.env.MCP_ENTRY ?? '../dist/index.js'),
  fixturePath: path.resolve(__dirname, process.env.FIXTURE_PATH ?? '../tests/fixtures/button/main.cpp'),
  frontendPrecompiled: (process.env.FRONTEND_PRECOMPILED ?? 'false').toLowerCase() === 'true',
  hmrTimeoutMs: Number(process.env.HMR_TIMEOUT_MS ?? 60000),
  frameGateTimeoutMs: Number(process.env.SYNTHI_LIVE_TEST_FRAME_GATE_TIMEOUT_MS ?? 1200000),
  syncToGcs: 'true',
  mcpTransport: (process.env.MCP_TRANSPORT ?? 'docker').toLowerCase(),
  mcpContainer: process.env.MCP_CONTAINER ?? 'synthi-ide-mcp-1',
  mcpSignalingUrl: process.env.MCP_SIGNALING_URL ?? 'ws://signaling-server:9000',
  turnUrl: process.env.SYNTHI_TURN_URL ?? 'turn:localhost:3478',
  turnUser: process.env.SYNTHI_TURN_USERNAME ?? 'synthi',
  turnCred: process.env.SYNTHI_TURN_CREDENTIAL ?? 'synthi',
  stunUrl: process.env.SYNTHI_STUN_URL ?? 'stun:stun.l.google.com:19302',
  autoOpen: false,
  presenceTimeoutMs: Number(process.env.PRESENCE_TIMEOUT_MS ?? 60_000),
  compileWarmupMs: Number(process.env.COMPILE_WARMUP_MS ?? 8_000),
};

const LOG_DIR = path.resolve(__dirname, '../.live-test-logs');
const ARTIFACT_DIR = path.resolve(__dirname, '../.live-test-artifacts');

// ───────────────────────── helpers ─────────────────────────

const color = {
  reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m',
  yellow: '\x1b[33m', blue: '\x1b[36m', dim: '\x1b[2m',
};
function log(kind, msg) {
  const tag = { info: color.blue + '[i]', ok: color.green + '[✓]',
                warn: color.yellow + '[!]', fail: color.red + '[✗]' }[kind];
  console.log(`${tag}${color.reset} ${msg}`);
}
function fail(msg, err) {
  log('fail', msg);
  if (err) console.error(err.stack ?? err);
  process.exitCode = 1;
  throw new Error(msg);
}

async function httpJson(method, url, body, headers = {}) {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = null; }
  if (!res.ok) {
    throw new Error(`${method} ${url} → ${res.status}: ${text.slice(0, 500)}`);
  }
  return json ?? {};
}

async function createWorkspaceGcs({ frontendUrl, name, slug, repoUrl }) {
  return httpJson('POST', `${frontendUrl}/api/workspace`, { name, slug, repoUrl });
}

async function uploadFileGcs({ frontendUrl, workspaceId, filePath, content, contentType = 'text/plain' }) {
  const form = new FormData();
  form.set('filePath', filePath);
  form.set('file', new Blob([content], { type: contentType }), filePath.split('/').pop());
  const res = await fetch(`${frontendUrl}/api/workspace/${encodeURIComponent(workspaceId)}/item`, {
    method: 'POST', body: form,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`upload ${filePath} → ${res.status}: ${text.slice(0, 500)}`);
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

async function stageAndCommit({ collabUrl, slug, userId, message }) {
  await httpJson('POST', `${collabUrl}/git/${slug}/stage-all`, {}, { 'x-user-id': userId });
  await httpJson('POST', `${collabUrl}/git/${slug}/commit`, { message }, { 'x-user-id': userId });
}

async function writeFilesBatchCollab({ collabUrl, slug, userId, files, syncToGcs }) {
  const res = await httpJson(
    'POST',
    `${collabUrl}/git/${slug}/write-files-batch`,
    {
      files: files.map((f) => ({ path: f.path, encoding: f.encoding ?? 'utf8', content: f.content })),
      syncToGcs: syncToGcs === true,
    },
    { 'x-user-id': userId },
  );
  const written = res.written?.length ?? 0;
  const skipped = res.skipped?.length ?? 0;
  const gcsErrs = (res.errors ?? []).filter((e) => e.stage === 'gcs_upload');
  const otherErrs = (res.errors ?? []).filter((e) => e.stage !== 'gcs_upload');
  return { written, skipped, gcsErrs, otherErrs, raw: res };
}

async function createFolderGcs({ frontendUrl, workspaceId, folderPath }) {
  const trailing = folderPath.endsWith('/') ? folderPath : folderPath + '/';
  const form = new FormData();
  form.set('filePath', trailing);
  const res = await fetch(`${frontendUrl}/api/workspace/${encodeURIComponent(workspaceId)}/item`, {
    method: 'POST', body: form,
  });
  const text = await res.text();
  if (!res.ok && res.status !== 409) {
    throw new Error(`folder ${trailing} → ${res.status}: ${text.slice(0, 500)}`);
  }
  return { already: res.status === 409 };
}

function tcpPing(host, port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const s = net.createConnection({ host, port });
    const t = setTimeout(() => { s.destroy(); resolve(false); }, timeoutMs);
    s.once('connect', () => { clearTimeout(t); s.end(); resolve(true); });
    s.once('error', () => { clearTimeout(t); resolve(false); });
  });
}

function openBrowser(url) {
  const plat = process.platform;
  let cmd;
  if (plat === 'win32') {
    cmd = `start chrome "${url}"`;
    return exec(cmd, { windowsHide: true });
  } else if (plat === 'darwin') {
    return exec(`open -a "Google Chrome" "${url}"`);
  } else {
    return exec(`xdg-open "${url}"`);
  }
}

async function validatePeerIdWire({ signalingUrl, sessionId }) {
  function registerOne(tag) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(signalingUrl);
      const timer = setTimeout(() => {
        try { ws.close(); } catch { /* ignored */ }
        reject(new Error(`peer_id handshake for ${tag} timed out after 5s`));
      }, 5000);
      ws.on('open', () => {
        ws.send(JSON.stringify({
          type: 'register',
          role: 'observer',
          session_id: sessionId,
          client_version: `synthi-live-test/peer-id-probe-${tag}`,
        }));
      });
      ws.on('message', (data) => {
        let msg;
        try { msg = JSON.parse(data.toString('utf8')); } catch { return; }
        if (msg?.type !== 'registered') return;
        clearTimeout(timer);
        const peerId = typeof msg.peer_id === 'string' ? msg.peer_id : null;
        try { ws.close(); } catch { /* ignored */ }
        if (!peerId) reject(new Error(`registered ack missing peer_id (${tag})`));
        else resolve({ tag, peerId, ws: null });
      });
      ws.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
  }
  const [a, b] = await Promise.all([registerOne('obs-a'), registerOne('obs-b')]);
  if (!a.peerId || !b.peerId) {
    throw new Error(`expected peer_id on both acks; got a=${a.peerId}, b=${b.peerId}`);
  }
  if (a.peerId === b.peerId) {
    throw new Error(`signaling reused peer_id across observers: ${a.peerId}`);
  }
  return { peerIdA: a.peerId, peerIdB: b.peerId };
}

async function waitForBrowserPeer({ signalingUrl, sessionId, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(signalingUrl);
    const startedAt = Date.now();
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* ignored */ }
      reject(new Error(`no browser peer on session '${sessionId}' after ${timeoutMs}ms`));
    }, timeoutMs);
    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'register', role: 'observer', session_id: sessionId,
        client_version: 'synthi-live-test/presence-probe',
      }));
    });
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString('utf8')); } catch { return; }
      if (msg?.type !== 'presence') return;
      if (typeof msg.attached_humans !== 'number') return;
      if (msg.attached_humans >= 1) {
        clearTimeout(timer);
        const elapsed = Date.now() - startedAt;
        try { ws.close(); } catch { /* ignored */ }
        resolve({ humans: msg.attached_humans, agents: msg.attached_agents ?? 0, elapsedMs: elapsed });
      }
    });
    ws.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

function parseUrl(u) {
  const x = new URL(u);
  return { host: x.hostname, port: Number(x.port) || (x.protocol === 'wss:' || x.protocol === 'https:' ? 443 : 80) };
}

async function avgHash(pngBase64) {
  const { default: sharp } = await import('sharp');
  const buf = Buffer.from(pngBase64, 'base64');
  const raw = await sharp(buf).greyscale().resize(8, 8, { fit: 'fill' }).raw().toBuffer();
  const avg = raw.reduce((a, b) => a + b, 0) / raw.length;
  let hash = 0n;
  for (let i = 0; i < 64; i++) hash = (hash << 1n) | (raw[i] > avg ? 1n : 0n);
  return hash;
}
function hamming(a, b) {
  let x = a ^ b, n = 0;
  while (x) { n += Number(x & 1n); x >>= 1n; }
  return n;
}

// ───────────────────────── fixture-truth validators ─────────────────────────
// The harness knows exactly what tests/fixtures/button/main.cpp renders, so
// every tool response that returns a semantic payload (locate bbox, describe
// summary, screenshot pixels, source_state hash) can be checked against
// ground truth here — not just "tool returned ok:true".
const FIXTURE = {
  width: 800,
  height: 600,
  bgColor: [32, 32, 32],
  bgSample: { x: 50, y: 50 },
  blueButton: {
    bbox: { x: 150, y: 120, w: 500, h: 160 },
    center: { x: 400, y: 200 },
    color: [40, 120, 220],
  },
  redButton: {
    bbox: { x: 150, y: 320, w: 500, h: 160 },
    center: { x: 400, y: 400 },
    color: [220, 40, 40],
  },
};

async function decodeRgb(pngBase64) {
  const { default: sharp } = await import('sharp');
  const buf = Buffer.from(pngBase64, 'base64');
  const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

function pixelAt(img, x, y) {
  const cx = Math.max(0, Math.min(img.width - 1, x));
  const cy = Math.max(0, Math.min(img.height - 1, y));
  const i = (cy * img.width + cx) * img.channels;
  return { r: img.data[i], g: img.data[i + 1], b: img.data[i + 2] };
}

// Average a small box so VLM encode noise + chroma subsampling don't flap.
function avgBox(img, x, y, r = 4) {
  let R = 0, G = 0, B = 0, n = 0;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const p = pixelAt(img, x + dx, y + dy);
      R += p.r; G += p.g; B += p.b; n++;
    }
  }
  return { r: Math.round(R / n), g: Math.round(G / n), b: Math.round(B / n) };
}

function colorNear(actual, target, tol) {
  return Math.abs(actual.r - target[0]) <= tol &&
         Math.abs(actual.g - target[1]) <= tol &&
         Math.abs(actual.b - target[2]) <= tol;
}

function bboxIoU(a, b) {
  const ix1 = Math.max(a.x, b.x), iy1 = Math.max(a.y, b.y);
  const ix2 = Math.min(a.x + a.w, b.x + b.w);
  const iy2 = Math.min(a.y + a.h, b.y + b.h);
  const iw = Math.max(0, ix2 - ix1), ih = Math.max(0, iy2 - iy1);
  const inter = iw * ih;
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

// ───────────────────────── JSON-RPC client over stdio ─────────────────────────

class McpClient {
  constructor(proc) {
    this.proc = proc;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    this.stderrTail = [];
    proc.stdout.on('data', (chunk) => this.onData(chunk.toString()));
    proc.stderr.on('data', (chunk) => {
      const s = chunk.toString();
      this.stderrTail.push(s);
      if (this.stderrTail.length > 50) this.stderrTail.shift();
      if (process.env.MCP_VERBOSE) process.stderr.write(color.dim + '[mcp] ' + color.reset + s);
    });
    proc.on('exit', (code, sig) => {
      for (const [, p] of this.pending) p.reject(new Error(`MCP exited ${code ?? sig} before response`));
      this.pending.clear();
    });
  }

  onData(text) {
    this.buffer += text;
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`MCP error: ${JSON.stringify(msg.error)}`));
        else p.resolve(msg.result);
      }
    }
  }

  request(method, params = {}, timeoutMs = 90000) {
    const id = this.nextId++;
    const frame = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request ${method} timed out after ${timeoutMs}ms. stderr tail:\n${this.stderrTail.slice(-10).join('')}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(t); resolve(v); },
        reject: (e) => { clearTimeout(t); reject(e); },
      });
      this.proc.stdin.write(JSON.stringify(frame) + '\n');
    });
  }

  async toolCall(name, args) {
    const res = await this.request('tools/call', { name, arguments: args });
    const content = Array.isArray(res?.content) ? res.content : [];
    const textBlock = content.find((b) => b?.type === 'text');
    if (res.isError) {
      const errMsg = textBlock?.text || JSON.stringify(res.content);
      throw new Error(`tool ${name} isError: ${errMsg}`);
    }
    const imageBlock = content.find((b) => b?.type === 'image');
    let parsed;
    if (textBlock?.text) {
      try { parsed = JSON.parse(textBlock.text); }
      catch { parsed = { raw: textBlock.text }; }
    } else {
      parsed = {};
    }
    if (imageBlock?.data) parsed.data = imageBlock.data;
    return parsed;
  }
}

// ───────────────────────── main flow ─────────────────────────

async function main() {
  console.log(color.blue + '\n━━━ Synthi MCP live-test (comprehensive) ━━━' + color.reset);
  console.log(`  slug         ${CFG.slug}`);
  console.log(`  workspace    ${CFG.workspaceName}`);
  console.log(`  gemini       ${CFG.geminiModel}`);
  console.log(`  mcp entry    ${CFG.mcpEntry}`);
  console.log('');

  if (!CFG.googleApiKey) fail('GOOGLE_API_KEY or GEMINI_API_KEY not set. Export one and re-run.');
  if (!existsSync(CFG.mcpEntry)) fail(`MCP entry not found: ${CFG.mcpEntry}\n  → run: pnpm build`);
  if (!existsSync(CFG.fixturePath)) fail(`Fixture not found: ${CFG.fixturePath}`);

  await mkdir(LOG_DIR, { recursive: true });
  await mkdir(ARTIFACT_DIR, { recursive: true });

  // 1. Preflight
  log('info', 'Preflight: frontend + collab + signaling reachable?');
  const fe = parseUrl(CFG.frontendUrl);
  const col = parseUrl(CFG.collabUrl);
  const sig = parseUrl(CFG.signalingUrl);
  const [feOk, colOk, sigOk] = await Promise.all([
    tcpPing(fe.host, fe.port), tcpPing(col.host, col.port), tcpPing(sig.host, sig.port),
  ]);
  if (!feOk) fail(`frontend unreachable at ${CFG.frontendUrl}`);
  if (!colOk) fail(`collab-server unreachable at ${CFG.collabUrl}`);
  if (!sigOk) fail(`signaling unreachable at ${CFG.signalingUrl}`);
  log('ok', `frontend:${fe.port} + collab:${col.port} + signaling:${sig.port} all up`);

  // 1b. Phase-B peer_id wire smoke
  log('info', 'Phase-B peer_id wire: registering two observers on a probe session');
  try {
    const probeSid = `peer-id-probe-${Date.now()}`;
    const { peerIdA, peerIdB } = await validatePeerIdWire({ signalingUrl: CFG.signalingUrl, sessionId: probeSid });
    log('ok', `peer_id round-trip: a=${peerIdA.slice(0, 8)}… b=${peerIdB.slice(0, 8)}… (distinct ✓)`);
  } catch (e) {
    fail(`peer_id wire validation failed: ${e.message}`);
  }

  // 2. Create workspace
  log('info', `POST /api/workspace  {name, slug:"${CFG.slug}"}`);
  const fixture = await readFile(CFG.fixturePath, 'utf8');
  let workspace;
  try {
    workspace = await createWorkspaceGcs({ frontendUrl: CFG.frontendUrl, name: CFG.workspaceName, slug: CFG.slug });
  } catch (e) {
    fail(`workspace create failed: ${e.message}`);
  }
  log('ok', `workspace id=${workspace.id}  slug=${workspace.slug}`);

  // 3. Seed fixture
  log('info', `POST /git/:slug/write-files-batch (syncToGcs:${CFG.syncToGcs})`);
  {
    const r = await writeFilesBatchCollab({
      collabUrl: CFG.collabUrl, slug: CFG.slug, userId: CFG.hostId,
      files: [{ path: 'main.cpp', content: fixture }], syncToGcs: CFG.syncToGcs,
    });
    if (r.otherErrs.length) fail(`write-files-batch hard errors: ${JSON.stringify(r.otherErrs)}`);
    log('ok', `main.cpp written to collab-server disk`);
  }

  // 3b. Commit
  log('info', 'stage-all + commit');
  await stageAndCommit({ collabUrl: CFG.collabUrl, slug: CFG.slug, userId: CFG.hostId, message: 'mcp-live-test: seed fixture' });
  log('ok', 'seed committed');

  if (!CFG.frontendPrecompiled) {
    const workspaceUrl = `${CFG.frontendUrl}/workspace/${CFG.slug}`;
    if (CFG.autoOpen) {
      log('info', `Auto-open: launching OS default browser → ${workspaceUrl}`);
      try { openBrowser(workspaceUrl); } catch (e) { log('warn', `openBrowser failed: ${e.message}`); }
      log('info', `Waiting for browser peer (timeout ${CFG.presenceTimeoutMs}ms)`);
      try {
        const p = await waitForBrowserPeer({ signalingUrl: CFG.signalingUrl, sessionId: CFG.slug, timeoutMs: CFG.presenceTimeoutMs });
        log('ok', `browser peer detected after ${p.elapsedMs}ms`);
      } catch (e) {
        log('warn', `presence poll failed: ${e.message}`);
        process.stdout.write('    Press ENTER to continue: ');
        await new Promise((r) => process.stdin.once('data', r));
      }
      log('info', `Warmup sleep ${CFG.compileWarmupMs}ms`);
      await sleep(CFG.compileWarmupMs);
    } else {
      console.log('');
      log('warn', 'Initial compile is frontend-driven. Options:');
      console.log('    (a) In the browser, open the workspace:');
      console.log(`        ${workspaceUrl}`);
      console.log('        Wait until the button fixture is visibly rendering, then press ENTER here.');
      console.log('    (b) Skip — synthi_attach will hang until a frame arrives.');
      console.log('');
      process.stdout.write('    Press ENTER when the workspace shows the blue button, or Ctrl-C to abort: ');
      await new Promise((r) => process.stdin.once('data', r));
    }
  }

  // 4. Spawn MCP
  let mcp;
  if (CFG.mcpTransport === 'docker') {
    log('info', `Spawning MCP via docker exec → container=${CFG.mcpContainer}`);
    const mcpEnv = {
      SYNTHI_SESSION_ID: CFG.slug,
      SYNTHI_SIGNALING_URL: CFG.mcpSignalingUrl,
      SYNTHI_VISION_BACKEND: 'gemini_api',
      GOOGLE_API_KEY: CFG.googleApiKey,
      SYNTHI_GEMINI_MODEL: CFG.geminiModel,
      SYNTHI_GPU_SPLIT_MODEL: CFG.gpuSplitModel,
      SYNTHI_GPU_DELTA_MODEL: CFG.gpuDeltaModel,
      SYNTHI_PROMETHEUS_PORT: String(CFG.prometheusPort),
      SYNTHI_PROMETHEUS_HOST: '0.0.0.0',
      SYNTHI_STUN_URL: CFG.stunUrl,
    };
    const args = ['exec', '-i'];
    for (const [k, v] of Object.entries(mcpEnv)) args.push('-e', `${k}=${v}`);
    args.push(CFG.mcpContainer, 'node', '/app/dist/index.js');
    mcp = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
  } else {
    log('info', 'Spawning MCP subprocess (host transport)');
    const env = {
      ...process.env,
      SYNTHI_SESSION_ID: CFG.slug,
      SYNTHI_SIGNALING_URL: CFG.signalingUrl,
      SYNTHI_VISION_BACKEND: 'gemini_api',
      GOOGLE_API_KEY: CFG.googleApiKey,
      SYNTHI_GEMINI_MODEL: CFG.geminiModel,
      SYNTHI_GPU_SPLIT_MODEL: CFG.gpuSplitModel,
      SYNTHI_GPU_DELTA_MODEL: CFG.gpuDeltaModel,
      SYNTHI_PROMETHEUS_PORT: String(CFG.prometheusPort),
      SYNTHI_PROMETHEUS_HOST: '127.0.0.1',
      SYNTHI_STUN_URL: CFG.stunUrl,
      SYNTHI_TURN_URL: CFG.turnUrl,
      SYNTHI_TURN_USERNAME: CFG.turnUser,
      SYNTHI_TURN_CREDENTIAL: CFG.turnCred,
    };
    mcp = spawn('node', [CFG.mcpEntry], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  }
  const client = new McpClient(mcp);
  const stderrStream = (await import('node:fs')).createWriteStream(path.join(LOG_DIR, 'mcp.stderr.log'));
  mcp.stderr.pipe(stderrStream);

  // Results tracking for summary table
  const results = [];
  function record(phase, name, status, detail = '') {
    results.push({ phase, name, status, detail });
  }

  let dist = 0;
  let locate = null;

  try {
    await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'synthi-live-test', version: '0.0.1' },
    });
    await client.request('notifications/initialized', {}).catch(() => {});

    // tools/list sanity
    const tools = await client.request('tools/list', {});
    const toolNames = tools.tools?.map((t) => t.name) ?? [];
    log('ok', `MCP advertises ${toolNames.length} tools: ${toolNames.join(', ')}`);
    record('handshake', 'tools/list', toolNames.length >= 28 ? 'pass' : 'warn', `count=${toolNames.length}`);

    // ━━━ Phase A: Attach ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    log('info', '── Phase A: Attach ──');
    const attach = await client.toolCall('synthi_attach', { 'i-understand-no-auth': true });
    if (!attach?.ok) fail(`synthi_attach failed: ${JSON.stringify(attach)}`);
    const resStr = attach.resolution ? `${attach.resolution.w}x${attach.resolution.h}` : 'none-yet (no frames)';
    log('ok', `attached  resolution=${resStr}`);
    record('A', 'synthi_attach', 'pass', `resolution=${resStr}`);

    if (attach.resolution) {
      const resOk = attach.resolution.w === FIXTURE.width && attach.resolution.h === FIXTURE.height;
      log(resOk ? 'ok' : 'warn',
          `attach resolution vs fixture: got ${resStr}, expected ${FIXTURE.width}x${FIXTURE.height}`);
      record('A', 'attach resolution matches fixture', resOk ? 'pass' : 'warn',
             `got=${resStr} want=${FIXTURE.width}x${FIXTURE.height}`);
    }

    // ━━━ Phase B: Health + Checkpoint ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    log('info', '── Phase B: Health + Checkpoint ──');

    const health = await client.toolCall('synthi_health', {});
    log(health?.ok ? 'ok' : 'warn',
        `health: wire=${health?.wire_state}  pc=${health?.peer?.connection_state ?? 'n/a'}  first_frame=${health?.frames?.first_frame_seen}  unsafe=${health?.unsafe_mode}`);
    record('B', 'synthi_health', health?.ok ? 'pass' : 'warn',
           `wire=${health?.wire_state} pc=${health?.peer?.connection_state}`);

    const ckStart = await client.toolCall('synthi_checkpoint', { label: 'live-test-start', detail: { ts: Date.now() } });
    log('ok', `checkpoint live-test-start  seq=${ckStart?.seq}`);
    record('B', 'synthi_checkpoint(start)', ckStart?.ok ? 'pass' : 'warn', `seq=${ckStart?.seq}`);

    // ━━━ Phase C: Baseline Observation ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    log('info', '── Phase C: Screenshot + Describe ──');

    // C1. baseline screenshot
    log('info', 'synthi_screenshot (baseline)');
    const shot1 = await client.toolCall('synthi_screenshot', {});
    if (!shot1?.data) fail('synthi_screenshot returned no data');
    const shot1Path = path.join(ARTIFACT_DIR, 'baseline.png');
    await writeFile(shot1Path, Buffer.from(shot1.data, 'base64'));
    const hash1 = await avgHash(shot1.data);
    log('ok', `baseline PNG ${(Buffer.from(shot1.data, 'base64').length / 1024).toFixed(1)}KB → ${shot1Path}`);
    log('ok', `baseline avgHash=0x${hash1.toString(16)}`);
    record('C', 'synthi_screenshot(baseline)', 'pass',
           `${(Buffer.from(shot1.data, 'base64').length / 1024).toFixed(1)}KB`);

    // Content validation: the fixture renders a specific scene — check the
    // pixels we received actually match it (dims, bg, blue button).
    try {
      const img1 = await decodeRgb(shot1.data);
      const dimsOk = img1.width === FIXTURE.width && img1.height === FIXTURE.height;
      log(dimsOk ? 'ok' : 'warn',
          `baseline dims: ${img1.width}x${img1.height} (expected ${FIXTURE.width}x${FIXTURE.height})`);
      record('C', 'baseline dimensions match fixture', dimsOk ? 'pass' : 'warn',
             `${img1.width}x${img1.height}`);

      const bg = avgBox(img1, FIXTURE.bgSample.x, FIXTURE.bgSample.y);
      const bgOk = colorNear(bg, FIXTURE.bgColor, 30);
      log(bgOk ? 'ok' : 'warn',
          `baseline bg @ (${FIXTURE.bgSample.x},${FIXTURE.bgSample.y})=rgb(${bg.r},${bg.g},${bg.b}) want ~rgb(${FIXTURE.bgColor.join(',')})`);
      record('C', 'baseline background is dark grey', bgOk ? 'pass' : 'warn',
             `rgb(${bg.r},${bg.g},${bg.b})`);

      const blue = avgBox(img1, FIXTURE.blueButton.center.x, FIXTURE.blueButton.center.y);
      const blueOk = colorNear(blue, FIXTURE.blueButton.color, 40);
      log(blueOk ? 'ok' : 'warn',
          `baseline blue button @ (${FIXTURE.blueButton.center.x},${FIXTURE.blueButton.center.y})=rgb(${blue.r},${blue.g},${blue.b}) want ~rgb(${FIXTURE.blueButton.color.join(',')})`);
      record('C', 'baseline blue button pixel', blueOk ? 'pass' : 'warn',
             `rgb(${blue.r},${blue.g},${blue.b})`);
    } catch (e) {
      log('warn', `baseline pixel validation failed: ${e.message.slice(0, 100)}`);
      record('C', 'baseline pixel validation', 'warn', e.message.slice(0, 2000));
    }

    // C2. describe agent_side (no external API — returns frame + entity stub)
    log('info', 'synthi_describe (agent_side)');
    try {
      const descAgent = await client.toolCall('synthi_describe', { mode: 'agent_side' });
      const b64 = descAgent?.data ?? descAgent?.screenshot;
      if (b64) await writeFile(path.join(ARTIFACT_DIR, 'describe-agent.png'), Buffer.from(b64, 'base64'));
      log(descAgent?.ok ? 'ok' : 'warn',
          `describe[agent_side]: ${descAgent?.width}x${descAgent?.height}  entities=${Array.isArray(descAgent?.entities) ? descAgent.entities.length : 'n/a'}`);
      record('C', 'synthi_describe(agent_side)', descAgent?.ok ? 'pass' : 'warn',
             `${descAgent?.width}x${descAgent?.height}`);
    } catch (e) {
      log('warn', `describe agent_side failed: ${e.message.slice(0, 120)}`);
      record('C', 'synthi_describe(agent_side)', 'warn', e.message.slice(0, 2000));
    }

    // C3. describe server_side (calls Gemini)
    log('info', 'synthi_describe (server_side / gemini_api)');
    try {
      const descServer = await client.toolCall('synthi_describe', { mode: 'server_side' });
      log(descServer?.ok ? 'ok' : 'warn',
          `describe[server_side]: backend=${descServer?.backend}  summary="${(descServer?.summary ?? '').slice(0, 80)}"`);
      record('C', 'synthi_describe(server_side)', descServer?.ok ? 'pass' : 'warn',
             `backend=${descServer?.backend}`);

      // VLM must at minimum identify the blue button as the salient element.
      const summaryLc = (descServer?.summary ?? '').toLowerCase();
      const mentionsButton = /button|rectangle|rect|shape/.test(summaryLc);
      const mentionsBlue = /\bblue\b/.test(summaryLc);
      const contentOk = mentionsButton && mentionsBlue;
      log(contentOk ? 'ok' : 'warn',
          `describe content check: button=${mentionsButton} blue=${mentionsBlue} (summary "${summaryLc.slice(0, 100)}")`);
      record('C', 'describe mentions blue button', contentOk ? 'pass' : 'warn',
             `button=${mentionsButton} blue=${mentionsBlue}`);
    } catch (e) {
      log('warn', `describe server_side failed: ${e.message.slice(0, 120)}`);
      record('C', 'synthi_describe(server_side)', 'warn', e.message.slice(0, 2000));
    }

    // ━━━ Phase D: Source State + Usage + Event Log (baseline) ━━━━━━━━━━━━━━━
    log('info', '── Phase D: Source State + Usage + Event Log (baseline) ──');

    const srcState0 = await client.toolCall('synthi_get_source_state', {});
    log('ok', `source_state[pre]: hash=${srcState0?.content_hash?.slice(0, 16) ?? 'null'}  events=${srcState0?.source_state_event_count}`);
    record('D', 'synthi_get_source_state(baseline)', srcState0?.ok ? 'pass' : 'warn',
           `hash=${srcState0?.content_hash?.slice(0, 12) ?? 'null'}`);

    const usage0 = await client.toolCall('synthi_get_usage', {});
    log('ok', `usage[baseline]: screenshot=${usage0?.counters?.screenshot}  tool_call=${usage0?.counters?.tool_call}  hot_s=${usage0?.hot_seconds?.toFixed(1)}`);
    record('D', 'synthi_get_usage(baseline)', usage0?.ok ? 'pass' : 'warn',
           `ss=${usage0?.counters?.screenshot} tc=${usage0?.counters?.tool_call}`);

    const evtLifecycle = await client.toolCall('synthi_get_event_log', { kind: 'lifecycle', limit: 20 });
    log('ok', `event_log[lifecycle]: count=${evtLifecycle?.count}  last_seq=${evtLifecycle?.last_seq}`);
    record('D', 'synthi_get_event_log(lifecycle)', (evtLifecycle?.count ?? 0) > 0 ? 'pass' : 'warn',
           `count=${evtLifecycle?.count}`);

    // ━━━ Phase E: Locate ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    log('info', '── Phase E: Locate ──');
    // Fixture: 800x600 dark-grey background + one blue button at {150,120,500,160}
    log('info', 'synthi_locate "the blue button" (Gemini call)');
    try {
      locate = await client.toolCall('synthi_locate', { description: 'the blue button on the dark grey background' });
      if (locate?.bbox) {
        log('ok', `bbox=${JSON.stringify(locate.bbox)}  conf=${locate.confidence ?? 'n/a'}  cached=${locate.cached ?? false}  cost=$${locate.costUsd ?? 0}`);
        record('E', 'synthi_locate', 'pass', `bbox=${JSON.stringify(locate.bbox)}`);

        // Ground-truth check: blue button is at {150,120,500,160}, center (400,200).
        const iou = bboxIoU(locate.bbox, FIXTURE.blueButton.bbox);
        const gotCx = locate.bbox.x + locate.bbox.w / 2;
        const gotCy = locate.bbox.y + locate.bbox.h / 2;
        const centerOff = Math.hypot(gotCx - FIXTURE.blueButton.center.x, gotCy - FIXTURE.blueButton.center.y);
        const accurate = iou >= 0.4 && centerOff <= 80;
        log(accurate ? 'ok' : 'warn',
            `locate accuracy: IoU=${iou.toFixed(2)} center_off=${centerOff.toFixed(0)}px vs fixture ${JSON.stringify(FIXTURE.blueButton.bbox)}`);
        record('E', 'locate bbox matches blue button', accurate ? 'pass' : 'warn',
               `IoU=${iou.toFixed(2)} off=${centerOff.toFixed(0)}px`);
      } else {
        log('warn', `synthi_locate returned no bbox: ${JSON.stringify(locate).slice(0, 100)}`);
        record('E', 'synthi_locate', 'warn', 'no bbox returned');
      }
    } catch (e) {
      log('warn', `synthi_locate failed: ${e.message}`);
      record('E', 'synthi_locate', 'warn', e.message.slice(0, 2000));
      locate = null;
    }

    // ━━━ Phase F: Quality ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    log('info', '── Phase F: Set Quality ──');
    const qualRes = await client.toolCall('synthi_set_quality', { target_fps: 30 });
    log('ok', `set_quality: applied=${qualRes?.applied}  note="${qualRes?.note}"`);
    record('F', 'synthi_set_quality', qualRes?.ok ? 'pass' : 'warn', `applied=${qualRes?.applied}`);

    // ━━━ Phase G: Input Arbitration ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    log('info', '── Phase G: Input Arbitration ──');

    const lease = await client.toolCall('synthi_acquire_input', { lease_ms: 30000, owner: 'synthi-live-test' });
    if (!lease?.ok) fail(`synthi_acquire_input failed: ${JSON.stringify(lease)}`);
    log('ok', `lease: id=${lease?.lease_id?.slice(0, 8)}…  owner=${lease?.owner}  enforcement=${lease?.enforcement}`);
    record('G', 'synthi_acquire_input', 'pass', `id=${lease?.lease_id?.slice(0, 8)}`);

    // ━━━ Phase H: Input Tools ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    log('info', '── Phase H: Mouse + Keyboard + Click + Type ──');

    // Click target: use located bbox center or fall back to blue button center
    // Blue button is SDL_Rect{150,120,500,160} → center ≈ (400, 200)
    const clickTarget = locate?.bbox
      ? { x: Math.round(locate.bbox.x + locate.bbox.w / 2), y: Math.round(locate.bbox.y + locate.bbox.h / 2) }
      : { x: 400, y: 200 };

    // H1. synthi_mouse move
    log('info', `synthi_mouse move → (${clickTarget.x}, ${clickTarget.y})`);
    const mouseMove = await client.toolCall('synthi_mouse', {
      action: 'move', x: clickTarget.x, y: clickTarget.y, lease_id: lease?.lease_id,
    });
    log(mouseMove?.ok ? 'ok' : 'warn', `mouse move: ok=${mouseMove?.ok}`);
    record('H', 'synthi_mouse(move)', mouseMove?.ok ? 'pass' : 'warn');

    // H2. synthi_mouse click
    log('info', `synthi_mouse click → (${clickTarget.x}, ${clickTarget.y})`);
    const mouseClick = await client.toolCall('synthi_mouse', {
      action: 'click', x: clickTarget.x, y: clickTarget.y, button: 'left', lease_id: lease?.lease_id,
    });
    log(mouseClick?.ok ? 'ok' : 'warn', `mouse click dispatched_at=${mouseClick?.dispatched_at}`);
    record('H', 'synthi_mouse(click)', mouseClick?.ok ? 'pass' : 'warn');

    // H3. synthi_click (legacy pixel click)
    log('info', `synthi_click (legacy) → (${clickTarget.x}, ${clickTarget.y})`);
    const legacyClick = await client.toolCall('synthi_click', { x: clickTarget.x, y: clickTarget.y });
    log(legacyClick?.ok ? 'ok' : 'warn', `click legacy ok=${legacyClick?.ok}`);
    record('H', 'synthi_click(legacy)', legacyClick?.ok ? 'pass' : 'warn');

    // H4. synthi_keyboard type
    log('info', 'synthi_keyboard type "."');
    const kbType = await client.toolCall('synthi_keyboard', { action: 'type', text: '.', lease_id: lease?.lease_id });
    log(kbType?.ok ? 'ok' : 'warn', `keyboard type: charsSent=${kbType?.charsSent}`);
    record('H', 'synthi_keyboard(type)', kbType?.ok ? 'pass' : 'warn', `charsSent=${kbType?.charsSent}`);

    // H5. synthi_keyboard key
    log('info', 'synthi_keyboard key "Escape"');
    const kbKey = await client.toolCall('synthi_keyboard', { action: 'key', key: 'Escape', lease_id: lease?.lease_id });
    log(kbKey?.ok ? 'ok' : 'warn', `keyboard key: ok=${kbKey?.ok}`);
    record('H', 'synthi_keyboard(key)', kbKey?.ok ? 'pass' : 'warn');

    // H6. synthi_keyboard chord (ctrl+z — no-op in SDL app, exercises wire)
    log('info', 'synthi_keyboard chord ctrl+z');
    const kbChord = await client.toolCall('synthi_keyboard', {
      action: 'chord', keys: ['ctrl', 'z'], lease_id: lease?.lease_id,
    });
    log(kbChord?.ok ? 'ok' : 'warn', `keyboard chord: ok=${kbChord?.ok}`);
    record('H', 'synthi_keyboard(chord)', kbChord?.ok ? 'pass' : 'warn');

    // H7. synthi_type (legacy)
    log('info', 'synthi_type (legacy) "."');
    const typeRes = await client.toolCall('synthi_type', { text: '.' });
    log(typeRes?.ok ? 'ok' : 'warn', `type legacy: charsSent=${typeRes?.charsSent}`);
    record('H', 'synthi_type(legacy)', typeRes?.ok ? 'pass' : 'warn', `charsSent=${typeRes?.charsSent}`);

    // Release input lease
    log('info', 'synthi_release_input');
    const releaseRes = await client.toolCall('synthi_release_input', { lease_id: lease?.lease_id });
    log('ok', `release_input: released=${JSON.stringify(releaseRes?.released)}`);
    record('G', 'synthi_release_input', releaseRes?.ok ? 'pass' : 'warn',
           `released=${JSON.stringify(releaseRes?.released)}`);

    // ━━━ Phase I: Verify ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    log('info', '── Phase I: Verify ──');

    // I1. element_visible
    log('info', 'synthi_verify element_visible "a button"');
    try {
      const verifyEl = await client.toolCall('synthi_verify', {
        predicate: { kind: 'element_visible', description: 'a button or clickable element' },
      });
      log('ok', `verify element_visible: matched=${verifyEl?.matched}  elapsedMs=${verifyEl?.elapsedMs}`);
      // Fixture contains a visible blue button — expect matched === true.
      record('I', 'synthi_verify(element_visible)', verifyEl?.matched === true ? 'pass' : 'warn', `matched=${verifyEl?.matched}`);
    } catch (e) {
      log('warn', `verify element_visible failed: ${e.message.slice(0, 100)}`);
      record('I', 'synthi_verify(element_visible)', 'warn', e.message.slice(0, 2000));
    }

    // I2. scene_matches (calls VLM)
    log('info', 'synthi_verify scene_matches "a graphical window"');
    try {
      const verifyScene = await client.toolCall('synthi_verify', {
        predicate: { kind: 'scene_matches', description: 'a graphical window or UI' },
      });
      log('ok', `verify scene_matches: matched=${verifyScene?.matched}  elapsedMs=${verifyScene?.elapsedMs}`);
      record('I', 'synthi_verify(scene_matches)', verifyScene?.matched === true ? 'pass' : 'warn', `matched=${verifyScene?.matched}`);
    } catch (e) {
      log('warn', `verify scene_matches failed: ${e.message.slice(0, 100)}`);
      record('I', 'synthi_verify(scene_matches)', 'warn', e.message.slice(0, 2000));
    }

    // I3. event_log for input events
    log('info', 'synthi_get_event_log (input events)');
    const evtInput = await client.toolCall('synthi_get_event_log', { kind: 'input', limit: 30 });
    log('ok', `event_log[input]: count=${evtInput?.count}  last_seq=${evtInput?.last_seq}`);
    record('I', 'synthi_get_event_log(input)', evtInput?.ok ? 'pass' : 'warn', `count=${evtInput?.count}`);

    // ━━━ Phase J: Edit + Compile + HMR ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    log('info', '── Phase J: Edit + Compile + HMR ──');

    // Checkpoint before edit
    const ckPreEdit = await client.toolCall('synthi_checkpoint', { label: 'pre-edit' });
    log('ok', `checkpoint pre-edit  seq=${ckPreEdit?.seq}`);
    record('J', 'synthi_checkpoint(pre-edit)', ckPreEdit?.ok ? 'pass' : 'warn', `seq=${ckPreEdit?.seq}`);

    // Edit main.cpp: insert red button at SECOND_BUTTON_ANCHOR
    log('info', 'Editing main.cpp: insert red button at SECOND_BUTTON_ANCHOR');
    const anchor = /^[ \t]*\/\/ SECOND_BUTTON_ANCHOR[ \t]*\r?\n/m;
    if (!anchor.test(fixture)) {
      fail('fixture did not contain a `// SECOND_BUTTON_ANCHOR` line to replace');
    }
    const insertion =
      '        SDL_Rect red_button = { 150, 320, 500, 160 };\n' +
      '        SDL_SetRenderDrawColor(ren, 220, 40, 40, 255);\n' +
      '        SDL_RenderFillRect(ren, &red_button);\n';
    const edited = fixture.replace(anchor, insertion);

    // Persist edit to collab-server (editor's store)
    {
      const r = await writeFilesBatchCollab({
        collabUrl: CFG.collabUrl, slug: CFG.slug, userId: CFG.hostId,
        files: [{ path: 'main.cpp', content: edited }], syncToGcs: CFG.syncToGcs,
      });
      if (r.otherErrs.length) fail(`edit batch hard errors: ${JSON.stringify(r.otherErrs)}`);
      if (CFG.syncToGcs && r.gcsErrs.length) log('warn', `edit GCS mirror failed: ${JSON.stringify(r.gcsErrs)}`);
      else log('ok', `edit written to collab-server disk${CFG.syncToGcs ? ' + GCS' : ''}`);
    }

    // synthi_compile → triggers diff_patch + HMR
    log('info', 'synthi_compile (CompileRequest → worker diff_patch → HMR)');
    const compileRes = await client.toolCall('synthi_compile', {
      language: 'cpp', filename: 'main.cpp', source: edited, is_gui: true, slug: CFG.slug,
    });
    if (!compileRes?.ok) fail(`synthi_compile failed: ${JSON.stringify(compileRes)}`);
    log('ok', `compile dispatched_at=${compileRes.dispatched_at}`);
    record('J', 'synthi_compile', 'pass', `dispatched_at=${compileRes.dispatched_at}`);

    // synthi_wait_hmr
    log('info', `synthi_wait_hmr (timeout ${CFG.hmrTimeoutMs}ms)`);
    const waitStart = Date.now();
    const hmr = await client.toolCall('synthi_wait_hmr', { timeoutMs: CFG.hmrTimeoutMs });
    const waitElapsed = Date.now() - waitStart;
    log(hmr?.status === 'applied' ? 'ok' : 'warn',
        `hmr status=${hmr?.status}  source=${hmr?.source ?? 'n/a'}  elapsedMs=${hmr?.elapsedMs ?? waitElapsed}`);
    record('J', 'synthi_wait_hmr', hmr?.status === 'applied' ? 'pass' : 'warn', `status=${hmr?.status}`);

    // Post-HMR settle: let fresh frames propagate through encode → RTP → decode
    const postHmrSettleMs = Number(process.env.POST_HMR_SETTLE_MS ?? 1000);
    log('info', `post-HMR settle ${postHmrSettleMs}ms`);
    await sleep(postHmrSettleMs);

    // ━━━ Phase K: Post-Edit Observation ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    log('info', '── Phase K: Post-Edit Observation ──');

    // K1. wait motion_settled
    log('info', 'synthi_wait (motion_settled, timeoutMs=8000)');
    try {
      const motionRes = await client.toolCall('synthi_wait', { condition: 'motion_settled', timeoutMs: 8000 });
      log(motionRes?.ok ? 'ok' : 'warn',
          `wait motion_settled: status=${motionRes?.status}  elapsedMs=${motionRes?.elapsedMs}`);
      record('K', 'synthi_wait(motion_settled)', motionRes?.ok ? 'pass' : 'warn', `status=${motionRes?.status}`);
    } catch (e) {
      log('warn', `wait motion_settled: ${e.message.slice(0, 80)}`);
      record('K', 'synthi_wait(motion_settled)', 'warn', e.message.slice(0, 2000));
    }

    // K2. post-edit screenshot + pHash
    log('info', 'synthi_screenshot (post-edit)');
    const shot2 = await client.toolCall('synthi_screenshot', mcpScreenshotArgsForFrameGate(hmr, {
      frameGateTimeoutMs: CFG.frameGateTimeoutMs,
    }));
    if (!shot2?.data) fail('post-edit synthi_screenshot returned no data');
    const shot2Path = path.join(ARTIFACT_DIR, 'post-edit.png');
    await writeFile(shot2Path, Buffer.from(shot2.data, 'base64'));
    const hash2 = await avgHash(shot2.data);
    dist = hamming(hash1, hash2);
    log('ok', `post-edit PNG → ${shot2Path}`);
    log(dist > 4 ? 'ok' : 'warn',
        `avgHash=0x${hash2.toString(16)}  hamming_distance=${dist} ${dist > 4 ? '(frame changed — HMR visible ✓)' : '(frame identical — HMR may not have landed ✗)'}`);
    record('K', 'synthi_screenshot(post-edit)', dist > 4 ? 'pass' : 'warn', `hamming=${dist}`);

    // Content validation: post-edit frame must show the red button AND keep
    // the blue button (which acts as a control — if it's gone, something
    // other than our edit broke the renderer).
    try {
      const img2 = await decodeRgb(shot2.data);
      const red = avgBox(img2, FIXTURE.redButton.center.x, FIXTURE.redButton.center.y);
      const redOk = colorNear(red, FIXTURE.redButton.color, 40);
      log(redOk ? 'ok' : 'warn',
          `post-edit red button @ (${FIXTURE.redButton.center.x},${FIXTURE.redButton.center.y})=rgb(${red.r},${red.g},${red.b}) want ~rgb(${FIXTURE.redButton.color.join(',')})`);
      record('K', 'post-edit red button pixel', redOk ? 'pass' : 'warn',
             `rgb(${red.r},${red.g},${red.b})`);

      const blue2 = avgBox(img2, FIXTURE.blueButton.center.x, FIXTURE.blueButton.center.y);
      const bluePersists = colorNear(blue2, FIXTURE.blueButton.color, 40);
      log(bluePersists ? 'ok' : 'warn',
          `post-edit blue button persists: rgb(${blue2.r},${blue2.g},${blue2.b}) want ~rgb(${FIXTURE.blueButton.color.join(',')})`);
      record('K', 'post-edit blue button persists', bluePersists ? 'pass' : 'warn',
             `rgb(${blue2.r},${blue2.g},${blue2.b})`);
    } catch (e) {
      log('warn', `post-edit pixel validation failed: ${e.message.slice(0, 100)}`);
      record('K', 'post-edit pixel validation', 'warn', e.message.slice(0, 2000));
    }

    // ━━━ Phase L: Source State (post-edit) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    log('info', '── Phase L: Source State ──');

    // L1. get_source_state after edit
    const srcState1 = await client.toolCall('synthi_get_source_state', {});
    log('ok', `source_state[post]: hash=${srcState1?.content_hash?.slice(0, 16) ?? 'null'}  events=${srcState1?.source_state_event_count}`);
    record('L', 'synthi_get_source_state(post-edit)', srcState1?.ok ? 'pass' : 'warn',
           `hash=${srcState1?.content_hash?.slice(0, 12) ?? 'null'}`);

    // Ground-truth check: edit changed main.cpp, so hash MUST differ from baseline.
    const hashChanged = !!srcState0?.content_hash && !!srcState1?.content_hash &&
                        srcState0.content_hash !== srcState1.content_hash;
    log(hashChanged ? 'ok' : 'warn',
        `source hash changed pre→post: ${srcState0?.content_hash?.slice(0, 12) ?? 'null'} → ${srcState1?.content_hash?.slice(0, 12) ?? 'null'}`);
    record('L', 'source state hash changed after edit', hashChanged ? 'pass' : 'warn',
           `${srcState0?.content_hash?.slice(0, 8) ?? 'null'}→${srcState1?.content_hash?.slice(0, 8) ?? 'null'}`);

    // L2. report_source_state — declare the agent-side edit
    const reportRes = await client.toolCall('synthi_report_source_state', { files: ['main.cpp'] });
    log('ok', `report_source_state: seq=${reportRes?.seq}  hash=${reportRes?.content_hash?.slice(0, 16) ?? 'null'}`);
    record('L', 'synthi_report_source_state', reportRes?.ok ? 'pass' : 'warn', `seq=${reportRes?.seq}`);

    // L3. verify source_state event was emitted
    const evtSrc = await client.toolCall('synthi_get_event_log', { kind: 'source_state', limit: 10 });
    log('ok', `event_log[source_state]: count=${evtSrc?.count}`);
    record('L', 'synthi_get_event_log(source_state)', (evtSrc?.count ?? 0) > 0 ? 'pass' : 'warn',
           `count=${evtSrc?.count}`);

    // ━━━ Phase M: Crash / Disruption ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    log('info', '── Phase M: Crash + Disruption ──');

    const crashInfo = await client.toolCall('synthi_get_crash_info', {});
    log('ok', `crash_info: pending_disruption=${JSON.stringify(crashInfo?.pending_disruption ?? null)}`);
    record('M', 'synthi_get_crash_info', crashInfo?.ok ? 'pass' : 'warn',
           `disruption=${JSON.stringify(crashInfo?.pending_disruption ?? null)}`);

    const ackDisrupt = await client.toolCall('synthi_acknowledge_disruption', {});
    log('ok', `acknowledge_disruption: cleared="${ackDisrupt?.cleared}"`);
    record('M', 'synthi_acknowledge_disruption', ackDisrupt?.ok ? 'pass' : 'warn', `cleared=${ackDisrupt?.cleared}`);

    // ━━━ Phase N: Escape Hatch Stubs ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    log('info', '── Phase N: Escape Hatch Stubs ──');

    // N1. recent_human_actions
    log('info', 'synthi_recent_human_actions');
    const humanActs = await client.toolCall('synthi_recent_human_actions', { limit: 20 });
    log('ok', `recent_human_actions: count=${humanActs?.count}  note="${humanActs?.note ?? ''}"`);
    record('N', 'synthi_recent_human_actions', humanActs?.ok ? 'pass' : 'warn', `count=${humanActs?.count}`);

    // N2. request_human (phase-1 stub — always returns escape_hatch_backend_not_implemented)
    log('info', 'synthi_request_human (phase-1 stub, expect escape_hatch error)');
    const reqHuman = await client.toolCall('synthi_request_human', {
      question: 'Is the red button visible?', timeoutMs: 1000,
    }).catch((e) => ({ _caught: e.message }));
    const humanIsStub =
      reqHuman?.error === 'escape_hatch_backend_not_implemented' ||
      reqHuman?._caught?.includes('escape_hatch_backend_not_implemented');
    log(humanIsStub ? 'ok' : 'warn',
        `request_human: ${reqHuman?.error ?? reqHuman?._caught?.slice(0, 80) ?? JSON.stringify(reqHuman).slice(0, 80)}`);
    record('N', 'synthi_request_human(stub)', humanIsStub ? 'pass' : 'warn',
           reqHuman?.error ?? reqHuman?._caught?.slice(0, 60) ?? 'unexpected_ok');

    // N3. annotate_and_ask (phase-1 stub)
    log('info', 'synthi_annotate_and_ask (phase-1 stub, expect escape_hatch error)');
    const annotate = await client.toolCall('synthi_annotate_and_ask', {
      question: 'Click the primary button', timeoutMs: 1000,
    }).catch((e) => ({ _caught: e.message }));
    const annotateIsStub =
      annotate?.error === 'escape_hatch_backend_not_implemented' ||
      annotate?._caught?.includes('escape_hatch_backend_not_implemented');
    log(annotateIsStub ? 'ok' : 'warn',
        `annotate_and_ask: ${annotate?.error ?? annotate?._caught?.slice(0, 80) ?? JSON.stringify(annotate).slice(0, 80)}`);
    record('N', 'synthi_annotate_and_ask(stub)', annotateIsStub ? 'pass' : 'warn',
           annotate?.error ?? annotate?._caught?.slice(0, 60) ?? 'unexpected_ok');

    // ━━━ Phase O: Event Log + Usage (final) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    log('info', '── Phase O: Comprehensive Event Log + Final Usage ──');

    // O1. all events
    const allEvts = await client.toolCall('synthi_get_event_log', { limit: 100 });
    const kindCounts = {};
    for (const e of (allEvts?.entries ?? [])) {
      kindCounts[e.kind] = (kindCounts[e.kind] ?? 0) + 1;
    }
    log('ok', `event_log[all]: total=${allEvts?.count}  kinds=${JSON.stringify(kindCounts)}`);
    record('O', 'synthi_get_event_log(all)', (allEvts?.count ?? 0) > 0 ? 'pass' : 'warn',
           `total=${allEvts?.count} kinds=${JSON.stringify(kindCounts)}`);

    // O2. usage final
    const usageFinal = await client.toolCall('synthi_get_usage', {});
    const ssCount = usageFinal?.counters?.screenshot ?? 0;
    log('ok', `usage[final]: screenshot=${ssCount}  tool_call=${usageFinal?.counters?.tool_call}  vision=${usageFinal?.counters?.vision_inference}  cost=$${usageFinal?.vision_cost_usd_estimate?.toFixed(4)}`);
    log('ok', `queue_depth: inflight=${usageFinal?.input_queue_depth?.inflight}  recent_peak=${usageFinal?.input_queue_depth?.recent_peak_max}`);
    record('O', 'synthi_get_usage(final)', usageFinal?.ok && ssCount >= 2 ? 'pass' : 'warn',
           `tc=${usageFinal?.counters?.tool_call} ss=${ssCount}`);

    // O3. final checkpoint
    const ckComplete = await client.toolCall('synthi_checkpoint', {
      label: 'live-test-complete', detail: { hamming_distance: dist },
    });
    log('ok', `checkpoint live-test-complete  seq=${ckComplete?.seq}`);
    record('O', 'synthi_checkpoint(complete)', ckComplete?.ok ? 'pass' : 'warn', `seq=${ckComplete?.seq}`);

    // ━━━ Phase P: Prometheus Metrics ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    log('info', '── Phase P: Metrics ──');
    log('info', `Scraping http://127.0.0.1:${CFG.prometheusPort}/metrics`);
    try {
      const m = await fetch(`http://127.0.0.1:${CFG.prometheusPort}/metrics`);
      const metricsText = await m.text();
      const interesting = metricsText.split('\n')
        .filter((l) => l.startsWith('synthi_') && !l.startsWith('#')).slice(0, 40);
      console.log(color.dim + interesting.join('\n') + color.reset);
      await writeFile(path.join(LOG_DIR, 'metrics.txt'), metricsText);
      record('P', 'prometheus_scrape', 'pass', `${interesting.length} synthi_ lines`);
    } catch (e) {
      log('warn', `metrics scrape failed: ${e.message}`);
      record('P', 'prometheus_scrape', 'warn', e.message.slice(0, 2000));
    }

    // ━━━ Phase Q: Reset + Reconnect + Detach ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    log('info', '── Phase Q: Reset + Reconnect + Detach ──');

    // Q1. reset_guest (phase-1 records intent; applied=false)
    log('info', 'synthi_reset_guest (phase-1 intent record)');
    const resetRes = await client.toolCall('synthi_reset_guest', {});
    log(resetRes?.ok ? 'ok' : 'warn',
        `reset_guest: applied=${resetRes?.applied}  note="${(resetRes?.note ?? '').slice(0, 80)}"`);
    record('Q', 'synthi_reset_guest', resetRes?.ok ? 'pass' : 'warn', `applied=${resetRes?.applied}`);

    // Brief settle after reset signal
    await sleep(2000);

    // Q2. reconnect (re-establish WebRTC + signaling)
    log('info', 'synthi_reconnect');
    try {
      const reconnectRes = await client.toolCall('synthi_reconnect', {});
      log(reconnectRes?.ok ? 'ok' : 'warn',
          `reconnect: reconnected=${reconnectRes?.reconnected}  session=${reconnectRes?.session_id}  resolution=${JSON.stringify(reconnectRes?.resolution)}`);
      record('Q', 'synthi_reconnect', reconnectRes?.ok ? 'pass' : 'warn', `session=${reconnectRes?.session_id}`);

      // Q3. post-reconnect screenshot (verify video stream still live)
      log('info', 'synthi_screenshot (post-reconnect)');
      try {
        const shot3 = await client.toolCall('synthi_screenshot', {});
        if (shot3?.data) {
          const shot3Path = path.join(ARTIFACT_DIR, 'post-reconnect.png');
          await writeFile(shot3Path, Buffer.from(shot3.data, 'base64'));
          log('ok', `post-reconnect PNG ${(Buffer.from(shot3.data, 'base64').length / 1024).toFixed(1)}KB → ${shot3Path}`);
          record('Q', 'synthi_screenshot(post-reconnect)', 'pass');
        } else {
          log('warn', 'post-reconnect screenshot returned no data');
          record('Q', 'synthi_screenshot(post-reconnect)', 'warn', 'no data');
        }
      } catch (e) {
        log('warn', `post-reconnect screenshot: ${e.message.slice(0, 80)}`);
        record('Q', 'synthi_screenshot(post-reconnect)', 'warn', e.message.slice(0, 2000));
      }
    } catch (e) {
      log('warn', `synthi_reconnect failed: ${e.message.slice(0, 100)}`);
      record('Q', 'synthi_reconnect', 'warn', e.message.slice(0, 2000));
    }

    // Q4. detach (clean WebRTC disconnect — must be last tool call)
    log('info', 'synthi_detach');
    try {
      const detachRes = await client.toolCall('synthi_detach', {});
      log(detachRes?.ok ? 'ok' : 'warn', `detach: detached=${detachRes?.detached}`);
      record('Q', 'synthi_detach', detachRes?.ok ? 'pass' : 'warn', `detached=${detachRes?.detached}`);
    } catch (e) {
      log('warn', `synthi_detach failed: ${e.message.slice(0, 80)}`);
      record('Q', 'synthi_detach', 'warn', e.message.slice(0, 2000));
    }

    // ━━━ Summary ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    console.log('');
    console.log(color.blue + '━━━ Test Summary ━━━' + color.reset);
    const passed = results.filter((r) => r.status === 'pass').length;
    const warned = results.filter((r) => r.status === 'warn').length;
    const failed = results.filter((r) => r.status === 'fail').length;
    console.log(`  Checked ${results.length} points: ${color.green}${passed} PASS${color.reset}  ${color.yellow}${warned} WARN${color.reset}  ${color.red}${failed} FAIL${color.reset}`);
    if (warned + failed > 0) {
      console.log('');
      for (const r of results.filter((r) => r.status !== 'pass')) {
        log(r.status === 'fail' ? 'fail' : 'warn',
            `  [${r.phase}] ${r.name}${r.detail ? '  — ' + r.detail : ''}`);
      }
    }
    // Write structured results to disk for postmortem inspection
    const resultsJson = {
      slug: CFG.slug,
      run_at: new Date().toISOString(),
      summary: { total: results.length, passed, warned, failed },
      results,
    };
    await writeFile(path.join(LOG_DIR, 'results.json'), JSON.stringify(resultsJson, null, 2));
    const resultsTxt = results.map((r) =>
      `${r.status.toUpperCase().padEnd(5)}  [${r.phase}] ${r.name}${r.detail ? '  — ' + r.detail : ''}`
    ).join('\n');
    await writeFile(path.join(LOG_DIR, 'results.txt'), resultsTxt + '\n');

    console.log('');
    log('ok', 'Live test completed.');
    console.log(`  Artifacts:  ${ARTIFACT_DIR}`);
    console.log(`  Logs:       ${LOG_DIR}`);
    console.log(`  Results:    ${path.join(LOG_DIR, 'results.json')}`);
    console.log(`  Workspace:  id=${workspace.id}  slug=${CFG.slug}`);

  } finally {
    // Shutdown MCP cleanly.
    // Docker transport: close stdin (StdioServerTransport exits on stdin EOF).
    // Host transport: SIGTERM.
    log('info', 'Shutting down MCP');
    try { mcp.stdin?.end(); } catch { /* ignored */ }
    if (CFG.mcpTransport !== 'docker') {
      mcp.kill('SIGTERM');
    }
    await Promise.race([
      new Promise((r) => mcp.once('exit', r)),
      sleep(3000).then(() => mcp.kill('SIGKILL')),
    ]);
    stderrStream.end();
  }
}

main().catch((e) => {
  console.error(color.red + '\nFATAL: ' + color.reset + (e.stack ?? e.message));
  process.exit(1);
});
