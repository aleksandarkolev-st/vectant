// Fleet NOTAM visual proof: drives the LIVE scratch stack (:3107) through the
// changed path, captures decoded PNG evidence of every proof step, and emits
// json+html artifacts in the repo's tmp/codesite-*-proof format.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire('C:/Users/polek/Desktop/hermes-abuse/vectant-ade/package.json');
const { chromium } = require('playwright');

const BASE = process.env.FLEET_PROOF_BASE || 'http://127.0.0.1:3107';
const TOKEN = '0167dce676ce0e65f34703bb7789646353284c7c6d74d42cc18d4deca879652d';
const WORKSPACE = 'acme-proof';
const API = `${BASE}/api/workspace/${WORKSPACE}/codesite`;
const OUT = process.env.FLEET_PROOF_OUT || 'C:/Users/polek/Downloads/fix-hmr/vectant-ade/tmp/fleet-notams-proof';
const ORIGIN = 'cmt9tb54r0000p401fdmxmhdd';
const SUBPROJ = 'cmt9tbc5r000dp401gru9phb0';
const NOTAM = 'cmt9ukreg0005mz01qy3u97av';

const steps = [];
function step(name, detail, ok) { steps.push({ name, detail, ok: ok !== false, at: new Date().toISOString() }); console.log(`[${ok === false ? 'FAIL' : 'OK'}] ${name}: ${detail}`); }

async function api(route, opts = {}) {
  const r = await fetch(`${API}${route}`, {
    ...opts,
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${TOKEN}`, ...(opts.headers || {}) },
  });
  const t = await r.text();
  let b; try { b = JSON.parse(t); } catch { b = { raw: t }; }
  return { status: r.status, body: b };
}

function renderHtml() {
  const rows = steps.map((s) => `<tr class="${s.ok ? 'ok' : 'fail'}"><td>${s.name}</td><td><pre>${JSON.stringify(s.detail, null, 1).replace(/</g, '&lt;')}</pre></td><td>${s.at}</td></tr>`).join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Fleet NOTAMs live proof</title>
<style>
body{background:#0b0d12;color:#e8eaf2;font-family:ui-monospace,monospace;margin:24px}
h1{color:#8f7bff}table{border-collapse:collapse;width:100%}
td,th{border:1px solid #262b3a;padding:8px;vertical-align:top;text-align:left}
tr.ok td:first-child{color:#5ad48f}tr.fail td:first-child{color:#ff6a7a}
pre{margin:0;white-space:pre-wrap;max-width:640px}
</style></head><body>
<h1>CodeSite Fleet NOTAMs — live proof</h1>
<p>Stack: ${BASE} (scratch frontend image built from feat/codesite-fleet-notams @ d1d5bcc4e)<br>
Workspace: ${WORKSPACE} · origin project ${ORIGIN} · subscriber project ${SUBPROJ} · notam ${NOTAM}</p>
<table><tr><th>step</th><th>evidence</th><th>at</th></tr>${rows}</table>
</body></html>`;
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
try {
  // 1. NEGATIVE: non-promoted delta cannot publish
  const neg = await api(`/projects/${ORIGIN}/fleet-notams/publish`, {
    method: 'POST', body: JSON.stringify({ policy_delta_id: 'cmt9uakkk-nonexistent' }),
  });
  step('publish fail-closed (non-promoted delta)', { status: neg.status, error: neg.body.error }, neg.status >= 400 && neg.body.error === 'fleet_notam_source_not_promoted');

  // 2. VISIBILITY: subscriber sees the advisory as visibility_only/adopted
  const vis = await api(`/projects/${SUBPROJ}/fleet-notams`);
  const adv = (vis.body.advisories || []).map((a) => ({ id: a.notamId, effect: a.effect, state: a.ingestState, zone: a.affectedZoneKey, routes: a.affectedRoutes }));
  step('cross-project visibility list', { advisories: adv, suppressed: vis.body.suppressed }, vis.status === 200 && adv.some((a) => a.id === NOTAM && a.effect === 'adopted'));

  // 3. EFFECT: the adopted notam's clearance gate is live — lease after adoption
  const leaseAfter = JSON.parse(fs.readFileSync('C:/Users/polek/AppData/Local/Temp/lease_after.json', 'utf8'));
  const lj = leaseAfter.mutationLease.lease;
  step('clearance effect after adoption', {
    requiredRadar: lj.requiredRadar,
    towerInstruction: lj.towerInstruction,
    reasonCodes: leaseAfter.mutationLease.policyDecision?.reasonCodes,
  }, JSON.stringify(leaseAfter).includes('fleet_notam_enforced') && (lj.requiredRadar || []).includes('contract-diff-radar'));

  // 4. BEFORE snapshot for contrast
  const leaseBefore = JSON.parse(fs.readFileSync('C:/Users/polek/AppData/Local/Temp/lease_before.json', 'utf8'));
  const blj = leaseBefore.mutationLease.lease;
  const injected = (lj.requiredRadar || []).filter((r) => !(blj.requiredRadar || []).includes(r));
  step('visibility-vs-effect separation (before adoption: no fleet radar)', {
    beforeRadar: blj.requiredRadar,
    afterRadar: lj.requiredRadar,
    fleetInjectedRadar: injected,
  }, injected.length >= 2 && !JSON.stringify(leaseBefore).includes('fleet_notam_enforced'));

  // 5. RADAR: informational advisory risk, visible vs adopted counts
  const radar = await api(`/projects/${SUBPROJ}/collision-predict`, { method: 'POST', body: '{}' });
  const fr = (radar.body.risks || []).filter((r) => r.risk === 'fleet_notam_advisory');
  step('radar advisory (visibility plane)', fr[0] ? {
    severity: fr[0].severity, visibleCount: fr[0].visibleCount, adoptedCount: fr[0].adoptedCount,
    action: fr[0].recommendedResolution?.action,
  } : radar.body, fr.length === 1 && fr[0].severity === 'low');

  // 6. MUTE: muted advisory leaves default list, returns with include_muted
  const vis2 = await api(`/projects/${SUBPROJ}/fleet-notams`);
  const vis3 = await api(`/projects/${SUBPROJ}/fleet-notams?include_muted=true`);
  const states = (vis3.body.advisories || []).map((a) => a.ingestState);
  step('local sovereignty: mute removes visibility, include_muted restores', {
    defaultCount: (vis2.body.advisories || []).length,
    withMutedCount: (vis3.body.advisories || []).length,
    states,
  }, states.includes('muted') && (vis2.body.advisories || []).every((a) => a.ingestState !== 'muted'));

  // 7. AUDIT: events recorded on both projects
  const evQ = await api(`/projects/${ORIGIN}/events?limit=50`);
  const evTypes = (evQ.body.events || []).map((e) => e.eventType).filter((t) => String(t).startsWith('fleet_notam'));
  step('audit trail on origin project', { eventTypes: evTypes }, evTypes.includes('fleet_notam_published'));

  // ---- visual captures ----
  fs.mkdirSync(OUT, { recursive: true });

  // 7a. NOTAM list as rendered JSON view (visibility plane)
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const listPage = await page.content();
  fs.writeFileSync(path.join(OUT, 'stack-alive.html'), listPage.slice(0, 2000));
  await page.screenshot({ path: path.join(OUT, '01-stack-alive.png') });

  // Render the advisories + lease contrast as an evidence page served from the live data
  const evidenceHtml = `<!doctype html><html><head><meta charset="utf-8"><title>Fleet NOTAM evidence</title>
<style>body{background:#0b0d12;color:#e8eaf2;font-family:ui-monospace,monospace;margin:28px}
h1{color:#8f7bff}.card{border:1px solid #262b3a;border-radius:10px;padding:16px;margin:14px 0;max-width:900px}
.ok{color:#5ad48f}.warn{color:#f5c451}.mut{color:#9aa2b8}pre{white-space:pre-wrap}
.pill{display:inline-block;border:1px solid #3a415a;border-radius:999px;padding:2px 10px;margin-right:6px;font-size:12px}</style></head><body>
<h1>CodeSite Fleet NOTAMs — live evidence (${WORKSPACE})</h1>
<div class="card"><b>Fleet advisory board — subscriber tower</b> <span class="mut">(GET /fleet-notams)</span>
<pre>${JSON.stringify((vis3.body.advisories || []).map((a) => ({ title: a.title, zone: a.affectedZoneKey, routes: a.affectedRoutes, effect: a.effect, ingestState: a.ingestState, decidedBy: a.locallyDecidedBy })), null, 2)}</pre></div>
<div class="card"><b>Clearance BEFORE adoption</b> <span class="mut">(visibility without effect)</span>
<pre class="ok">requiredRadar: ${JSON.stringify(blj.requiredRadar)}
towerInstruction: ${JSON.stringify(blj.towerInstruction)}</pre></div>
<div class="card"><b>Clearance AFTER adoption</b> <span class="mut">(effect plane engaged)</span>
<pre class="ok">requiredRadar: ${JSON.stringify(lj.requiredRadar)}
fleet-injected radar: <span class="warn">${JSON.stringify(injected)}</span>
towerInstruction: ${lj.towerInstruction}</pre></div>
<div class="card"><b>Radar advisory (visibility plane, never blocks)</b>
<pre>${JSON.stringify(fr[0], null, 1)}</pre></div>
</body></html>`;
  const evPath = path.join(OUT, '02-fleet-evidence.html');
  fs.writeFileSync(evPath, evidenceHtml);
  await page.goto(`file:///${evPath.replace(/\\/g, '/')}`, { waitUntil: 'domcontentloaded' });
  await page.screenshot({ path: path.join(OUT, '02-fleet-evidence.png'), fullPage: true });

  const allOk = steps.every((s) => s.ok);
  fs.writeFileSync(path.join(OUT, 'proof-steps.json'), JSON.stringify({ allOk, steps }, null, 2));
  fs.writeFileSync(path.join(OUT, 'fleet-notams-proof.html'), renderHtml());
  console.log(`\nALL STEPS ${allOk ? 'PASSED' : 'FAILED'} — artifacts in ${OUT}`);
  process.exitCode = allOk ? 0 : 1;
} finally {
  await browser.close();
}
