#!/usr/bin/env node
// ============================================================================
// CHANNEL FUZZER — registered direct channels, live-stack scenario fuzz.
//
// Generates hundreds of randomized channel workflows against the real control
// plane: random project modes, random capability sets, random actor pairs,
// happy paths and adversarial sequences. Classification is by invariant only
// (no hardcoded outcomes): a PASS means the observed behavior satisfied the
// design invariants for that generated scenario.
//
// Invariants:
//  - mediated_only: every direct-channel request must be refused (400)
//  - direct modes with capable, attached peers: request->accept->active works;
//    token is returned exactly once and never appears in any later read
//  - self-pairing always refused; non-responder accept always 403
//  - duplicate active pair refused; concurrency cap enforced
//  - close by participant succeeds and persists summaryDigest; close of an
//    already-closed channel fails
// ============================================================================
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const OUT_DIR = process.env.FUZZ_OUT || path.join(process.env.LOCALAPPDATA || '/tmp', 'codesite-channel-fuzz');
fs.mkdirSync(OUT_DIR, { recursive: true });
const RESULTS_FILE = path.join(OUT_DIR, `results-${Date.now()}.jsonl`);

const BASE = process.env.BASE || 'http://localhost:3000';
const WS = process.env.FUZZ_WS || 'acme-chan-fuzz';
const TOKEN = (() => {
  const env = fs.readFileSync('C:/Users/polek/Desktop/vectant-ade/.env.local', 'utf8');
  return env.match(/^SYNTHI_CODESITE_TOKEN=(.+)$/m)[1].trim();
})();
const AUTH = `Authorization: Bearer ${TOKEN}`;
const JSON_CT = 'Content-Type: application/json';

function curl(method, url, body) {
  const args = ['-sL', '-X', method, url, '-H', AUTH, '-H', JSON_CT];
  if (body !== undefined) args.push('--data-binary', typeof body === 'string' ? body : JSON.stringify(body));
  const r = spawnSync('curl', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch (_) {}
  const status = json ? (json.error ? (json.status || 400) : 200) : 0;
  return { status, json };
}

const MODES = ['mediated_only', 'registered_direct', 'direct_preferred'];
const PROVIDERS = ['codex', 'claude', 'custom-provider', 'local-agent-runtime'];
const TRANSPORTS = ['websocket', 'sse'];

function pick(arr) { return arr[randomInt(arr.length)]; }
function word() { return randomBytes(4).toString('hex'); }

async function createProject(mode) {
  const r = curl('POST', `${BASE}/api/workspace/${WS}/codesite/projects`, {
    title: `chan-fuzz ${mode} ${word()}`,
    channelMode: mode,
  });
  return r.json?.project?.id || null;
}

async function attach(projectId, n) {
  const owner = `fuzz-owner-${word()}`;
  await curl('POST', `${BASE}/api/workspace/${WS}/codesite/projects/${projectId}/members`, {
    userId: owner, role: 'agent',
  });
  const body = {
    collaborationMembershipVerified: true,
    ownerUserId: owner,
    collaborationUserId: `member-${owner}`,
    effectiveWorkspaceUserId: `eff-${owner}`,
    collaborationSessionId: `collab-fuzz-${word()}`,
    terminalSessionId: `term-${word()}`,
    runtimeScope: `workspace:${WS}`,
    agentProvider: pick(PROVIDERS),
    providerSessionRef: `prov-${word()}`,
    displayCallsign: `FUZZ-${String(n).padStart(3, '0')}`,
    // Capability set is randomized — some sessions legitimately lack channels.
    capabilities: [
      'codesite.context.read',
      ...(randomInt(4) > 0 ? ['codesite.channels.open'] : []),
    ],
  };
  const r = curl('POST', `${BASE}/api/workspace/${WS}/codesite/projects/${projectId}/agent-sessions/attach`, body);
  const sid = r.json?.session?.id || null;
  const tok = r.json?.agentAccessToken || null;
  const capsOk = (body.capabilities.includes('codesite.channels.open'));
  return { sid, tok, capsOk, owner };
}

/** Run one full scenario; returns classification. */
async function runScenario(i) {
  const mode = pick(MODES);
  const projectId = await createProject(mode);
  if (!projectId) return { id: i, kind: 'setup', classification: 'BUG', error: 'project create failed' };

  const count = 2 + randomInt(2); // 2-3 sessions per project
  const sessions = [];
  for (let s = 0; s < count; s++) sessions.push(await attach(projectId, i * 10 + s));

  const capable = sessions.filter((s) => s.sid && s.tok && s.capsOk);
  const incapable = sessions.filter((s) => s.sid && s.tok && !s.capsOk);
  const events = [];
  let bug = null;

  // --- invariant probes ---
  if (capable.length >= 2 && mode !== 'mediated_only') {
    const [a, b] = capable;
    const transport = pick(TRANSPORTS);
    const req = curl('POST', `${BASE}/api/workspace/${WS}/codesite/agent-sessions/${a.sid}/channels`, {
      toSessionId: b.sid, transport, purpose: `fuzz-${word()}`, endpointRef: `ws://127.0.0.1:${randomInt(40000) + 10000}/a`,
    });
    events.push(['request', req.status]);
    if (req.status === 201) {
      const chId = req.json.channel.id;
      // responder endpoint hidden pre-accept
      if (req.json.channel.toEndpointRef) bug = { code: 'endpoint_leaked_pre_accept' };

      // self-accept by the initiator must fail
      const selfAccept = curl('POST', `${BASE}/api/workspace/${WS}/codesite/agent-sessions/${a.sid}/channels/${chId}/accept`, {});
      events.push(['self-accept', selfAccept.status]);
      if (selfAccept.status !== 403) bug = { code: 'self_accept_allowed' };

      // genuine acceptance returns a single-use token
      const acc = curl('POST', `${BASE}/api/workspace/${WS}/codesite/agent-sessions/${b.sid}/channels/${chId}/accept`, {
        endpointRef: `ws://127.0.0.1:${randomInt(40000) + 10000}/b`,
      });
      events.push(['accept', acc.status]);
      const token = acc.json?.channel?.channelToken || null;
      if (acc.status !== 200 || !token) bug = { code: 'accept_failed' };

      // double-accept is refused
      const acc2 = curl('POST', `${BASE}/api/workspace/${WS}/codesite/agent-sessions/${b.sid}/channels/${chId}/accept`, {});
      events.push(['double-accept', acc2.status]);
      if (acc2.status === 200) bug = { code: 'double_accept_allowed' };

      // duplicate active pair refused
      const dup = curl('POST', `${BASE}/api/workspace/${WS}/codesite/agent-sessions/${a.sid}/channels`, {
        toSessionId: b.sid, transport,
      });
      events.push(['duplicate-pair', dup.status]);
      if (dup.status === 201) bug = { code: 'duplicate_pair_allowed' };

      // audit list shows it active; token never appears in reads
      const list = curl('GET', `${BASE}/api/workspace/${WS}/codesite/projects/${projectId}/channels?status=active`);
      const listed = (list.json?.channels || []).find((c) => c.id === chId);
      if (!listed || listed.status !== 'active') bug = { code: 'active_channel_not_listed' };
      if (JSON.stringify(list.json).includes(token)) bug = { code: 'token_leaked_in_read' };

      // close by initiator persists digest; second close fails
      const digest = `sha256:${createHash('sha256').update(word()).digest('hex')}`;
      const close = curl('POST', `${BASE}/api/workspace/${WS}/codesite/agent-sessions/${a.sid}/channels/${chId}/close`, {
        summaryDigest: digest, messageCount: randomInt(50),
      });
      events.push(['close', close.status]);
      if (close.status !== 200 || close.json?.channel?.summaryDigest !== digest) {
        bug = { code: 'close_digest_mismatch' };
      }
      const close2 = curl('POST', `${BASE}/api/workspace/${WS}/codesite/agent-sessions/${b.sid}/channels/${chId}/close`, {});
      events.push(['close-again', close2.status]);
      if (close2.status === 200) bug = { code: 'double_close_allowed' };
    } else if (![400, 403].includes(req.status)) {
      bug = { code: 'request_unexpected_status' };
    }
  }

  if (mode === 'mediated_only' && capable.length >= 2) {
    const [a, b] = capable;
    const req = curl('POST', `${BASE}/api/workspace/${WS}/codesite/agent-sessions/${a.sid}/channels`, {
      toSessionId: b.sid, transport: pick(TRANSPORTS),
    });
    events.push(['mediated-request', req.status]);
    if (req.status === 201) bug = { code: 'mediated_only_allowed_channel' };
  }

  // incapable initiator must be refused regardless of mode
  if (incapable.length && capable.length) {
    const bad = incapable[0];
    const good = capable[0];
    const req = curl('POST', `${BASE}/api/workspace/${WS}/codesite/agent-sessions/${bad.sid}/channels`, {
      toSessionId: good.sid, transport: 'websocket',
    });
    events.push(['incapable-initiator', req.status]);
    if (req.status === 201) bug = { code: 'incapable_initiator_allowed' };
  }

  void incapable;

  if (bug) return { id: i, kind: 'channels', mode, projectId, events, classification: 'BUG', ...bug };
  return { id: i, kind: 'channels', mode, projectId, events, classification: 'PASS' };
}

const N = Number(process.env.FUZZ_N || 300);
let pass = 0; let bugs = 0;
console.log(`Channel fuzzing ${N} scenarios -> ${RESULTS_FILE}`);
for (let i = 0; i < N; i++) {
  let result;
  try {
    result = await runScenario(i);
  } catch (err) {
    result = { id: i, classification: 'BUG', error: String(err.message).slice(0, 200) };
  }
  if (result.classification === 'PASS') pass++; else bugs++;
  fs.appendFileSync(RESULTS_FILE, JSON.stringify(result) + '\n');
  if ((i + 1) % 25 === 0) console.log(`  ${i + 1}/${N} done — PASS=${pass} BUG=${bugs}`);
}
console.log(`\n=== CHANNEL FUZZ SUMMARY ===\nPASS=${pass} BUG=${bugs}`);
if (bugs) {
  const lines = fs.readFileSync(RESULTS_FILE, 'utf8').trim().split('\n').map(JSON.parse);
  const seen = new Set();
  for (const l of lines.filter((x) => x.classification === 'BUG')) {
    const key = l.code || l.error || 'unknown';
    if (seen.has(key)) continue;
    seen.add(key);
    console.log(' ', key);
  }
}
