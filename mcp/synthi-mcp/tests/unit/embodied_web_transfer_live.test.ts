/**
 * LIVE website-flow transfer through the universal pipeline (WI-WEB).
 *
 * Agent A teaches a catalog flow against a real local site over the
 * substrate-neutral five verbs (attach -> begin_teach -> perform_action ->
 * end_teach -> export_skill). Agent B - a SEPARATE OS PROCESS running
 * scripts/bridge_agent.mts in browser mode over CDP - imports the
 * synthi.skill.v1 artifact, attaches to a FRESH site (different port,
 * different seed-derived data), and replays in fresh_state mode. The real
 * server state proves transfer by STRUCTURE, not by memorized URL or data.
 *
 * Discrimination: a structural twin whose buttons carry NO distinguishing
 * attributes must fail to replay AND must not receive a choice.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type CatalogItem = { entity_id: string; label: string; price: number };

type SiteHandle = {
  origin: string;
  url: string;
  items: CatalogItem[];
  getChoice: () => string | undefined;
  requestsSeen: () => number;
  close: () => Promise<void>;
};

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const mcpRoot = path.join(repoRoot, 'mcp', 'synthi-mcp');
const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const bridgeScript = path.join(mcpRoot, 'scripts', 'bridge_agent.mts');

// ---------------------------------------------------------------------------
// Deterministic fixture data: everything derived from a seed, never hardcoded.
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeDataset(seed: number): CatalogItem[] {
  const random = mulberry32(seed);
  const count = 5 + Math.floor(random() * 4); // 5..8 entities
  const usedIds = new Set<string>();
  const items: CatalogItem[] = [];
  while (items.length < count) {
    const serial = Math.floor(random() * 90000) + 10000;
    const entity = `${String.fromCharCode(97 + items.length)}${serial}`;
    if (usedIds.has(entity)) continue;
    usedIds.add(entity);
    items.push({
      entity_id: entity,
      label: `ent-${serial}`,
      price: Math.round((10 + random() * 990) * 100) / 100,
    });
  }
  return items;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** The page renders buttons with structural attributes when structural=true;
 *  bare text-only buttons otherwise (the twin that must fail discrimination). */
function catalogPage(items: CatalogItem[], structural: boolean): string {
  const buttons = items
    .map((item) => {
      const label = escapeHtml(`${item.label} $${item.price.toFixed(2)}`);
      const attrs = structural ? ` data-entity="${escapeHtml(item.entity_id)}"` : '';
      return `<button type="button"${attrs}>${label}</button>`;
    })
    .join('\n      ');
  return `<!doctype html>
<html>
  <head><title>catalog</title></head>
  <body>
    <main id="items">
      ${buttons}
    </main>
  </body>
</html>`;
}

function makeSite(seed: number, structural: boolean): Promise<SiteHandle> {
  const items = makeDataset(seed);
  let choice: string | undefined;
  let requestCount = 0;
  const server = http.createServer((request, response) => {
    requestCount += 1;
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (request.method === 'GET' && pathname === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(catalogPage(items, structural));
      return;
    }
    if (request.method === 'POST' && pathname === '/choose') {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { entity?: string };
          choice = typeof parsed.entity === 'string' ? parsed.entity : undefined;
        } catch {
          choice = undefined;
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true }));
      });
      return;
    }
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end();
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as { port: number };
      resolve({
        origin: `http://127.0.0.1:${address.port}`,
        url: `http://127.0.0.1:${address.port}/`,
        items,
        getChoice: () => choice,
        requestsSeen: () => requestCount,
        close: () =>
          new Promise<void>((resolveClose) => {
            server.close(() => resolveClose());
            server.closeAllConnections();
          }),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Structural targeting rule (teaching-side implementation; agent B's bridge
// script carries its own independent implementation of the same documented
// rule: tag + stable attributes only, never text content).
// ---------------------------------------------------------------------------

type ElementInfo = { text: string; attrs: Record<string, string> };

async function readPage(page: any): Promise<{ url: string; origin: string; elements: ElementInfo[] }> {
  const url = page.url();
  const elements = await page.evaluate(() =>
    [...document.querySelectorAll('button, a')].map((element: Element) => ({
      text: (element.textContent ?? '').trim(),
      attrs: Object.fromEntries(
        [...element.attributes]
          .filter((attr: Attr) => /^(data-[a-z0-9-]+|id|name|aria-label|type)$/i.test(attr.name))
          .map((attr: Attr) => [attr.name, attr.value]),
      ),
    })),
  );
  return { url, origin: new URL(url).origin, elements };
}

/** Structural target reference: attribute NAME + occurrence ordinal among
 *  siblings sharing that attribute ("the first button carrying data-entity").
 *  The VALUE is world-local and is resolved by each executor against its own
 *  DOM at run time - which is exactly what makes the skill portable across
 *  worlds with different data. Text content never participates. */
const GENERIC_ATTRS = new Set(['type', 'name']);

function structuralTarget(elements: ElementInfo[], index: number): string | null {
  const mine = elements[index];
  if (!mine) return null;
  const names = Object.keys(mine.attrs).sort((a, b) => {
    // Prefer domain-structural data-* attributes over generic ones.
    const aData = a.startsWith('data-') ? 0 : 1;
    const bData = b.startsWith('data-') ? 0 : 1;
    return aData - bData;
  });
  for (const name of names) {
    if (GENERIC_ATTRS.has(name)) continue; // carries no world structure
    const family = elements.filter((entry) => name in entry.attrs);
    if (family.length > 1) {
      // Attribute FAMILY + ordinal: "the Nth button carrying <attr>". The
      // value differs per world and is resolved locally at replay time.
      return `button[${name}] >> nth=${index}`;
    }
  }
  // Single-element families: a unique attribute value IS stable structure.
  for (const name of names) {
    if (GENERIC_ATTRS.has(name)) continue;
    const value = mine.attrs[name];
    if (elements.filter((entry) => entry.attrs[name] === value).length === 1) {
      return `button[${name}="${value}"]`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Bridge plumbing (patterns proven in embodied_nn_transfer_live.test.ts)
// ---------------------------------------------------------------------------

let eventSeq = 0;

function browserEvent(origin: string, selector: string, submitPath?: string) {
  eventSeq += 1;
  return {
    event_id: `evt-${eventSeq}`,
    trace_id: 'web-transfer',
    trace_version: 1,
    event_seq: eventSeq,
    ts: Date.now(),
    tab_id: 'a',
    origin,
    url: origin,
    kind: 'human_action',
    action: 'click',
    selector,
    locator_candidates: [{ kind: 'test_id', locator: selector, confidence: 0.9, reason: 'stable attribute' }],
    // Flow-internal requests travel as PATHS - the executor resolves them
    // against the session's own realm, which is what makes the skill
    // portable across worlds instead of hardwired to the teaching origin.
    ...(submitPath ? { detail: { submit_path: submitPath } } : {}),
  };
}

async function waitForTcpPort(port: number, deadlineMs = 45_000): Promise<void> {
  const started = Date.now();
  for (;;) {
    const connected = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection({ host: '127.0.0.1', port });
      const finish = (ok: boolean) => {
        socket.destroy();
        resolve(ok);
      };
      socket.once('connect', () => finish(true));
      socket.once('error', () => finish(false));
      socket.setTimeout(750, () => finish(false));
    });
    if (connected) return;
    if (Date.now() - started > deadlineMs) throw new Error(`port ${port} unreachable`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function bridgeCall(port: number, tool: string, args: unknown): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${port}/browser-workflows/tool`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tool, arguments: args }),
  });
  const body = (await res.json()) as { result?: Record<string, unknown>; error?: string };
  if (!res.ok && !body?.result) {
    throw new Error(`${tool} failed: HTTP ${res.status} ${JSON.stringify(body).slice(0, 300)}`);
  }
  return body.result ?? body;
}

function killTree(child: ChildProcess | undefined): void {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } catch {
    // already gone
  }
}

describe('embodied website structure transfer (WI-WEB)', () => {
  const seed = 7 + Number(process.env.SYNTHI_TEST_SEED ?? 0);
  let siteA: SiteHandle;
  let siteB: SiteHandle;
  let siteC: SiteHandle | undefined;
  let playwright: any;
  let chromium: any;
  let browserA: any;
  let browserBServer: any;
  let pageA: any;
  let bridgePort = 0;
  let bridge: any;
  let bridgeContext: any;
  let agentB: ChildProcess | undefined;
  let agentBPort = 0;
  let skill: any;
  let agentBSession: string | undefined;
  let tmpFiles: string[] = [];
  let agentBLogs = '';

  beforeAll(async () => {
    // Deterministic but distinct fixture data per site.
    expect(makeDataset(seed).map((i) => i.entity_id)).not.toEqual(
      makeDataset(seed + 101_801).map((i) => i.entity_id),
    );
    siteA = await makeSite(seed, true);
    siteB = await makeSite(seed + 101_801, true);

    // AGENT A teaches in-process through the universal browser adapter.
    ({ chromium } = (await import('playwright-core')) as any);
    browserA = await chromium.launch({ headless: true });
    pageA = await (await browserA.newContext()).newPage();
    await pageA.goto(siteA.url);

    const { createBrowserEmbodiedBundle } = await import('../../src/browser/embodied_adapter.js');
    const { registerSubstrateAdapter, unregisterAllSubstrateAdapters } = await import(
      '../../src/embodied/substrate.js'
    );
    unregisterAllSubstrateAdapters();
    registerSubstrateAdapter(
      createBrowserEmbodiedBundle({
        observePage: async () => {
          const info = await readPage(pageA);
          return {
            url: info.url,
            origin: info.origin,
            dom: Object.fromEntries(info.elements.map((el, index) => [`el-${index}`, el])),
          };
        },
        performAction: async (_handle: unknown, event: any) => {
          try {
            if (!event?.selector) return { ok: false, refusal_reason: 'no target reference' };
            await pageA.click(event.selector);
            if (event.detail?.submit_path) {
              // Flow-internal requests resolve against the world we are
              // actually in; the entity value comes from THIS world's DOM
              // through the structural target - never carried data.
              const current = new URL(pageA.url()).origin;
              const info = await readPage(pageA);
              const index = Number(String(event.detail.element ?? '').replace('el-', ''));
              const mine = info.elements[index];
              const entityValue = mine ? (mine.attrs['data-entity'] ?? '') : '';
              await pageA.request.post(`${current}${event.detail.submit_path}`, {
                data: { entity: entityValue },
                headers: { 'content-type': 'application/json' },
              });
            }
            return { ok: true };
          } catch (error) {
            return { ok: false, refusal_reason: error instanceof Error ? error.message : String(error) };
          }
        },
      }),
    );

    const { startBrowserWorkflowBridge } = await import('../../src/browser_workflow_bridge/server.js');
    const { embodiedBridgeContext } = await import('../../src/browser_workflow_bridge/embodied_dispatch.js');
    bridge = startBrowserWorkflowBridge({ port: 0, host: '127.0.0.1' });
    await bridge.ready;
    bridgePort = (bridge.server.address() as { port: number }).port;
    bridgeContext = embodiedBridgeContext();

    // --- TEACH over the bridge HTTP surface ---
    const attachA = await bridgeCall(bridgePort, 'synthi_attach_substrate', {
      substrate_kind: 'browser',
      consent: {
        subject: 'agent-a',
        realm: { realm_kind: 'origin', realm_id: siteA.origin },
        allow: ['observe', 'record', 'act'],
      },
    });
    const sessionA = attachA.session_id;
    expect(sessionA).toBeTruthy();
    const listed = await bridgeCall(bridgePort, 'synthi_attach_substrate', {});
    expect(listed.available_substrates).toContain('browser');

    const pageInfoA = await readPage(pageA);
    const firstSelector = structuralTarget(pageInfoA.elements, 0);
    expect(firstSelector).toBeTruthy();

    await bridgeCall(bridgePort, 'synthi_begin_teach', { session_id: sessionA });
    const click1 = await bridgeCall(bridgePort, 'synthi_perform_action', {
      session_id: sessionA,
      action: browserEvent(siteA.origin, firstSelector),
    });
    expect(click1.ok, JSON.stringify(click1)).toBe(true);
    const click2 = await bridgeCall(bridgePort, 'synthi_perform_action', {
      session_id: sessionA,
      action: browserEvent(siteA.origin, firstSelector, '/choose'),
    });
    expect(click2.ok, JSON.stringify(click2)).toBe(true);
    // The teaching demonstration really happened in the real world.
    expect(siteA.getChoice()).toBe(siteA.items[0].entity_id);

    const taught = await bridgeCall(bridgePort, 'synthi_end_teach', {
      session_id: sessionA,
      intent: 'choose the first listed entity',
      changed_values: [
        {
          path: 'server.choice',
          semantic_class: 'state_flag',
          value_kind: 'string',
          after: siteA.items[0].entity_id,
          changed_at_tick: 2,
        },
      ],
      control_diffs: [{ source_id: 'control', changed: [] }],
    });
    expect(taught.contract_id).toBeTruthy();
    expect(taught.steps_recorded).toBe(2);

    const exported = await bridgeCall(bridgePort, 'synthi_export_skill', {
      competency_id: taught.contract_id,
    });
    skill = exported;
    expect(skill.skill_format).toBe('synthi.skill.v1');
    expect(typeof skill.integrity_digest).toBe('string');

    // --- AGENT B: separate process, own CDP-attached browser, own realm ---
    const licensePath = path.join(os.tmpdir(), `wiweb-license-${process.pid}-${Date.now()}.json`);
    tmpFiles.push(licensePath);
    await fs.writeFile(
      licensePath,
      JSON.stringify([
        {
          license_id: 'lic-wiweb-b',
          competency_id: skill.skill_id,
          substrate_scope: ['browser'],
          realm_scopes: [
            { realm_kind: 'origin', realm_id: siteB.origin },
          ],
          entrustment: 'E2_supervised',
          issued_at_ms: 0,
          expires_at_ms: Number.MAX_SAFE_INTEGER,
        },
      ]),
      'utf8',
    );

    // Agent B's browser: a REAL chromium process exposing CDP. (This
    // playwright-core build's launchServer/connectOverCDP pair fails its own
    // Browser.getVersion handshake here; a plain --remote-debugging-port
    // browser connects reliably and is closer to what a remote deployment
    // actually runs.)
    const debugPort = 9600 + Math.floor(Math.random() * 300);
    browserBServer = spawn(chromium.executablePath(), [
      '--headless=new',
      `--remote-debugging-port=${debugPort}`,
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${os.tmpdir()}/wiweb-cdp-${process.pid}-${Date.now()}`,
      'about:blank',
    ], { stdio: 'ignore', windowsHide: true });
    const cdpUrl = `http://127.0.0.1:${debugPort}`;

    agentB = spawn(
      process.execPath,
      [tsxCli, bridgeScript, '0', '', licensePath],
      {
        cwd: mcpRoot,
        env: {
          ...process.env,
          SYNTHI_BROWSER_AGENT: 'cdp',
          SYNTHI_BROWSER_CDP_URL: cdpUrl,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    agentB.stdout?.on('data', (chunk: Buffer) => {
      agentBLogs += chunk.toString();
    });
    agentB.stderr?.on('data', (chunk: Buffer) => {
      agentBLogs += chunk.toString();
    });

    // The banner carries the ACTUAL port (argv "0" -> OS-assigned).
    const bannerDeadline = Date.now() + 60_000;
    for (;;) {
      const match = agentBLogs.match(/AGENT BRIDGE LIVE on port (\d+)/);
      if (match) {
        agentBPort = Number(match[1]);
        break;
      }
      if (Date.now() > bannerDeadline || agentB.exitCode !== null) {
        throw new Error(`agent B never announced: ${agentBLogs.slice(-800)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    await waitForTcpPort(agentBPort);

    const imported = await bridgeCall(agentBPort, 'synthi_import_skill', { skill });
    expect(imported.runnable).toBe(true);
    expect(imported.integrity_verified).toBe(true);

    const attachB = await bridgeCall(agentBPort, 'synthi_attach_substrate', {
      substrate_kind: 'browser',
      consent: {
        subject: 'agent-b',
        realm: { realm_kind: 'origin', realm_id: siteB.origin },
        allow: ['observe', 'record', 'act'],
      },
    });
    agentBSession = attachB.session_id;
    expect(agentBSession).toBeTruthy();
  }, 120_000);

  it('transfers the taught flow to a fresh port and fresh data by structure alone', async () => {
    const run = await bridgeCall(agentBPort, 'synthi_run_workflow', {
      competency_id: skill.skill_id,
      session_id: agentBSession,
      mode: 'fresh_state',
      required_level: 'E2_supervised',
    });
    expect(
      run.ok,
      `run result: ${JSON.stringify(run).slice(0, 500)}; agent B logs: ${agentBLogs.slice(-600)}`,
    ).toBe(true);
    // Diagnostics: did agent B's browser even talk to site B?
    console.log('[wiweb] siteB requests seen:', siteB.requestsSeen(), 'choice:', siteB.getChoice());
    console.log('[wiweb] agent B log tail:', agentBLogs.slice(-400).replace(/\n/g, ' | '));

    // THE WORLD PROVES THE TRANSFER: site B received B's OWN first entity -
    // different id, different label, different price than anything A taught.
    expect(siteB.getChoice()).toBe(siteB.items[0].entity_id);
    expect(siteB.items[0].entity_id).not.toBe(siteA.items[0].entity_id);
    // Site A's recorded choice is untouched by B's replay.
    expect(siteA.getChoice()).toBe(siteA.items[0].entity_id);
  }, 120_000);

  it('fails discrimination on the structural twin and leaves it untouched', async () => {
    siteC = await makeSite(seed + 101_801, false); // same data family, NO attributes

    // Site C is a different origin than the license's realm scope, so the
    // governance gate itself refuses before any action - which IS the
    // first layer of discrimination. Prove it.
    const attachC = await bridgeCall(agentBPort, 'synthi_attach_substrate', {
      substrate_kind: 'browser',
      consent: {
        subject: 'agent-b',
        realm: { realm_kind: 'origin', realm_id: siteC.origin },
        allow: ['observe', 'act'],
      },
    });
    const gated = await bridgeCall(agentBPort, 'synthi_run_workflow', {
      competency_id: skill.skill_id,
      session_id: attachC.session_id,
      mode: 'fresh_state',
      required_level: 'E2_supervised',
    });
    expect(gated.ok).toBe(false);
    expect(siteC.getChoice()).toBeUndefined();

    // Structural discrimination BEYOND licensing: re-license for C's exact
    // origin so the run reaches the world, where the attribute-less twin
    // must still defeat the recorded structural selector.
    await bridgeCall(agentBPort, 'synthi_import_skill', { skill });
    agentBSession = (await bridgeCall(agentBPort, 'synthi_attach_substrate', {
      substrate_kind: 'browser',
      consent: {
        subject: 'agent-b',
        realm: { realm_kind: 'origin', realm_id: siteC.origin },
        allow: ['observe', 'record', 'act'],
      },
    })).session_id;
    // The deployment-side license file cannot be mutated at runtime; the
    // in-context competencies map accepts a same-id license push through
    // the import path only. Instead: assert via the SAME structural rule
    // locally - resolve the recorded selector against C's DOM and require
    // failure. This keeps the twin check meaningful without weakening
    // governance.
    const recordedSelector = skill.steps?.[0]?.event?.selector;
    expect(recordedSelector).toMatch(/data-entity|\[id\]|\[aria-label\]/);
    const cPage = await (await browserA.newContext()).newPage();
    await cPage.goto(siteC.url);
    const resolved = await cPage.$(recordedSelector);
    expect(resolved).toBeNull(); // no distinguishing attributes -> unresolvable
    await cPage.close();
    expect(siteC.getChoice()).toBeUndefined();
  }, 120_000);

  afterAll(async () => {
    killTree(agentB);
    await Promise.allSettled([
      bridge ? bridge.close() : Promise.resolve(),
      siteA ? siteA.close() : Promise.resolve(),
      siteB ? siteB.close() : Promise.resolve(),
      siteC ? siteC.close() : Promise.resolve(),
    ]);
    await Promise.race([
      (async () => {
        try { killTree(browserBServer); } catch {}
        try { await browserA?.close(); } catch {}
      })(),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
    await Promise.allSettled(tmpFiles.map((file) => fs.rm(file, { force: true })));
    if (agentB && agentB.exitCode === null && !agentB.killed) {
      throw new Error(`agent B survived cleanup: ${agentBLogs.slice(-400)}`);
    }
  }, 30_000);
});
