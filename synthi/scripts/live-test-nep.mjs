#!/usr/bin/env node
// Next-Edit Prediction (NEP) live-test harness.
//
// Mirrors mcp/synthi-mcp/scripts/live-test.mjs in spirit (preflight → seed →
// exercise → assert) but stays focused on what NEP needs:
//
//   Phase A  Unit-test the stream parser.
//   Phase B  Unit-test the validator (no whitespace normalization).
//   Phase C  Unit-test the byte-bounded recent-edit ring buffer.
//   Phase D  Preflight: frontend reachable on FRONTEND_URL?
//   Phase E  Live API hit: POST /api/next-edit with a synthetic refactor
//            trajectory and assert the model emits at least one block that
//            validates against the in-prompt file contents.
//   Phase F  (opt-in via --seed-workspace) Create a real workspace + seed
//            files via the collab-server, so the full end-to-end editor
//            flow can be exercised in a browser.
//
// Preconditions for Phase D/E:
//   - Synthi frontend running on FRONTEND_URL (default http://localhost:3000)
//   - GEMINI_API_KEY set in the frontend's env so /api/next-edit can call out
//
// Preconditions for Phase F (seed-workspace mode):
//   - collab-server running on COLLAB_URL (default http://localhost:1234)
//
// Env vars:
//   FRONTEND_URL          http://localhost:3000
//   COLLAB_URL            http://localhost:1234
//   SLUG                  nep-livetest-<ts>
//   WORKSPACE_NAME        NEP Live Test
//   HOST_ID               nep-live-test
//
// Usage:
//   node scripts/live-test-nep.mjs                  # phases A–E
//   node scripts/live-test-nep.mjs --seed-workspace # also runs Phase F
//   node scripts/live-test-nep.mjs --offline        # only phases A–C (no API)

import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Pull the parser + validator + buffer modules straight from the source tree.
// They're plain ESM with no imports, so Node ESM resolves them fine.
const nextEdit = await import(path.resolve(__dirname, '../src/lib/nextEdit.js'));
const nepBuffer = await import(path.resolve(__dirname, '../src/utils/nepRecentEdits.js'));

const {
  createStreamParser,
  parseBlock,
  validateBlock,
  countExactMatches,
  applyBlock,
  REJECT_REASONS,
  NEP_BLOCK_KIND,
  REPLACE_BOUNDARY,
  SEARCH_OPEN_KEYWORD,
  SEARCH_OPEN_ALL_KEYWORD,
  REPLACE_DIVIDER,
  API_NEXT_EDIT_ROUTE,
} = nextEdit;

const {
  pushNepEdit,
  resetNepBuffer,
  bufferBytes,
  NEP_BUFFER_BYTES,
} = nepBuffer;

// ───────────────────────── config ─────────────────────────

const args = new Set(process.argv.slice(2));
const SEED_WORKSPACE = args.has('--seed-workspace');
const OFFLINE = args.has('--offline');

const CFG = {
  frontendUrl: process.env.FRONTEND_URL ?? 'http://localhost:3000',
  collabUrl: process.env.COLLAB_URL ?? 'http://localhost:1234',
  slug: process.env.SLUG ?? `nep-livetest-${Date.now()}`,
  workspaceName: process.env.WORKSPACE_NAME ?? 'NEP Live Test',
  hostId: process.env.HOST_ID ?? 'nep-live-test',
};

// ───────────────────────── pretty printer ─────────────────────────

const color = {
  reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m',
  yellow: '\x1b[33m', blue: '\x1b[36m', dim: '\x1b[2m', bold: '\x1b[1m',
};
const TAG = {
  info: `${color.blue}[i]${color.reset}`,
  ok:   `${color.green}[✓]${color.reset}`,
  warn: `${color.yellow}[!]${color.reset}`,
  fail: `${color.red}[✗]${color.reset}`,
};
const log = (kind, msg) => console.log(`${TAG[kind]} ${msg}`);

let exitCode = 0;
const results = [];
const record = (phase, name, status, detail = '') => {
  results.push({ phase, name, status, detail });
  if (status === 'fail') exitCode = 1;
};

const assert = (phase, name, cond, detail = '') => {
  if (cond) {
    log('ok', `${phase} · ${name}`);
    record(phase, name, 'pass', detail);
  } else {
    log('fail', `${phase} · ${name}${detail ? ' — ' + detail : ''}`);
    record(phase, name, 'fail', detail);
  }
};

// ───────────────────────── helpers ─────────────────────────

const tcpPing = (host, port, timeoutMs = 2000) =>
  new Promise((resolve) => {
    const s = net.createConnection({ host, port });
    const t = setTimeout(() => { s.destroy(); resolve(false); }, timeoutMs);
    s.once('connect', () => { clearTimeout(t); s.end(); resolve(true); });
    s.once('error', () => { clearTimeout(t); resolve(false); });
  });

const parseUrl = (u) => {
  const x = new URL(u);
  return { host: x.hostname, port: Number(x.port) || (x.protocol === 'https:' ? 443 : 80) };
};

const httpJson = async (method, url, body, headers = {}) => {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = null; }
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status}: ${text.slice(0, 500)}`);
  return json ?? {};
};

// Build a complete SEARCH block string the way the model is expected to emit.
const buildBlock = ({ path: relPath, kind = NEP_BLOCK_KIND.SEARCH, search, replace }) => {
  const header = kind === NEP_BLOCK_KIND.SEARCH_ALL ? SEARCH_OPEN_ALL_KEYWORD : SEARCH_OPEN_KEYWORD;
  return [relPath, header, search, REPLACE_DIVIDER, replace, REPLACE_BOUNDARY].join('\n');
};

// ───────────────────────── Phase A: parser ─────────────────────────

const phaseA = () => {
  console.log(`\n${color.bold}━━━ Phase A: stream parser ━━━${color.reset}`);

  // A1. Single complete block round-trips.
  {
    const raw = buildBlock({
      path: 'src/main.cpp',
      search: 'int compute(int a, int b) {\n    return a + b;\n}',
      replace: 'int compute(int a, int b) {\n    return a * b;\n}',
    });
    const parsed = parseBlock(raw);
    assert('A', 'single SEARCH block parses', parsed.ok && parsed.block.kind === NEP_BLOCK_KIND.SEARCH,
      parsed.ok ? `path=${parsed.block.path}` : `reason=${parsed.reason}`);
    assert('A', 'single SEARCH preserves whitespace byte-for-byte',
      parsed.ok && parsed.block.search === 'int compute(int a, int b) {\n    return a + b;\n}');
  }

  // A2. SEARCH ALL parses with the right kind.
  {
    const raw = buildBlock({
      path: 'src/main.cpp', kind: NEP_BLOCK_KIND.SEARCH_ALL,
      search: 'oldName', replace: 'newName',
    });
    const parsed = parseBlock(raw);
    assert('A', 'SEARCH ALL parses with SEARCH_ALL kind',
      parsed.ok && parsed.block.kind === NEP_BLOCK_KIND.SEARCH_ALL);
  }

  // A3. Malformed: missing divider → parse_error.
  {
    const malformed = `src/main.cpp\n${SEARCH_OPEN_KEYWORD}\nfoo\n${REPLACE_BOUNDARY}`;
    const parsed = parseBlock(malformed);
    assert('A', 'missing divider → parse_error',
      !parsed.ok && parsed.reason === REJECT_REASONS.PARSE_ERROR);
  }

  // A4. Stream parser splits a multi-block stream chunked at arbitrary byte
  // offsets — including ones that fall mid-boundary token.
  {
    const block1 = buildBlock({
      path: 'a.cpp', search: 'int x = 1;', replace: 'int x = 2;',
    });
    const block2 = buildBlock({
      path: 'b.cpp', search: 'foo()', replace: 'bar()',
    });
    const stream = block1 + '\n' + block2;
    const parser = createStreamParser();
    const blocks = [];
    // Chunk every 7 bytes — guarantees we split mid-boundary.
    for (let i = 0; i < stream.length; i += 7) {
      const out = parser.feed(stream.slice(i, i + 7));
      for (const r of out) blocks.push(r);
    }
    for (const r of parser.flush()) blocks.push(r);
    const ok = blocks.length === 2 && blocks.every((b) => b.ok);
    assert('A', 'two-block stream chunked across boundaries parses cleanly',
      ok, `got ${blocks.length} blocks, ok=${blocks.filter(b => b.ok).length}`);
    if (ok) {
      assert('A', 'first block is a.cpp', blocks[0].block.path === 'a.cpp');
      assert('A', 'second block is b.cpp', blocks[1].block.path === 'b.cpp');
    }
  }

  // A5. Empty SEARCH text → empty_search.
  {
    const raw = `src/main.cpp\n${SEARCH_OPEN_KEYWORD}\n${REPLACE_DIVIDER}\nfoo\n${REPLACE_BOUNDARY}`;
    const parsed = parseBlock(raw);
    assert('A', 'empty SEARCH text rejects with empty_search',
      !parsed.ok && parsed.reason === REJECT_REASONS.EMPTY_SEARCH);
  }
};

// ───────────────────────── Phase B: validator ─────────────────────────

const phaseB = () => {
  console.log(`\n${color.bold}━━━ Phase B: validator ━━━${color.reset}`);

  const files = {
    'src/main.cpp': [
      '#include <iostream>',
      '',
      'int compute(int a, int b) {',
      '    return a + b;',
      '}',
      '',
      'int main() {',
      '    std::cout << compute(2, 3) << std::endl;',
      '    return 0;',
      '}',
      '',
    ].join('\n'),
    'src/repeat.cpp': 'foo();\nbar();\nfoo();\n', // foo() appears twice
  };
  const get = (p) => (p in files ? files[p] : null);

  // B1. Exact-match counter.
  assert('B', 'countExactMatches: zero', countExactMatches(files['src/main.cpp'], 'NOPE') === 0);
  assert('B', 'countExactMatches: one', countExactMatches(files['src/main.cpp'], 'compute(2, 3)') === 1);
  assert('B', 'countExactMatches: two', countExactMatches(files['src/repeat.cpp'], 'foo();') === 2);

  // B2. SEARCH N=1 → accept.
  {
    const v = validateBlock(
      { path: 'src/main.cpp', kind: NEP_BLOCK_KIND.SEARCH, search: 'compute(2, 3)' },
      get,
    );
    assert('B', 'SEARCH N=1 accepts', v.ok && v.matches === 1);
  }

  // B3. SEARCH N=0 → no_match.
  {
    const v = validateBlock(
      { path: 'src/main.cpp', kind: NEP_BLOCK_KIND.SEARCH, search: 'compute(99, 99)' },
      get,
    );
    assert('B', 'SEARCH N=0 rejects with no_match',
      !v.ok && v.reason === REJECT_REASONS.NO_MATCH);
  }

  // B4. SEARCH N=2 → ambiguous.
  {
    const v = validateBlock(
      { path: 'src/repeat.cpp', kind: NEP_BLOCK_KIND.SEARCH, search: 'foo();' },
      get,
    );
    assert('B', 'SEARCH N=2 rejects with ambiguous',
      !v.ok && v.reason === REJECT_REASONS.AMBIGUOUS && v.matches === 2);
  }

  // B5. SEARCH ALL N≥1 → phase2_required (Phase 1 logs only).
  {
    const v = validateBlock(
      { path: 'src/repeat.cpp', kind: NEP_BLOCK_KIND.SEARCH_ALL, search: 'foo();' },
      get,
    );
    assert('B', 'SEARCH ALL N=2 rejects with phase2_required',
      !v.ok && v.reason === REJECT_REASONS.PHASE2_REQUIRED);
  }

  // B6. CRITICAL: do NOT normalize whitespace. A SEARCH that differs only in
  // indentation must NOT match. Plan Section 2.
  {
    const v = validateBlock(
      {
        path: 'src/main.cpp',
        kind: NEP_BLOCK_KIND.SEARCH,
        // Real file has 4-space indent; this uses 2-space. They must NOT match.
        search: 'int compute(int a, int b) {\n  return a + b;\n}',
      },
      get,
    );
    assert('B', 'whitespace-mismatched SEARCH rejects with no_match (no normalization)',
      !v.ok && v.reason === REJECT_REASONS.NO_MATCH);
  }

  // B7. file_missing for unknown file path.
  {
    const v = validateBlock(
      { path: 'src/nope.cpp', kind: NEP_BLOCK_KIND.SEARCH, search: 'foo' },
      get,
    );
    assert('B', 'unknown file rejects with file_missing',
      !v.ok && v.reason === REJECT_REASONS.FILE_MISSING);
  }

  // B8. applyBlock round-trips for a validated block.
  {
    const before = files['src/main.cpp'];
    const block = {
      path: 'src/main.cpp',
      kind: NEP_BLOCK_KIND.SEARCH,
      search: 'return a + b;',
      replace: 'return a * b;',
    };
    let after;
    try { after = applyBlock(block, get); }
    catch (e) { after = null; }
    assert('B', 'applyBlock produces correct post-edit text',
      after && after.includes('return a * b;') && !after.includes('return a + b;'));
    // Restore for subsequent tests.
    files['src/main.cpp'] = before;
  }
};

// ───────────────────────── Phase C: ring buffer ─────────────────────────

const phaseC = () => {
  console.log(`\n${color.bold}━━━ Phase C: NEP ring buffer ━━━${color.reset}`);

  // C1. New buffer is empty.
  {
    const buf = resetNepBuffer();
    assert('C', 'reset returns empty array', Array.isArray(buf) && buf.length === 0);
  }

  // C2. Push round-trips.
  {
    let buf = resetNepBuffer();
    buf = pushNepEdit(buf, { path: 'a.cpp', snippet: '@@ a.cpp L1-1 @@\n+ int x = 1;' });
    assert('C', 'single push lands', buf.length === 1 && buf[0].path === 'a.cpp');
  }

  // C3. Eviction by bytes — push entries until total > NEP_BUFFER_BYTES.
  {
    let buf = resetNepBuffer();
    const big = '@@ x.cpp L1-1 @@\n' + ('+ // padding line that takes up bytes\n').repeat(40);
    for (let i = 0; i < 30; i++) {
      buf = pushNepEdit(buf, { path: `f${i}.cpp`, snippet: big });
    }
    const bytes = bufferBytes(buf);
    assert('C', `byte budget enforced (≤ ${NEP_BUFFER_BYTES})`,
      bytes <= NEP_BUFFER_BYTES, `got ${bytes} bytes across ${buf.length} entries`);
    // Newest entry must still be present (oldest is what evicts).
    assert('C', 'newest entry survives eviction',
      buf.length > 0 && buf[buf.length - 1].path === 'f29.cpp');
  }

  // C4. Trajectory order preserved (no path coalescing — that's intentional;
  // Plan Section 4 wants A→B→A visible as three entries).
  {
    let buf = resetNepBuffer();
    buf = pushNepEdit(buf, { path: 'a.cpp', snippet: '@@ a.cpp L1-1 @@\n+ a1' });
    buf = pushNepEdit(buf, { path: 'b.cpp', snippet: '@@ b.cpp L1-1 @@\n+ b1' });
    buf = pushNepEdit(buf, { path: 'a.cpp', snippet: '@@ a.cpp L2-2 @@\n+ a2' });
    assert('C', 'trajectory not coalesced by path',
      buf.length === 3 && buf[0].path === 'a.cpp' && buf[2].path === 'a.cpp');
  }
};

// ───────────────────────── Phase D: preflight ─────────────────────────

const phaseD = async () => {
  console.log(`\n${color.bold}━━━ Phase D: preflight ━━━${color.reset}`);
  const fe = parseUrl(CFG.frontendUrl);
  const feOk = await tcpPing(fe.host, fe.port);
  assert('D', `frontend reachable on ${CFG.frontendUrl}`, feOk);
  if (!feOk) {
    log('warn', 'Frontend not reachable — skipping live API phases. Start with: pnpm dev');
    return false;
  }
  if (SEED_WORKSPACE) {
    const cs = parseUrl(CFG.collabUrl);
    const csOk = await tcpPing(cs.host, cs.port);
    assert('D', `collab-server reachable on ${CFG.collabUrl}`, csOk);
    return csOk;
  }
  return true;
};

// ───────────────────────── Phase E: live API ─────────────────────────

const REFACTOR_FIXTURE = {
  // Two C++ files. The recent-edit history shows the user just renamed
  // `compute` → `multiply` in the .h header. The .cpp still calls `compute(`.
  // Expected NEP behaviour: emit one or more SEARCH blocks that update the
  // call site(s) in the .cpp file.
  files: {
    'src/calc.h': [
      '#pragma once',
      '',
      '// Math helpers.',
      'int multiply(int a, int b);',
      '',
    ].join('\n'),
    'src/main.cpp': [
      '#include <iostream>',
      '#include "calc.h"',
      '',
      'int main() {',
      '    int x = compute(2, 3);',
      '    int y = compute(5, 7);',
      '    std::cout << x << " " << y << std::endl;',
      '    return 0;',
      '}',
      '',
    ].join('\n'),
  },
  recentEdits: [
    {
      path: 'src/calc.h',
      snippet: [
        '@@ src/calc.h L4-4 @@',
        '  // Math helpers.',
        '+ int multiply(int a, int b);',
      ].join('\n'),
    },
  ],
};

const phaseE = async () => {
  console.log(`\n${color.bold}━━━ Phase E: live /api/next-edit ━━━${color.reset}`);

  const url = `${CFG.frontendUrl}${API_NEXT_EDIT_ROUTE}`;
  const payload = {
    workspaceSlug: CFG.slug,
    language: 'cpp',
    activePath: 'src/calc.h',
    cursor: { line: 4, column: 28 },
    recentEdits: REFACTOR_FIXTURE.recentEdits,
    files: REFACTOR_FIXTURE.files,
  };

  log('info', `POST ${url} (refactor scenario: rename compute→multiply)`);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    log('fail', `fetch failed: ${e.message}`);
    record('E', 'POST /api/next-edit', 'fail', e.message);
    return;
  }

  assert('E', 'POST /api/next-edit responds 200', res.ok, `status=${res.status}`);
  if (!res.ok) {
    try { console.error(await res.text()); } catch (_) { /* ignored */ }
    return;
  }

  // Stream response and feed the parser. Same loop the editor hook runs.
  const reader = res.body?.getReader?.();
  if (!reader) {
    log('warn', 'response body not streamable — falling back to text()');
    const text = await res.text();
    feedAndAssert(text);
    return;
  }
  const decoder = new TextDecoder();
  const parser = createStreamParser();
  const blocks = [];
  let totalBytes = 0;
  const t0 = Date.now();
  let firstBoundaryAt = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    const text = decoder.decode(value, { stream: true });
    const out = parser.feed(text);
    if (out.length && firstBoundaryAt === null) firstBoundaryAt = Date.now() - t0;
    for (const r of out) blocks.push(r);
  }
  for (const r of parser.flush()) blocks.push(r);
  const elapsed = Date.now() - t0;

  log('info', `streamed ${totalBytes} bytes in ${elapsed}ms (first boundary @ ${firstBoundaryAt ?? 'n/a'}ms)`);
  log('info', `parsed ${blocks.length} block(s); ok=${blocks.filter(b => b.ok).length}`);

  for (const r of blocks) {
    if (r.ok) {
      log('info', `  block: path=${r.block.path} kind=${r.block.kind} ` +
                  `search=${JSON.stringify(r.block.search.slice(0, 50))} ` +
                  `replace=${JSON.stringify(r.block.replace.slice(0, 50))}`);
    } else {
      log('warn', `  reject: reason=${r.reason} detail=${r.detail || ''}`);
    }
  }

  assert('E', 'at least one block was emitted', blocks.length >= 1,
    `got ${blocks.length}`);

  if (blocks.length === 0) return;

  // Validate every parsed block against the in-prompt files.
  const get = (p) => (p in REFACTOR_FIXTURE.files ? REFACTOR_FIXTURE.files[p] : null);
  let validated = 0;
  let validatedCorrect = 0;
  for (const r of blocks) {
    if (!r.ok) continue;
    const v = validateBlock(r.block, get);
    if (v.ok) {
      validated += 1;
      // Domain check: a "correct" Phase 1 SEARCH block for this scenario edits
      // src/main.cpp and replaces a `compute(` call with a `multiply(` call.
      if (
        r.block.path === 'src/main.cpp' &&
        r.block.search.includes('compute(') &&
        r.block.replace.includes('multiply(')
      ) {
        validatedCorrect += 1;
      }
    } else {
      log('warn', `  validate reject: ${v.reason} path=${v.path || r.block.path}`);
    }
  }

  assert('E', `at least one block validates against the file (N=1 exact match)`,
    validated >= 1, `validated=${validated}/${blocks.filter(b => b.ok).length}`);
  // The "correct prediction" check is a softer assertion — the model isn't
  // guaranteed to nail it on every run. Surface it as a warn, not a fail.
  if (validatedCorrect >= 1) {
    log('ok', `model predicted the rename in src/main.cpp (${validatedCorrect} block${validatedCorrect > 1 ? 's' : ''})`);
    record('E', 'model predicted compute→multiply rename', 'pass', `${validatedCorrect} blocks`);
  } else {
    log('warn', `model did NOT predict the rename in src/main.cpp — quality regression?`);
    record('E', 'model predicted compute→multiply rename', 'warn',
      `${validated} validated, 0 matched the expected rename pattern`);
  }
};

const feedAndAssert = (text) => {
  const parser = createStreamParser();
  const blocks = parser.feed(text).concat(parser.flush());
  log('info', `non-streamed: parsed ${blocks.length} blocks from ${text.length} chars`);
};

// ───────────────────────── Phase F: workspace seed (opt-in) ─────────────────────────

const phaseF = async () => {
  console.log(`\n${color.bold}━━━ Phase F: workspace seed (opt-in) ━━━${color.reset}`);

  log('info', `POST /api/workspace  {name, slug:"${CFG.slug}"}`);
  let workspace;
  try {
    workspace = await httpJson('POST', `${CFG.frontendUrl}/api/workspace`,
      { name: CFG.workspaceName, slug: CFG.slug });
  } catch (e) {
    log('fail', `workspace create failed: ${e.message}`);
    record('F', 'POST /api/workspace', 'fail', e.message);
    return;
  }
  log('ok', `workspace id=${workspace.id} slug=${workspace.slug}`);
  record('F', 'POST /api/workspace', 'pass', `id=${workspace.id}`);

  // Seed the two refactor-fixture files via the collab-server batch endpoint.
  log('info', 'POST /git/:slug/write-files-batch (seeding refactor fixture)');
  try {
    await httpJson('POST', `${CFG.collabUrl}/git/${CFG.slug}/write-files-batch`,
      {
        files: Object.entries(REFACTOR_FIXTURE.files).map(([p, content]) => ({
          path: p, encoding: 'utf8', content,
        })),
        syncToGcs: true,
      },
      { 'x-user-id': CFG.hostId });
    log('ok', 'fixture files written to collab-server disk');
    record('F', 'write-files-batch', 'pass');
  } catch (e) {
    log('fail', `seed failed: ${e.message}`);
    record('F', 'write-files-batch', 'fail', e.message);
    return;
  }

  // Stage + commit so the fixture is part of the history.
  try {
    await httpJson('POST', `${CFG.collabUrl}/git/${CFG.slug}/stage-all`, {},
      { 'x-user-id': CFG.hostId });
    await httpJson('POST', `${CFG.collabUrl}/git/${CFG.slug}/commit`,
      { message: 'nep-live-test: seed refactor fixture' },
      { 'x-user-id': CFG.hostId });
    log('ok', 'staged + committed');
    record('F', 'stage+commit', 'pass');
  } catch (e) {
    log('warn', `stage/commit failed: ${e.message}`);
    record('F', 'stage+commit', 'warn', e.message);
  }

  const url = `${CFG.frontendUrl}/workspace/${CFG.slug}`;
  console.log('');
  log('info', `Open ${color.bold}${url}${color.reset} in your browser to exercise NEP in the editor.`);
  log('info', 'Enable NEP via DevTools console:');
  console.log(`    ${color.dim}window.__SYNTHI_NEP_ENABLED__ = true; location.reload()${color.reset}`);
  log('info', 'Then make an edit in src/calc.h that resembles a refactor and watch for the gutter dot in src/main.cpp.');
};

// ───────────────────────── main ─────────────────────────

const summarize = () => {
  console.log(`\n${color.bold}━━━ summary ━━━${color.reset}`);
  const counts = { pass: 0, warn: 0, fail: 0 };
  for (const r of results) counts[r.status] = (counts[r.status] ?? 0) + 1;
  for (const r of results) {
    const icon = TAG[r.status === 'pass' ? 'ok' : r.status === 'warn' ? 'warn' : 'fail'];
    console.log(`  ${icon} ${r.phase} · ${r.name}${r.detail ? color.dim + '  (' + r.detail + ')' + color.reset : ''}`);
  }
  console.log('');
  console.log(`  ${color.green}pass: ${counts.pass}${color.reset}    ${color.yellow}warn: ${counts.warn}${color.reset}    ${color.red}fail: ${counts.fail}${color.reset}`);
};

const main = async () => {
  console.log(`${color.blue}\n━━━ NEP live-test ━━━${color.reset}`);
  console.log(`  frontend  ${CFG.frontendUrl}`);
  console.log(`  slug      ${CFG.slug}`);
  console.log(`  flags     ${[SEED_WORKSPACE && '--seed-workspace', OFFLINE && '--offline'].filter(Boolean).join(' ') || '(none)'}`);

  phaseA();
  phaseB();
  phaseC();

  if (OFFLINE) {
    log('info', '--offline: skipping phases D–F');
    summarize();
    process.exit(exitCode);
    return;
  }

  const preflightOk = await phaseD();
  if (!preflightOk) {
    summarize();
    process.exit(exitCode);
    return;
  }
  await phaseE();
  if (SEED_WORKSPACE) await phaseF();

  summarize();
  process.exit(exitCode);
};

main().catch((e) => {
  console.error(`${TAG.fail} unhandled: ${e?.stack ?? e}`);
  process.exit(1);
});
