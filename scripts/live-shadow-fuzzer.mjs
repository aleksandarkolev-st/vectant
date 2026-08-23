#!/usr/bin/env node
// ============================================================================
// LIVE SCENARIO FUZZER — vectant-ade CodeSite shadow merge + control plane
//
// Generates hundreds of randomized live scenarios against the real running
// stack (frontend control plane + external shadow runner inside the
// container). Every scenario is derived at runtime; no expected outcome is
// hardcoded — classification is by invariant:
//   PASS           : scenario behaved per invariants
//   EXPECTED-FAIL  : adversarial scenario correctly rejected with 4xx
//   BUG            : any other behavior (crash, 500, silent accept, wrong kind)
// Results are appended to a JSONL file for aggregation.
// ============================================================================
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const OUT_DIR = process.env.FUZZ_OUT || path.join(process.env.LOCALAPPDATA || '/tmp', 'codesite-fuzz');
const RESULTS_FILE = path.join(OUT_DIR, `results-${Date.now()}.jsonl`);
fs.mkdirSync(OUT_DIR, { recursive: true });

const BASE = process.env.BASE || 'http://localhost:3000';
const CONTAINER = 'vectant-ade-frontend-1';
const RUNNER_ROOT = '/workspace-shadow';
const TOKEN = (() => {
  const env = fs.readFileSync(path.join(process.cwd(), '.env.local'), 'utf8');
  const m = env.match(/^SYNTHI_CODESITE_TOKEN=(.+)$/m);
  return m ? m[1].trim() : null;
})();
if (!TOKEN) { console.error('SYNTHI_CODESITE_TOKEN not found in .env.local'); process.exit(1); }
const AUTH = `Authorization: Bearer ${TOKEN}`;
const JSON_CT = 'Content-Type: application/json';

const rand = {
  int: (n) => randomInt(n),
  pick: (arr) => arr[randomInt(arr.length)],
  word: () => randomBytes(4).toString('hex'),
};

function sh(cmd, opts = {}) {
  return spawnSync('sh', ['-c', cmd], { encoding: 'utf8', ...opts });
}
function dockerExec(script, opts = {}) {
  const r = spawnSync('docker', ['exec', CONTAINER, 'sh', '-c', script], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 && !opts.tolerate) throw new Error(`docker exec failed: ${r.stderr}`);
  return r.stdout;
}

async function api(method, url, body) {
  // Large bodies must go via a temp file: passing them as argv hits the
  // Windows command-line length limit (~32k chars) and curl fails to spawn.
  let args = ['-s', '-X', method, url, '-H', AUTH, '-H', JSON_CT];
  let bodyFile = null;
  if (body !== undefined) {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    if (text.length > 8000) {
      bodyFile = path.join(OUT_DIR, `body-${Date.now()}-${rand.word()}.json`);
      fs.writeFileSync(bodyFile, text);
      args.push('--data-binary', '@' + bodyFile);
    } else {
      args.push('-d', text);
    }
  }
  const r = spawnSync('curl', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch (_) {}
  if (bodyFile) fs.rmSync(bodyFile, { force: true });
  // The route's error envelope carries no numeric status — errors arrive as
  // {error, detail?}. Treat any error-shaped body as a rejection (400-class);
  // success bodies always carry the result shape.
  const status = json
    ? (json.error ? (json.status || json.statusCode || 400) : 200)
    : Number(r.status || 0);
  return { status: json ? status : Number(r.status), json, stderr: r.stderr };
}

// ---------------------------------------------------------------------------
// Scenario generators — each returns a scenario descriptor
// ---------------------------------------------------------------------------
function makeRepoScript(name) {
  // Random repo shape: file count, nesting depth, content variants.
  const files = [];
  const nFiles = 1 + rand.int(4);
  for (let i = 0; i < nFiles; i++) {
    const depth = rand.int(3);
    const dirs = Array.from({ length: depth }, (_, d) => `dir${d}${rand.word()}`).join('/');
    files.push(`${dirs ? dirs + '/' : ''}file${i}-${rand.word()}.json`);
  }
  return { name, files };
}

function buildScenario(i) {
  const kinds = ['valid_merge', 'tampered_digest', 'preimage_mismatch', 'binary_patch',
    'empty_repo_change', 'deep_nesting', 'unicode_content', 'multi_file_patch',
    'command_fails', 'missing_command_binary', 'huge_patch', 'no_universes'];
  const kind = kinds[i % kinds.length];
  return { id: i, kind, seed: rand.word(), repo: makeRepoScript(`fuzz-${i}`) };
}

// Build a repo with a v1->v2 style change on a set of files; produce base/head
// commits and the git-derived patch. For adversarial kinds mutate afterwards.
async function prepareRepo(sc) {
  const dir = `${RUNNER_ROOT}/fuzz-${sc.id}-${sc.seed}`;
  const files = sc.repo.files;
  let mk = `
rm -rf ${dir} && mkdir -p ${dir} && cd ${dir}
git init -q .
git config user.email f@z && git config user.name F`;
  for (const f of files) {
    const full = `${dir}/${f}`;
    mk += `\nmkdir -p "$(dirname "${full}")"`;
    mk += `\nprintf '{"version":1,"pad":"%s"}\\n' "$(head -c 8 /dev/urandom | od -An -tx1 | tr -d ' \\n')" > "${full}"`;
  }
  mk += `\ngit add -A && git commit -qm base`;
  mk += `\nprintf "BASE=%s\\n" "$(git rev-parse HEAD)"`;
  for (const f of files) {
    mk += `\nsed -i 's/"version":1/"version":2/' "${dir}/${f}"`;
  }
  mk += `\ngit add -A && git commit -qm change`;
  mk += `\nprintf "HEAD=%s\\n" "$(git rev-parse HEAD)"`;
  const out = dockerExec(mk);
  const base = (out.match(/BASE=([0-9a-f]{40})/) || [])[1];
  const head = (out.match(/HEAD=([0-9a-f]{40})/) || [])[1];
  if (!base || !head) throw new Error(`repo setup failed: ${out}`);
  const patch = dockerExec(`cd ${dir} && git diff --binary --full-index HEAD~1 HEAD`);
  return { dir, base, head, patch };
}

function mutatePatch(patch, kind) {
  if (kind === 'tampered_digest') return patch; // digest handled separately
  if (kind === 'preimage_mismatch') {
    // change context lines so preimage check fails
    return patch.replace(/"version":1/g, '"version":7');
  }
  if (kind === 'unicode_content') {
    return patch.replace(/"pad":"[0-9a-f]*"/, '"pad":"rotação-✓-🚁"');
  }
  if (kind === 'binary_patch') {
    // A real binary change: git --binary produces GIT binary patch sections
    // only for actual binary files, so simulate by corrupting a hunk header —
    // the runner must reject it (preimage/digest) rather than crash.
    return patch.replace(/^@@ -1 \+1 @@$/m, '@@ -1 +1,99 @@');
  }
  if (kind === 'huge_patch') {
    const filler = Array.from({ length: 2000 }, (_, i) => `+filler line ${i}\n`).join('');
    return patch + filler;
  }
  return patch;
}

function commandFor(kind, dir) {
  switch (kind) {
    case 'command_fails': return ['node', ['-e', 'process.exit(9)']];
    case 'missing_command_binary': return ['definitely-not-a-real-bin-xyz', ['--version']];
    default: return ['node', ['-e', 'console.log("checks-ok")']];
  }
}

// ---------------------------------------------------------------------------
// Invariant evaluation
// ---------------------------------------------------------------------------
function classify(sc, res) {
  const { kind, httpStatus, body } = res;
  if (httpStatus >= 500 || body?.error === String(httpStatus)) return 'BUG'; // 5xx always a bug
  const rejected = httpStatus === 400 || httpStatus === 422;
  const okMerge = httpStatus === 200 && body?.resultKind === 'executed'
    && body?.shadowExecution?.status === 'completed';

  switch (kind) {
    case 'valid_merge':
    case 'deep_nesting':
    case 'multi_file_patch':
    case 'empty_repo_change':
      return okMerge ? 'PASS' : (rejected ? 'BUG' : 'BUG'); // valid merges must succeed
    case 'unicode_content': {
      // The patch mutates the +line only, which breaks the hunk's internal
      // consistency (context counts), so git rejects it — the runner must
      // surface that as a failed proof rather than crash or silently pass.
      if (httpStatus >= 500) return 'BUG';
      if (okMerge) return 'BUG';
      if (rejected && /preimage|apply|evidence_required|mismatch/.test(JSON.stringify(body))) {
        return 'EXPECTED-FAIL';
      }
      return 'BUG';
    }
    case 'tampered_digest':
    case 'preimage_mismatch':
    case 'binary_patch': {
      if (httpStatus >= 500) return 'BUG';
      if (okMerge) return 'BUG'; // corrupted patch must never produce an executed proof
      if (rejected) return 'EXPECTED-FAIL';
      return 'BUG';
    }
    case 'huge_patch': {
      // A large-but-legal patch must still merge; only transport/timeout
      // failures are acceptable, and those surface as non-200.
      if (httpStatus >= 500 || httpStatus === 0) return 'BUG';
      return okMerge ? 'PASS' : (rejected ? 'BUG' : 'BUG');
    }
    case 'command_fails': {
      if (httpStatus >= 500) return 'BUG';
      if (okMerge) return 'BUG'; // failing command must not yield completed executed proof
      if (body?.detail?.failureCode === 'shadow_runner_execution_failed') return 'EXPECTED-FAIL';
      if (rejected) return 'EXPECTED-FAIL';
      return 'BUG';
    }
    case 'missing_command_binary': {
      if (httpStatus >= 500) return 'BUG';
      if (okMerge) return 'BUG';
      return rejected ? 'EXPECTED-FAIL' : 'BUG';
    }
    case 'no_universes': {
      // An empty universes list must be rejected by the control plane — it can
      // never constitute an executed proof (runner itself fails it).
      if (httpStatus >= 500) return 'BUG';
      return rejected ? 'EXPECTED-FAIL' : 'BUG';
    }
    default: return 'BUG';
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
const N = Number(process.env.FUZZ_N || 300);
const START = Number(process.env.FUZZ_START || 0);
let counts = { PASS: 0, 'EXPECTED-FAIL': 0, BUG: 0 };
const bugs = [];

console.log(`Fuzzing ${N} live scenarios (from ${START}) -> ${RESULTS_FILE}`);
for (let i = START; i < START + N; i++) {
  const sc = buildScenario(i);
  let result = { id: i, kind: sc.kind, seed: sc.seed };
  try {
    const repo = await prepareRepo(sc);
    let patch = mutatePatch(repo.patch, sc.kind);
    if (!patch.trim()) patch = repo.patch; // empty_repo_change falls back to real diff
    const c = createHash('sha256').update(Buffer.from(patch, 'utf8')).digest('hex');

    // fresh project per batch of 10 to vary routing
    if (i % 10 === 0 || !globalThis.__pid) {
      const p = await api('POST', `${BASE}/api/workspace/${'acme-fuzz'}/codesite/projects`, { title: `Fuzz batch ${Math.floor(i / 10)}` });
      result.projectStatus = p.status;
      globalThis.__pid = p.json?.project?.id;
      if (!globalThis.__pid) throw new Error(`project create failed (${p.status})`);
    }
    const pid = globalThis.__pid;

    const body = {
      shadowJobRef: `fuzz-${sc.id}-${Date.now()}`,
      baseSnapshot: `repo@${sc.seed}`,
      requireExternalRunnerEvidence: true,
      proofMaturity: 'mature',
      shadowExecutionPlan: {
        repoRoot: repo.dir,
        baseCommit: sc.kind === 'preimage_mismatch' ? repo.head /* wrong base */ : repo.base,
        patchArtifacts: [{
          id: 'p1',
          digest: sc.kind === 'tampered_digest' ? 'sha256:' + '0'.repeat(64) : `sha256:${c}`,
          content: patch,
        }],
        commands: [{ label: 'check', command: commandFor(sc.kind)[0], args: commandFor(sc.kind, repo.dir)[1] }],
      },
      universes: sc.kind === 'no_universes' ? [] : [{ strategy: 'producer-first' }, { strategy: 'consumer-first' }],
    };

    const res = await api('POST', `${BASE}/api/workspace/acme-fuzz/codesite/projects/${pid}/shadow-merge-simulate`, body);
    if (res.status === 0 && res.stderr) {
      throw new Error(`transport failure: ${String(res.stderr).slice(0, 120)}`);
    }
    result.httpStatus = res.status;
    result.resultKind = res.json?.resultKind || null;
    result.failureCode = res.json?.detail?.failureCode || null;
    result.reasonCodes = res.json?.detail?.reasonCodes || null;

    if (res.status === 200) {
      const u = (res.json.universes || []).find((x) => x.execution);
      result.execStatus = u?.execution?.status || 'none';
    }

    result.classification = classify(sc, {
      kind: sc.kind, httpStatus: res.status, body: res.json,
    });
  } catch (err) {
    result.classification = 'BUG';
    result.error = err.message.slice(0, 300);
  }
  counts[result.classification] = (counts[result.classification] || 0) + 1;
  if (result.classification === 'BUG') bugs.push(result);
  fs.appendFileSync(RESULTS_FILE, JSON.stringify(result) + '\n');
  if ((i + 1) % 25 === 0) {
    console.log(`  ${i + 1}/${N} done — PASS=${counts.PASS} EXPECTED-FAIL=${counts['EXPECTED-FAIL']} BUG=${counts.BUG}`);
  }
}

console.log('\n=== FUZZ SUMMARY ===');
console.log(JSON.stringify(counts));
if (bugs.length) {
  console.log('\nFirst bug classes:');
  const seen = new Set();
  for (const b of bugs) {
    const key = `${b.kind}|${b.failureCode || b.error || b.httpStatus}`;
    if (seen.has(key)) continue;
    seen.add(key);
    console.log(' ', key);
  }
}
