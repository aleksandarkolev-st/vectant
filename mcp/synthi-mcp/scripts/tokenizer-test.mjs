#!/usr/bin/env node
// Synthi tokenizer fixture seeder.
//
// Spins up a fresh workspace (frontend POST /api/workspace), pushes one fixture
// per first-class language (cpp, java, rust, js, ts, html, css) through the
// collab-server's /git/:slug/write-files-batch endpoint, then stages + commits
// — exactly the same pattern as scripts/live-test.mjs uses for main.cpp.
//
// After it runs, open the printed workspace URL in the browser and visually
// inspect each file: the Synthi Dark theme should paint keywords in dark green
// while function calls, types, ALL_CAPS macros, attributes, hex colours and
// numeric units each show up in their own colour.
//
// Preconditions (same as live-test.mjs):
//   - signaling-server :9000, collab-server :1234, frontend :3000 all up
//   - redis / y-sweet / ai-engine / gateway running
//
// Env vars (with defaults):
//   FRONTEND_URL     http://localhost:3000
//   COLLAB_URL       http://localhost:1234
//   SLUG             tokenizer-fixture-<ts>
//   WORKSPACE_NAME   Synthi Tokenizer Fixture
//   HOST_ID          tokenizer-test
//   FIXTURE_DIR      ../tests/fixtures/tokenizers
//   SYNC_TO_GCS      false
//   AUTO_OPEN        false   (set true to xdg-open the workspace URL)

import { exec } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const CFG = {
    frontendUrl:    process.env.FRONTEND_URL    ?? 'http://localhost:3000',
    collabUrl:      process.env.COLLAB_URL      ?? 'http://localhost:1234',
    slug:           process.env.SLUG            ?? `tokenizer-fixture-${Date.now()}`,
    workspaceName:  process.env.WORKSPACE_NAME  ?? 'Synthi Tokenizer Fixture',
    hostId:         process.env.HOST_ID         ?? 'tokenizer-test',
    fixtureDir:     path.resolve(__dirname, process.env.FIXTURE_DIR ?? '../tests/fixtures/tokenizers'),
    syncToGcs:     (process.env.SYNC_TO_GCS    ?? 'false').toLowerCase() === 'true',
    autoOpen:      (process.env.AUTO_OPEN      ?? 'false').toLowerCase() === 'true',
};

// One entry per language we want to exercise.  `path` is the fixture filename
// on disk (relative to CFG.fixtureDir); `dest` is where it lands in the
// workspace's git tree.
const FIXTURES = [
    { lang: 'cpp',        src: 'sample.cpp',   dest: 'sample.cpp'   },
    { lang: 'java',       src: 'Sample.java',  dest: 'Sample.java'  },
    { lang: 'rust',       src: 'sample.rs',    dest: 'sample.rs'    },
    { lang: 'javascript', src: 'sample.js',    dest: 'sample.js'    },
    { lang: 'typescript', src: 'sample.ts',    dest: 'sample.ts'    },
    { lang: 'html',       src: 'sample.html',  dest: 'sample.html'  },
    { lang: 'css',        src: 'sample.css',   dest: 'sample.css'   },
];

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

async function createWorkspace({ frontendUrl, name, slug }) {
    return httpJson('POST', `${frontendUrl}/api/workspace`, { name, slug });
}

async function writeFilesBatch({ collabUrl, slug, userId, files, syncToGcs }) {
    const res = await httpJson(
        'POST',
        `${collabUrl}/git/${slug}/write-files-batch`,
        {
            files: files.map((f) => ({ path: f.path, encoding: 'utf8', content: f.content })),
            syncToGcs: syncToGcs === true,
        },
        { 'x-user-id': userId },
    );
    const written  = res.written?.length ?? 0;
    const skipped  = res.skipped?.length ?? 0;
    const errors   = res.errors ?? [];
    const gcsErrs  = errors.filter((e) => e.stage === 'gcs_upload');
    const hardErrs = errors.filter((e) => e.stage !== 'gcs_upload');
    return { written, skipped, gcsErrs, hardErrs, raw: res };
}

async function stageAndCommit({ collabUrl, slug, userId, message }) {
    await httpJson('POST', `${collabUrl}/git/${slug}/stage-all`,  {},                { 'x-user-id': userId });
    await httpJson('POST', `${collabUrl}/git/${slug}/commit`,     { message },       { 'x-user-id': userId });
}

function tcpPing(host, port, timeoutMs = 2000) {
    return new Promise((resolve) => {
        const s = net.createConnection({ host, port });
        const t = setTimeout(() => { s.destroy(); resolve(false); }, timeoutMs);
        s.once('connect', () => { clearTimeout(t); s.end(); resolve(true); });
        s.once('error',   () => { clearTimeout(t); resolve(false); });
    });
}

function parseUrl(u) {
    const url = new URL(u);
    const port = url.port
        ? Number(url.port)
        : (url.protocol === 'https:' || url.protocol === 'wss:' ? 443 : 80);
    return { host: url.hostname, port };
}

function openBrowser(url) {
    const plat = process.platform;
    if (plat === 'win32')   return exec(`start chrome "${url}"`,                { windowsHide: true });
    if (plat === 'darwin')  return exec(`open -a "Google Chrome" "${url}"`);
    return exec(`xdg-open "${url}"`);
}

// ───────────────────────── main flow ─────────────────────────

async function main() {
    console.log(color.blue + '\n━━━ Synthi tokenizer fixture seeder ━━━' + color.reset);
    console.log(`  slug         ${CFG.slug}`);
    console.log(`  workspace    ${CFG.workspaceName}`);
    console.log(`  fixture dir  ${CFG.fixtureDir}`);
    console.log(`  fixtures     ${FIXTURES.map((f) => f.dest).join(', ')}`);
    console.log('');

    if (!existsSync(CFG.fixtureDir)) fail(`Fixture dir not found: ${CFG.fixtureDir}`);

    // 1. Preflight — frontend + collab reachable.
    log('info', 'Preflight: frontend + collab reachable?');
    const fe  = parseUrl(CFG.frontendUrl);
    const col = parseUrl(CFG.collabUrl);
    const [feOk, colOk] = await Promise.all([
        tcpPing(fe.host, fe.port), tcpPing(col.host, col.port),
    ]);
    if (!feOk)  fail(`frontend unreachable at ${CFG.frontendUrl}`);
    if (!colOk) fail(`collab-server unreachable at ${CFG.collabUrl}`);
    log('ok', `frontend:${fe.port} + collab:${col.port} both up`);

    // 2. Read every fixture from disk.
    log('info', `Reading ${FIXTURES.length} fixtures from ${CFG.fixtureDir}`);
    const files = await Promise.all(FIXTURES.map(async (f) => {
        const fullPath = path.join(CFG.fixtureDir, f.src);
        if (!existsSync(fullPath)) fail(`Missing fixture: ${fullPath}`);
        const content = await readFile(fullPath, 'utf8');
        return { lang: f.lang, path: f.dest, content };
    }));
    for (const f of files) {
        log('ok', `  ${f.lang.padEnd(10)} → ${f.path}  (${f.content.length} bytes)`);
    }

    // 3. Create workspace.
    log('info', `POST /api/workspace  {name, slug:"${CFG.slug}"}`);
    let workspace;
    try {
        workspace = await createWorkspace({
            frontendUrl: CFG.frontendUrl,
            name:        CFG.workspaceName,
            slug:        CFG.slug,
        });
    } catch (e) {
        fail(`workspace create failed: ${e.message}`, e);
    }
    log('ok', `workspace id=${workspace.id}  slug=${workspace.slug}`);

    // 4. Seed all fixtures in a single batch.
    log('info', `POST /git/${CFG.slug}/write-files-batch  (${files.length} files, syncToGcs:${CFG.syncToGcs})`);
    const r = await writeFilesBatch({
        collabUrl: CFG.collabUrl,
        slug:      CFG.slug,
        userId:    CFG.hostId,
        files,
        syncToGcs: CFG.syncToGcs,
    });
    if (r.hardErrs.length) fail(`write-files-batch hard errors: ${JSON.stringify(r.hardErrs)}`);
    if (r.gcsErrs.length)  log('warn', `gcs upload errors (non-fatal): ${JSON.stringify(r.gcsErrs)}`);
    log('ok', `wrote ${r.written} file(s), skipped ${r.skipped}`);

    // 5. Stage + commit.
    log('info', 'stage-all + commit');
    await stageAndCommit({
        collabUrl: CFG.collabUrl,
        slug:      CFG.slug,
        userId:    CFG.hostId,
        message:   'tokenizer-test: seed fixtures for cpp/java/rust/js/ts/html/css',
    });
    log('ok', 'fixtures committed to workspace git');

    // 6. Print the workspace URL — humans can now open it and eyeball the
    //    syntax-highlighting for each file.
    const workspaceUrl = `${CFG.frontendUrl}/workspace/${CFG.slug}`;
    console.log('');
    console.log(color.green + '━━━ Done. Open the workspace and inspect the highlighting ━━━' + color.reset);
    console.log(`  ${workspaceUrl}`);
    console.log('');
    console.log('  Files to open in the IDE:');
    for (const f of files) console.log(`    ${f.path}`);
    console.log('');

    if (CFG.autoOpen) {
        log('info', `Auto-open enabled — launching default browser → ${workspaceUrl}`);
        try { openBrowser(workspaceUrl); } catch (e) { log('warn', `openBrowser failed: ${e.message}`); }
    }
}

main().catch((e) => {
    log('fail', `tokenizer-test crashed: ${e.message}`);
    process.exitCode = 1;
});
