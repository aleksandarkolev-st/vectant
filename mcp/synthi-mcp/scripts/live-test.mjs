#!/usr/bin/env node
// Synthi MCP live-test harness.
//
// Preconditions the script assumes are ALREADY satisfied:
//   - signaling-server running in WSL on :9000  (ws://localhost:9000)
//   - worker running in WSL (connected to above signaling)
//   - collab-server running in Windows Docker on :1234
//   - redis / y-sweet / ai-engine / gateway / frontend all up
//   - `pnpm build` has produced dist/index.js in this package
//
// Env vars (with defaults):
//   COLLAB_URL             http://localhost:1234   (collab-server REST)
//   SIGNALING_URL          ws://localhost:9000     (MCP → signaling)
//   PROMETHEUS_PORT        9464                    (MCP /metrics)
//   GOOGLE_API_KEY         (required)              (Gemini API key)
//   SYNTHI_GEMINI_MODEL    gemini-3-flash-preview
//   HOST_ID                mcp-live-test           (collab user id)
//   SLUG                   mcp-counter             (per-run unique to avoid state)
//   MCP_ENTRY              ../dist/index.js        (resolved relative to this file)
//   FIXTURE_PATH           ../tests/fixtures/counter/main.cpp
//   FRONTEND_PRECOMPILED   false                   (set true if you opened the session in the browser)
//   HMR_TIMEOUT_MS         60000
//
// Usage:
//   cd mcp/synthi-mcp
//   GOOGLE_API_KEY=... node scripts/live-test.mjs
//
// What it does, in order:
//   1. Preflight: TCP-ping signaling + collab. Bail early with a clear error if either is dead.
//   2. Read counter/main.cpp off disk.
//   3. POST /session/create → captures sessionId.
//   4. POST /git/<slug>/write-file → writes main.cpp into the host's repo.
//   5. Spawn MCP subprocess with Gemini env.
//   6. JSON-RPC over stdio:
//        initialize → tools/list → tools/call synthi_attach
//        → tools/call synthi_screenshot (baseline)
//        → tools/call synthi_locate (Gemini call; baseline locator)
//        → tools/call synthi_click
//      then a small edit (counter=0 → counter=42) via write-file
//        → tools/call synthi_wait_hmr
//        → tools/call synthi_screenshot (post-edit; pHash-compared to baseline)
//   7. Scrape /metrics, print summary.
//   8. Shutdown: send SIGTERM, await exit.
//
// On failure, prints the MCP's stderr tail + the last few JSON-RPC frames.

import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CFG = {
  collabUrl: process.env.COLLAB_URL ?? 'http://localhost:1234',
  signalingUrl: process.env.SIGNALING_URL ?? 'ws://localhost:9000',
  prometheusPort: Number(process.env.PROMETHEUS_PORT ?? 9464),
  googleApiKey: process.env.GOOGLE_API_KEY ?? '',
  geminiModel: process.env.SYNTHI_GEMINI_MODEL ?? 'gemini-3-flash-preview',
  hostId: process.env.HOST_ID ?? 'mcp-live-test',
  slug: process.env.SLUG ?? `mcp-counter-${Date.now()}`,
  mcpEntry: path.resolve(__dirname, process.env.MCP_ENTRY ?? '../dist/index.js'),
  fixturePath: path.resolve(__dirname, process.env.FIXTURE_PATH ?? '../tests/fixtures/counter/main.cpp'),
  frontendPrecompiled: (process.env.FRONTEND_PRECOMPILED ?? 'false').toLowerCase() === 'true',
  hmrTimeoutMs: Number(process.env.HMR_TIMEOUT_MS ?? 60000),
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

function tcpPing(host, port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const s = net.createConnection({ host, port });
    const t = setTimeout(() => { s.destroy(); resolve(false); }, timeoutMs);
    s.once('connect', () => { clearTimeout(t); s.end(); resolve(true); });
    s.once('error', () => { clearTimeout(t); resolve(false); });
  });
}

function parseUrl(u) {
  const x = new URL(u);
  return { host: x.hostname, port: Number(x.port) || (x.protocol === 'wss:' || x.protocol === 'https:' ? 443 : 80) };
}

// Lazy pHash — 8x8 DCT is overkill here; we use average-hash: downscale to 8x8,
// compare to average. Good enough to detect the counter-value edit.
async function avgHash(pngBase64) {
  const { default: sharp } = await import('sharp');
  const buf = Buffer.from(pngBase64, 'base64');
  const raw = await sharp(buf).greyscale().resize(8, 8, { fit: 'fill' })
    .raw().toBuffer();
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
    // MCP stdio uses newline-delimited JSON (one JSON object per line).
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
    // MCP wraps tool output in { content: [{ type:'text', text: JSON-string }], isError? }
    if (res.isError) throw new Error(`tool ${name} isError: ${JSON.stringify(res.content)}`);
    const text = res?.content?.[0]?.text;
    if (!text) return res;
    try { return JSON.parse(text); } catch { return { raw: text }; }
  }
}

// ───────────────────────── main flow ─────────────────────────

async function main() {
  console.log(color.blue + '\n━━━ Synthi MCP live-test ━━━' + color.reset);
  console.log(`  slug         ${CFG.slug}`);
  console.log(`  hostId       ${CFG.hostId}`);
  console.log(`  gemini       ${CFG.geminiModel}`);
  console.log(`  mcp entry    ${CFG.mcpEntry}`);
  console.log('');

  if (!CFG.googleApiKey) fail('GOOGLE_API_KEY not set. Export it and re-run.');
  if (!existsSync(CFG.mcpEntry)) fail(`MCP entry not found: ${CFG.mcpEntry}\n  → run: pnpm build`);
  if (!existsSync(CFG.fixturePath)) fail(`Fixture not found: ${CFG.fixturePath}`);

  await mkdir(LOG_DIR, { recursive: true });
  await mkdir(ARTIFACT_DIR, { recursive: true });

  // 1. Preflight
  log('info', 'Preflight: signaling + collab reachable?');
  const sig = parseUrl(CFG.signalingUrl);
  const col = parseUrl(CFG.collabUrl);
  const [sigOk, colOk] = await Promise.all([tcpPing(sig.host, sig.port), tcpPing(col.host, col.port)]);
  if (!sigOk) fail(`signaling unreachable at ${CFG.signalingUrl}`);
  if (!colOk) fail(`collab-server unreachable at ${CFG.collabUrl}`);
  log('ok', `signaling:${sig.port} + collab:${col.port} both up`);

  // 2. Create session
  log('info', 'POST /session/create');
  const session = await httpJson('POST', `${CFG.collabUrl}/session/create`, {
    hostId: CFG.hostId, hostName: 'MCP Live Test', hostAvatar: '',
    slug: CFG.slug, defaultPerms: {},
  });
  if (!session.sessionId) fail('session create returned no sessionId', session);
  log('ok', `sessionId=${session.sessionId}  worktree=${session.worktreePath || '(none)'}`);

  // 3. Seed fixture via write-file
  log('info', 'Seeding fixture via POST /git/:slug/write-file');
  const fixture = await readFile(CFG.fixturePath, 'utf8');
  await httpJson(
    'POST',
    `${CFG.collabUrl}/git/${CFG.slug}/write-file`,
    { path: 'main.cpp', content: fixture },
    { 'x-session-id': session.sessionId, 'x-user-id': CFG.hostId },
  );
  log('ok', 'main.cpp written to host repo');

  if (!CFG.frontendPrecompiled) {
    console.log('');
    log('warn', 'Initial compile is frontend-driven. Options:');
    console.log('    (a) In the Windows browser, open the session:');
    console.log(`        http://localhost:3000/workspace/${CFG.slug}?sessionId=${session.sessionId}`);
    console.log('        Wait until the counter is visibly rendering, then press ENTER here.');
    console.log('    (b) Skip — synthi_attach will hang until a frame arrives.');
    console.log('');
    process.stdout.write('    Press ENTER when the workspace shows the counter, or Ctrl-C to abort: ');
    await new Promise((r) => process.stdin.once('data', r));
  }

  // 4. Spawn MCP
  log('info', 'Spawning MCP subprocess');
  const env = {
    ...process.env,
    SYNTHI_SESSION_ID: session.sessionId,
    SYNTHI_SIGNALING_URL: CFG.signalingUrl,
    SYNTHI_LOCATE_BACKEND: 'gemini_api',
    GOOGLE_API_KEY: CFG.googleApiKey,
    SYNTHI_GEMINI_MODEL: CFG.geminiModel,
    SYNTHI_PROMETHEUS_PORT: String(CFG.prometheusPort),
    SYNTHI_PROMETHEUS_HOST: '127.0.0.1',
  };
  const mcp = spawn('node', [CFG.mcpEntry], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const client = new McpClient(mcp);

  // stderr log tail gets written to a file for postmortem
  const stderrStream = (await import('node:fs')).createWriteStream(path.join(LOG_DIR, 'mcp.stderr.log'));
  mcp.stderr.pipe(stderrStream);

  try {
    await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'synthi-live-test', version: '0.0.1' },
    });
    await client.request('notifications/initialized', {}).catch(() => {}); // non-strict

    // 5. tools/list sanity
    const tools = await client.request('tools/list', {});
    log('ok', `MCP advertises ${tools.tools?.length ?? 0} tools: ${tools.tools?.map(t => t.name).join(', ')}`);

    // 6. attach
    log('info', 'synthi_attach (expect ~10-15s, waits for first video frame)');
    const attach = await client.toolCall('synthi_attach', {});
    if (!attach?.ok) fail(`synthi_attach failed: ${JSON.stringify(attach)}`);
    log('ok', `attached  resolution=${attach.resolution?.w}x${attach.resolution?.h}`);

    // 7. baseline screenshot
    log('info', 'synthi_screenshot (baseline)');
    const shot1 = await client.toolCall('synthi_screenshot', {});
    if (!shot1?.data) fail('synthi_screenshot returned no data', shot1);
    const shot1Path = path.join(ARTIFACT_DIR, 'baseline.png');
    await writeFile(shot1Path, Buffer.from(shot1.data, 'base64'));
    const hash1 = await avgHash(shot1.data);
    log('ok', `baseline PNG ${(Buffer.from(shot1.data, 'base64').length / 1024).toFixed(1)}KB → ${shot1Path}`);
    log('ok', `baseline avgHash=0x${hash1.toString(16)}`);

    // 8. locate (Gemini)
    log('info', 'synthi_locate "the white square" (Gemini call)');
    let locate;
    try {
      locate = await client.toolCall('synthi_locate', { description: 'the white square in the center' });
    } catch (e) {
      log('warn', `synthi_locate failed or tool missing: ${e.message}`);
      locate = null;
    }
    if (locate?.bbox) {
      log('ok', `bbox=${JSON.stringify(locate.bbox)}  conf=${locate.confidence ?? 'n/a'}  cached=${locate.cached ?? false}  cost=$${locate.costUsd ?? 0}`);
    }

    // 9. edit fixture: counter = 0 → 42
    log('info', 'Editing main.cpp: counter = 0 → 42');
    const edited = fixture.replace('int counter = 0;', 'int counter = 42;');
    if (edited === fixture) fail('fixture did not contain `int counter = 0;` to edit');
    await httpJson(
      'POST',
      `${CFG.collabUrl}/git/${CFG.slug}/write-file`,
      { path: 'main.cpp', content: edited },
      { 'x-session-id': session.sessionId, 'x-user-id': CFG.hostId },
    );
    log('ok', 'edit written');

    // 10. wait_hmr
    log('info', `synthi_wait_hmr (timeout ${CFG.hmrTimeoutMs}ms)`);
    const waitStart = Date.now();
    const hmr = await client.toolCall('synthi_wait_hmr', { timeoutMs: CFG.hmrTimeoutMs });
    const waitElapsed = Date.now() - waitStart;
    log(hmr?.status === 'applied' ? 'ok' : 'warn',
        `hmr status=${hmr?.status}  elapsedMs=${hmr?.elapsedMs ?? waitElapsed}`);

    // 11. post-edit screenshot
    log('info', 'synthi_screenshot (post-edit)');
    const shot2 = await client.toolCall('synthi_screenshot', {});
    const shot2Path = path.join(ARTIFACT_DIR, 'post-edit.png');
    await writeFile(shot2Path, Buffer.from(shot2.data, 'base64'));
    const hash2 = await avgHash(shot2.data);
    const dist = hamming(hash1, hash2);
    log('ok', `post-edit PNG → ${shot2Path}`);
    log(dist > 4 ? 'ok' : 'warn',
        `avgHash=0x${hash2.toString(16)}  hamming_distance=${dist} ${dist > 4 ? '(frame changed — HMR visible ✓)' : '(frame identical — HMR may not have landed ✗)'}`);

    // 12. metrics
    log('info', `Scraping http://127.0.0.1:${CFG.prometheusPort}/metrics`);
    try {
      const m = await fetch(`http://127.0.0.1:${CFG.prometheusPort}/metrics`);
      const metricsText = await m.text();
      const interesting = metricsText.split('\n').filter((l) =>
        l.startsWith('synthi_') && !l.startsWith('#')).slice(0, 40);
      console.log(color.dim + interesting.join('\n') + color.reset);
      await writeFile(path.join(LOG_DIR, 'metrics.txt'), metricsText);
    } catch (e) {
      log('warn', `metrics scrape failed: ${e.message}`);
    }

    console.log('');
    log('ok', 'Live test completed.');
    console.log(`  Artifacts:  ${ARTIFACT_DIR}`);
    console.log(`  Logs:       ${LOG_DIR}`);
    console.log(`  Session:    ${session.sessionId}  (slug: ${CFG.slug})`);
  } finally {
    // Shutdown MCP cleanly
    log('info', 'Shutting down MCP');
    mcp.kill('SIGTERM');
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
