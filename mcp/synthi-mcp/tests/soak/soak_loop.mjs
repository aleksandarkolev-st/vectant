#!/usr/bin/env node
/*
 * Phase-3 soak harness.
 *
 * Long-running loop over screenshot + locate + wait + snapshot to surface
 * leaks / latency drift / degradation that short tests can't see. Emits
 * a summary + per-iteration timing stream on exit.
 */

import { spawn } from 'node:child_process';
import { writeFile, mkdir, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  captureSoakMemorySample,
  extractNumericUsageCounters,
  extractRuntimeResourceCounters,
  summarizeRuntimeResourceSamples,
  summarizeSoakMemorySamples,
  summarizeUsageCounterSamples,
} from './soak_metrics.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CFG = {
  durationMin: Number(process.env.SOAK_DURATION_MIN ?? 10),
  iterationMs: Number(process.env.SOAK_ITERATION_MS ?? 2000),
  snapshotEvery: Number(process.env.SOAK_SNAPSHOT_EVERY ?? 30),
  locateDescription: process.env.SOAK_LOCATE_DESCRIPTION ?? 'the primary button',
  locateBboxHint: process.env.SOAK_LOCATE_BBOX_HINT,
  outputDir: path.resolve(process.cwd(), process.env.SOAK_OUTPUT_DIR ?? '.soak'),
  sessionId: process.env.SYNTHI_SESSION_ID,
  signalingUrl: process.env.SYNTHI_SIGNALING_URL ?? 'ws://localhost:9000',
  visionBackend: process.env.SYNTHI_VISION_BACKEND ?? 'mock',
  mcpEntry: path.resolve(__dirname, process.env.MCP_ENTRY ?? '../../dist/index.js'),
};

if (!CFG.sessionId) {
  console.error('SYNTHI_SESSION_ID is required. Set it to the target session id.');
  process.exit(2);
}

let bboxHint;
if (CFG.locateBboxHint) {
  try { bboxHint = JSON.parse(CFG.locateBboxHint); }
  catch (e) {
    console.error(`SOAK_LOCATE_BBOX_HINT is not valid JSON: ${e.message}`);
    process.exit(2);
  }
}

await mkdir(CFG.outputDir, { recursive: true });
const eventsPath = path.join(CFG.outputDir, 'soak-events.ndjson');
const summaryPath = path.join(CFG.outputDir, 'soak-summary.json');

function nowIso() { return new Date().toISOString(); }
function ts() { return Date.now(); }

class McpClient {
  constructor(proc) {
    this.proc = proc;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    proc.stdout.on('data', (c) => this.onData(c.toString()));
    proc.on('exit', (code, sig) => {
      for (const [, p] of this.pending) p.reject(new Error(`MCP exited ${code ?? sig}`));
      this.pending.clear();
    });
  }
  onData(text) {
    this.buffer += text;
    let i;
    while ((i = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, i).trim();
      this.buffer = this.buffer.slice(i + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.id != null && this.pending.has(m.id)) {
        const p = this.pending.get(m.id); this.pending.delete(m.id);
        if (m.error) p.reject(new Error(JSON.stringify(m.error)));
        else p.resolve(m.result);
      }
    }
  }
  request(method, params = {}, timeoutMs = 30000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`request ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(t); resolve(v); },
        reject: (e) => { clearTimeout(t); reject(e); },
      });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  async toolCall(name, args) {
    const res = await this.request('tools/call', { name, arguments: args });
    const text = res?.content?.find((b) => b?.type === 'text')?.text;
    let parsed;
    try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
    return { parsed, isError: res.isError === true };
  }
}

const env = {
  ...process.env,
  SYNTHI_SESSION_ID: CFG.sessionId,
  SYNTHI_SIGNALING_URL: CFG.signalingUrl,
  SYNTHI_VISION_BACKEND: CFG.visionBackend,
};
const mcp = spawn('node', [CFG.mcpEntry], { env, stdio: ['pipe', 'pipe', 'inherit'] });
const client = new McpClient(mcp);

const stats = {
  startedAt: ts(),
  stoppedAt: null,
  iterations: 0,
  errors: 0,
  snapshotsCaptured: 0,
  tools: {
    screenshot: { count: 0, errors: 0, latencyMs: [] },
    locate: { count: 0, errors: 0, latencyMs: [] },
    wait: { count: 0, errors: 0, latencyMs: [] },
    snapshot: { count: 0, errors: 0, latencyMs: [] },
    usage: { count: 0, errors: 0, latencyMs: [] },
  },
  warnings: [],
  memorySamples: [],
  usageSamples: [],
  runtimeResourceSamples: [],
  summary: null,
};

function recordLatency(bucket, ms) { bucket.latencyMs.push(ms); }
function pct(arr, p) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
}
function summarizeBucket(name, bucket) {
  return {
    name,
    count: bucket.count,
    errors: bucket.errors,
    p50: pct(bucket.latencyMs, 0.5),
    p95: pct(bucket.latencyMs, 0.95),
    p99: pct(bucket.latencyMs, 0.99),
    max: bucket.latencyMs.length ? Math.max(...bucket.latencyMs) : null,
  };
}

let stopping = false;
function stop(reason) {
  if (stopping) return;
  stopping = true;
  stats.stoppedAt = ts();
  stats.stop_reason = reason;
}
process.on('SIGINT', () => stop('sigint'));
process.on('SIGTERM', () => stop('sigterm'));

async function run() {
  console.log(`[${nowIso()}] soak starting duration=${CFG.durationMin}min iteration=${CFG.iterationMs}ms`);
  console.log(`  session=${CFG.sessionId} signaling=${CFG.signalingUrl} vision=${CFG.visionBackend}`);
  console.log(`  output=${CFG.outputDir}`);

  await client.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'soak-harness', version: '0.1.0' },
  });
  await client.request('notifications/initialized', {}).catch(() => {});

  await captureUsageSnapshot('pre_attach');

  const attach = await client.toolCall('synthi_attach', { 'i-understand-no-auth': true });
  if (attach.isError) {
    console.error('attach failed:', attach.parsed);
    process.exit(3);
  }
  await captureUsageSnapshot('post_attach');

  const deadline = ts() + CFG.durationMin * 60_000;
  while (!stopping && ts() < deadline) {
    const iter = stats.iterations++;
    const iterEvents = { iter, at: ts(), steps: [] };
    try {
      const ss = await timed('screenshot', () => client.toolCall('synthi_screenshot', {}));
      iterEvents.steps.push({ tool: 'screenshot', ...ss.meta });

      const locateArgs = {
        description: CFG.locateDescription,
        ...(bboxHint ? { hints: { prefer_region: bboxHint } } : {}),
      };
      const loc = await timed('locate', () => client.toolCall('synthi_locate', locateArgs));
      iterEvents.steps.push({ tool: 'locate', ...loc.meta });

      const w = await timed('wait', () =>
        client.toolCall('synthi_wait', {
          condition: 'motion_settled',
          timeoutMs: 500,
          region: bboxHint ?? { x: 0, y: 0, w: 100, h: 100 },
          still_for_ms: 200,
        })
      );
      iterEvents.steps.push({ tool: 'wait', ...w.meta });

      if (iter % CFG.snapshotEvery === 0) {
        const snap = await timed('snapshot', () =>
          client.toolCall('synthi_snapshot', { label: `soak-iter-${iter}`, omit_frame: true })
        );
        iterEvents.steps.push({ tool: 'snapshot', ...snap.meta });
        if (!snap.meta.err) stats.snapshotsCaptured++;
      }

      if (iter % 30 === 0) {
        const u = await captureUsageSnapshot('iteration', iter);
        iterEvents.steps.push({
          tool: 'usage',
          ...u.meta,
          counters: u.parsed?.counters,
          runtime_session_diagnostics: u.parsed?.runtime_session_diagnostics,
        });
      }
    } catch (err) {
      stats.errors++;
      iterEvents.error = err.message;
      stats.warnings.push({ iter, error: err.message, at: ts() });
    }
    const memorySample = captureMemorySample();
    iterEvents.memory_sample = memorySample;
    await appendFile(eventsPath, JSON.stringify(iterEvents) + '\n').catch(() => {});
    if (iter % 10 === 0) {
      const elapsed = ((ts() - stats.startedAt) / 1000).toFixed(1);
      process.stderr.write(`[soak] iter=${iter} elapsed=${elapsed}s errors=${stats.errors}\n`);
    }
    const slack = CFG.iterationMs - (ts() - iterEvents.at);
    if (slack > 0 && !stopping) await sleep(slack);
  }

  stop('duration_reached');

  try { await client.toolCall('synthi_detach', {}); } catch { /* best effort */ }
  await captureUsageSnapshot('post_detach').catch((err) => {
    stats.warnings.push({ phase: 'post_detach_usage', error: err.message, at: ts() });
  });
  captureMemorySample();
  try { mcp.stdin.end(); } catch { /* ignored */ }

  async function timed(key, fn) {
    const bucket = stats.tools[key];
    const t0 = ts();
    try {
      const res = await fn();
      const latency = ts() - t0;
      bucket.count++;
      recordLatency(bucket, latency);
      if (res.isError) bucket.errors++;
      return { ...res, meta: { latency_ms: latency, ok: !res.isError } };
    } catch (err) {
      const latency = ts() - t0;
      bucket.count++;
      bucket.errors++;
      recordLatency(bucket, latency);
      return { parsed: {}, isError: true, meta: { latency_ms: latency, ok: false, err: err.message } };
    }
  }

  async function captureUsageSnapshot(phase, iter) {
    const usage = await timed('usage', () => client.toolCall('synthi_get_usage', {}));
    const at = ts();
    const numericCounters = extractNumericUsageCounters(usage.parsed);
    const runtimeResources = extractRuntimeResourceCounters(usage.parsed);
    const sample = {
      at,
      phase,
      ...(iter !== undefined ? { iter } : {}),
      counters: numericCounters,
    };
    const resourceSample = {
      at,
      phase,
      ...(iter !== undefined ? { iter } : {}),
      ...runtimeResources,
    };
    stats.usageSamples.push(sample);
    stats.runtimeResourceSamples.push(resourceSample);
    return {
      ...usage,
      parsed: {
        ...usage.parsed,
        numeric_counters: numericCounters,
        runtime_resource_counters: runtimeResources,
      },
    };
  }

  function captureMemorySample() {
    const sample = captureSoakMemorySample({ at: ts() });
    stats.memorySamples.push(sample);
    return sample;
  }
}

try {
  await run();
} catch (e) {
  console.error('soak aborted:', e);
  stats.warnings.push({ fatal: e.message });
  stop('fatal');
}

stats.summary = {
  duration_s: ((stats.stoppedAt ?? ts()) - stats.startedAt) / 1000,
  iterations: stats.iterations,
  errors: stats.errors,
  snapshots_captured: stats.snapshotsCaptured,
  per_tool: Object.fromEntries(
    Object.entries(stats.tools).map(([k, b]) => [k, summarizeBucket(k, b)])
  ),
  memory: summarizeSoakMemorySamples(stats.memorySamples),
  usage_counters: summarizeUsageCounterSamples(stats.usageSamples),
  runtime_resources: summarizeRuntimeResourceSamples(stats.runtimeResourceSamples),
};
await writeFile(summaryPath, JSON.stringify(stats.summary, null, 2));

console.log(`[${nowIso()}] soak complete`);
console.log(`  duration ${stats.summary.duration_s.toFixed(1)}s  iterations=${stats.summary.iterations}  errors=${stats.summary.errors}`);
console.log(`  summary → ${summaryPath}`);
console.log(`  events  → ${eventsPath}`);

process.exit(stats.errors > 0 ? 1 : 0);
