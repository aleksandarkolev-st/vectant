/**
 * WI-PROD: production readiness beyond localhost, proven LIVE.
 *
 * 1. A bridge bound beyond loopback refuses tool requests without a token
 *    and serves them with one (real HTTP against a real 0.0.0.0 bind).
 * 2. The standalone agent's deployment config layer enforces the same rule:
 *    non-loopback without SYNTHI_BRIDGE_TOKEN exits before binding.
 * 3. Remote-realm portability: agent B - spawned in a FOREIGN working
 *    directory - imports a skill taught in directory A and executes it
 *    against ITS own world; the effect lands on B's disk.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const mcpRoot = path.join(repoRoot, 'mcp', 'synthi-mcp');
const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const bridgeScript = path.join(mcpRoot, 'scripts', 'bridge_agent.mts');

let closers: Array<() => Promise<void>> = [];
let children: ChildProcess[] = [];

function trackChild(child: ChildProcess): void {
  children.push(child);
}

async function killChild(child: ChildProcess | undefined): Promise<void> {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      child.kill('SIGTERM');
    }
  } catch {
    // already gone
  }
}

interface ToolResponseShape {
  ok?: boolean;
  error?: string;
  result?: Record<string, unknown>;
}

function postTool(port: number, body: Record<string, unknown>, headers: Record<string, string> = {}): Promise<{ status: number; body: ToolResponseShape }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = http.request(
      { host: '127.0.0.1', port, path: '/browser-workflows/tool', method: 'POST', headers: { 'content-type': 'application/json', ...headers } },
      (response) => {
        response.setEncoding('utf8');
        let raw = '';
        response.on('data', (chunk: string) => (raw += chunk));
        response.on('end', () => {
          response.destroy();
          let parsed: ToolResponseShape = {};
          try {
            parsed = JSON.parse(raw) as ToolResponseShape;
          } catch {
            parsed = {};
          }
          resolve({ status: response.statusCode ?? 0, body: parsed });
        });
        response.on('error', reject);
      },
    );
    request.setTimeout(10_000, () => {
      request.destroy(new Error(`postTool timed out after 10s on port ${port}`));
    });
    request.on('error', reject);
    request.end(payload);
  });
}

async function waitForBanner(child: ChildProcess, logs: () => string, deadlineMs = 60_000): Promise<number> {
  const started = Date.now();
  for (;;) {
    const match = logs().match(/AGENT BRIDGE LIVE on port (\d+)/);
    if (match) return Number(match[1]);
    if (Date.now() - started > deadlineMs || child.exitCode !== null) {
      throw new Error(`bridge never announced: ${logs().slice(-500)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

describe('embodied production deployment (WI-PROD)', () => {
  afterAll(async () => {
    await Promise.allSettled(children.map((child) => killChild(child)));
    await Promise.allSettled(closers.map((close) => close()));
    closers = [];
    children = [];
  });

  it('refuses non-loopback tool requests without a token and serves them with one', async () => {
    const { startBrowserWorkflowBridge } = await import('../../src/browser_workflow_bridge/server.js');
    const wide = startBrowserWorkflowBridge({ port: 0, host: '0.0.0.0' });
    await wide.ready;
    const port = (wide.server.address() as { port: number }).port;
    const probeStart = Date.now();
    const denied0 = await postTool(port, { tool: 'synthi_attach_substrate', arguments: {} }).catch((e) => ({ status: -1, body: { error: String(e.message) } }));

    // No token configured + non-loopback bind -> every tool request refused.
    const denied = await postTool(port, { tool: 'synthi_attach_substrate', arguments: {} });
    expect(denied.status).toBe(401);
    expect(denied.body.error).toBe('workflow_bridge_token_required');
    // Node's server.close() waits for idle keep-alive sockets that the
    // client globalAgent holds; force them closed from both ends.
    (http.globalAgent as unknown as { destroy?: () => void }).destroy?.();
    wide.server.closeAllConnections();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2_000).unref();
      wide.close(() => {
        clearTimeout(timer);
        resolve();
      });
    });

    // With a token: wrong/missing header refused, correct header served.
    const token = `tok-${process.pid}-${Date.now()}`;
    const guarded = startBrowserWorkflowBridge({ port: 0, host: '0.0.0.0', token });
    await guarded.ready;
    const guardedPort = (guarded.server.address() as { port: number }).port;
    closers.push(async () => {
      (http.globalAgent as unknown as { destroy?: () => void }).destroy?.();
      guarded.server.closeAllConnections();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2_000).unref();
        guarded.close(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    });

    const missing = await postTool(guardedPort, { tool: 'synthi_attach_substrate', arguments: {} });
    expect(missing.status).toBe(401);

    const authorized = await postTool(guardedPort, { tool: 'synthi_attach_substrate', arguments: {} }, { 'x-synthi-workflow-token': token });
    expect(authorized.status).toBe(200);
    expect(Array.isArray(authorized.body.result?.available_substrates)).toBe(true);
    guarded.server.closeAllConnections();
  }, 60_000);

  it('standalone agent refuses to start bound beyond loopback without a token', async () => {
    const logs: string[] = [];
    const child = spawn(
      process.execPath,
      [tsxCli, bridgeScript, '0'],
      {
        cwd: mcpRoot,
        env: { ...process.env, SYNTHI_BRIDGE_HOST: '0.0.0.0' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    trackChild(child);
    child.stdout?.on('data', (chunk: Buffer) => logs.push(chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => logs.push(chunk.toString()));

    const exitCode = await new Promise<number | null>((resolve) => {
      child.once('exit', (code) => resolve(code));
      setTimeout(() => resolve(null), 45_000).unref();
    });

    expect(exitCode).not.toBeNull(); // it must exit on its own, not keep serving
    expect(exitCode).not.toBe(0); // and loudly, not silently
    expect(logs.join('')).toContain('refusing to bind beyond this machine');
  }, 60_000);

  it('imports and runs a skill from a second working directory into its own realm', async () => {
    // Directory A teaches; directory B is agent B's foreign working dir.
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'wiprod-a-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'wiprod-b-'));
    // The taught flow invokes a small script file - no shell quoting. Each
    // world carries its own copy of project files; the SKILL transfers only
    // the flow (commands + effects), never world contents.
    const scriptBody = "require('fs').writeFileSync('out.txt','prod-ok');\n";
    await fsp.writeFile(path.join(dirA, 'write-out.cjs'), scriptBody, 'utf8');
    await fsp.writeFile(path.join(dirB, 'write-out.cjs'), scriptBody, 'utf8');

    // --- teach on a first in-process bridge ---
    const { registerSubstrateAdapter, unregisterAllSubstrateAdapters } = await import(
      '../../src/embodied/substrate.js'
    );
    const { createTerminalBundle, allowlistPolicy } = await import(
      '../../src/embodied/adapters/terminal/index.js'
    );
    unregisterAllSubstrateAdapters();
    registerSubstrateAdapter(createTerminalBundle(allowlistPolicy(['node'])));

    const { dispatchEmbodied } = await import('../../src/browser_workflow_bridge/embodied_dispatch.js');
    const unwrap = async (response: any): Promise<any> => {
      if (response?.structuredContent && response.structuredContent.ok === true) {
        return response.structuredContent;
      }
      throw new Error(`tool failed: ${JSON.stringify(response?.structuredContent ?? response).slice(0, 300)}`);
    };

    const realmA = dirA.replace(/\\/g, '/');
    const attachA = await unwrap(
      await dispatchEmbodied('synthi_attach_substrate', {
        substrate_kind: 'terminal',
        consent: { subject: 'prod-a', realm: { realm_kind: 'workspace', realm_id: realmA }, allow: ['observe', 'record', 'act'] },
      }),
    );
    await unwrap(await dispatchEmbodied('synthi_begin_teach', { session_id: attachA.session_id }));
    const acted = await unwrap(
      await dispatchEmbodied('synthi_perform_action', {
        session_id: attachA.session_id,
        action: { run: 'node write-out.cjs' },
      }),
    );
    expect(acted.ok).toBe(true);
    expect(await fsp.readFile(path.join(dirA, 'out.txt'), 'utf8')).toBe('prod-ok');

    const taught = await unwrap(
      await dispatchEmbodied('synthi_end_teach', {
        session_id: attachA.session_id,
        intent: 'produce out.txt',
        changed_values: [
          { path: 'out.txt', semantic_class: '', value_kind: 'string', after: 'prod-ok', changed_at_tick: 1 },
        ],
        control_diffs: [{ source_id: 'control', changed: [] }],
      }),
    );
    expect(taught.contract_id).toBeTruthy();
    const skill = await unwrap(
      await dispatchEmbodied('synthi_export_skill', { competency_id: taught.contract_id }),
    );
    unregisterAllSubstrateAdapters();

    // --- agent B: foreign cwd, its own license file, its own realm ---
    const realmB = dirB.replace(/\\/g, '/');
    const licensePath = path.join(os.tmpdir(), `wiprod-license-${process.pid}-${Date.now()}.json`);
    await fsp.writeFile(
      licensePath,
      JSON.stringify([
        {
          license_id: 'lic-wiprod-b',
          competency_id: skill.skill_id,
          substrate_scope: ['terminal'],
          realm_scopes: [{ realm_kind: 'workspace', realm_id: realmB }],
          entrustment: 'E2_supervised',
          issued_at_ms: 0,
          expires_at_ms: Number.MAX_SAFE_INTEGER,
        },
      ]),
      'utf8',
    );

    const logsB: string[] = [];
    const agentB = spawn(
      process.execPath,
      [tsxCli, bridgeScript, '0', '', licensePath],
      {
        cwd: dirB, // THE point: agent B works out of a foreign directory
        env: { ...process.env, SYNTHI_TERMINAL_AGENT: 'node' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    trackChild(agentB);
    agentB.stdout?.on('data', (chunk: Buffer) => logsB.push(chunk.toString()));
    agentB.stderr?.on('data', (chunk: Buffer) => logsB.push(chunk.toString()));
    const portB = await waitForBanner(agentB, () => logsB.join(''));

    const call = async (tool: string, args: unknown): Promise<any> =>
      postTool(portB, { tool, arguments: args }).then((r) => {
        if (r.status !== 200) throw new Error(`${tool}: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
        return r.body.result ?? r.body;
      });

    const imported = await call('synthi_import_skill', { skill });
    expect(imported.runnable).toBe(true);
    expect(imported.integrity_verified).toBe(true);

    const attachB = await call('synthi_attach_substrate', {
      substrate_kind: 'terminal',
      consent: { subject: 'prod-b', realm: { realm_kind: 'workspace', realm_id: realmB }, allow: ['observe', 'record', 'act'] },
    });
    expect(attachB.session_id).toBeTruthy();

    const run = await call('synthi_run_workflow', {
      competency_id: skill.skill_id,
      session_id: attachB.session_id,
      mode: 'fresh_state',
      required_level: 'E2_supervised',
    });
    expect(run.ok, JSON.stringify(run).slice(0, 300)).toBe(true);

    // THE WORLD PROVES IT: B produced the artifact in B's own directory.
    expect(await fsp.readFile(path.join(dirB, 'out.txt'), 'utf8')).toBe('prod-ok');
    // And A's world is untouched by B's execution.
    expect(await fsp.readFile(path.join(dirA, 'out.txt'), 'utf8')).toBe('prod-ok');
    expect(fs.readdirSync(dirB)).toContain('out.txt');

    // Stop agent B before removing directories - on Windows a process
    // holding a cwd lock makes rmdir EBUSY.
    await killChild(agentB);
    for (const attempt of [0, 1, 2]) {
      try {
        await fsp.rm(dirA, { recursive: true, force: true });
        await fsp.rm(dirB, { recursive: true, force: true });
        await fsp.rm(licensePath, { force: true });
        break;
      } catch {
        if (attempt === 2) throw new Error('temp dirs remained locked');
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }, 120_000);
});
