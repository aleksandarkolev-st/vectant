const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const baseURL = 'http://127.0.0.1:3000';
const slug = 'visual-workspace';
const outDir = __dirname;

const files = [
  { path: 'src/app/main.tsx', size: 2180, extension: 'tsx', language: 'typescript', lastModified: Date.now() - 140000 },
  { path: 'src/app/workspace.tsx', size: 3840, extension: 'tsx', language: 'typescript', lastModified: Date.now() - 110000 },
  { path: 'src/components/CommandDeck.tsx', size: 2860, extension: 'tsx', language: 'typescript', lastModified: Date.now() - 90000 },
  { path: 'src/components/RunGraph.tsx', size: 2140, extension: 'tsx', language: 'typescript', lastModified: Date.now() - 75000 },
  { path: 'src/lib/orchestration.ts', size: 1540, extension: 'ts', language: 'typescript', lastModified: Date.now() - 50000 },
  { path: 'vectant.programs.json', size: 560, extension: 'json', language: 'json', lastModified: Date.now() - 25000 },
  { path: 'README.md', size: 980, extension: 'md', language: 'markdown', lastModified: Date.now() - 10000 },
];

const contents = {
  'src/app/main.tsx': `import { CommandDeck } from '../components/CommandDeck';\nimport { RunGraph } from '../components/RunGraph';\n\nexport default function Workspace() {\n  return (\n    <main className="workspace">\n      <CommandDeck />\n      <RunGraph mode="live" />\n    </main>\n  );\n}\n`,
  'src/app/workspace.tsx': `export const workspace = {\n  name: 'Vectant Systems',\n  mode: 'orchestration',\n  trust: 'verified',\n};\n`,
  'src/components/CommandDeck.tsx': `export function CommandDeck() {\n  const tools = ['plan', 'patch', 'verify', 'ship'];\n  return tools.map((tool) => <button key={tool}>{tool}</button>);\n}\n`,
  'src/components/RunGraph.tsx': `export function RunGraph({ mode }: { mode: string }) {\n  return <section data-mode={mode}>agent run graph</section>;\n}\n`,
  'src/lib/orchestration.ts': `export function nextStep(state: string) {\n  if (state === 'blocked') return 'inspect';\n  return 'verify';\n}\n`,
  'vectant.programs.json': JSON.stringify({ programs: [{ packageId: '@vectant/postman', displayName: 'Postman', runtime: 'container' }] }, null, 2),
  'README.md': '# Vectant visual proof\n\nWorkspace used for Playwright validation.\n',
};

const workflowState = {
  runtime: { status: 'ready', label: 'Runtime attached', detail: 'Local preview is attached to this workspace.' },
  observe: { status: 'ready', lastScreenshotAt: new Date().toISOString() },
  teach: { state: 'idle', label: 'Ready' },
  workflow: {
    title: 'Guarded deploy workflow',
    detail: 'Captures deploy preparation, proof checks, and release handoff.',
    label: 'Contract compiled',
    stepCount: 4,
    contractStatus: 'compiled',
    scriptStatus: 'generated',
    unresolvedCount: 1,
  },
  steps: [
    { id: 'open', label: 'Open release panel', state: 'recorded', meta: 'Browser event captured' },
    { id: 'scope', label: 'Select guarded paths', state: 'guarded', meta: 'Path lock required' },
    { id: 'proof', label: 'Attach proof capsule', state: 'verified', meta: 'Evidence ref captured' },
    { id: 'publish', label: 'Queue deployment', state: 'limited', meta: 'CI replay must pass' },
  ],
  unresolvedSteps: [
    { id: 'mutationRequiresIsolation', label: 'Mutation replay boundary', detail: 'Confirm reset profile before unattended replay.' },
  ],
  blockers: [],
  history: [
    { id: 'run-1', label: 'Checkride replay', detail: '92% coverage', status: 'passed', tone: 'ok' },
    { id: 'run-2', label: 'Wind tunnel', detail: '2 blocked paths', status: 'review', tone: 'warn' },
  ],
  profile_manifest: {
    readiness: 'ciIsolatedReady',
    can_run_full_mutation_replay: true,
    reset_profile_id: 'release-reset-v3',
    state_seed_id: 'workspace-fixture-7',
    commands: {
      ci: 'npm run test:release',
      data_reset: 'npm run data:reset',
      postcondition: 'npm run assert:release',
    },
    missing: [],
  },
  mutation_plan: {
    has_mutation: true,
    ci_full_replay: { allowed: true, blockers: [] },
  },
  dojo: {
    status: 'licensed',
    published: true,
    skillId: 'dojo_guarded_deploy',
    label: 'Guarded deploy automation',
    entrustmentLevel: 'E3',
    readinessLevel: 7,
    proofRequired: true,
    publishedToolName: 'vectant_guarded_deploy',
    scenarioCount: 24,
    artifactCount: 9,
    attackSuccessRate: 0.03,
    checkride: { coverageScore: 0.92, criticalFailures: 0 },
    lifecycle: { status: 'active', daysUntilExpiry: 18, expiresAt: '2026-07-25T00:00:00.000Z' },
    sourceAffordancePrPlan: { readiness: 'ready_for_review', patchCount: 3 },
    windTunnel: { runCount: 32, passCount: 30, blockedCount: 2 },
    vivariumRun: { scenarioTitle: 'Duplicate deploy target', status: 'blocked' },
    timeMachine: { changedVariable: 'release_window_locked', expectedStatusAfterChange: 'blocked' },
    governance: { approvalCount: 2, policyGateCount: 5 },
    caseLawRecord: { title: 'Release Mutation Requires Proof', status: 'binding' },
    proof: { capsuleId: 'proofcap_release_7f1c' },
    proofDryRun: { status: 'passed' },
    guardrails: ['path_lock_required', 'proof_capsule_required', 'ci_replay_required'],
    skillCard: {
      title: 'Guarded deploy automation',
      status: 'Licensed E3',
      can_do_alone: ['prepare_release', 'run_ci_replay'],
      will_ask_before: ['commit_mutation', 'publish_release'],
      will_not_do: ['delete_workspace', 'bypass_policy'],
      practiced: '24 synthetic cases',
      found_and_fixed: '3 guardrails',
      proof_badge: 'Proof required',
    },
    license: {
      allowedActions: ['prepare_release', 'run_ci_replay'],
      gatedActions: ['publish_release'],
      blockedActions: ['delete_workspace', 'bypass_policy'],
    },
  },
};

const codeSiteProjectId = 'codesite-run-1';
const codeSiteProject = {
  id: codeSiteProjectId,
  title: 'Run graph hardening',
  request: 'Coordinate workflow, Codesite, and Dojo changes with path locks and release evidence.',
  status: 'active',
  zonePolicy: {
    zones: [{ id: 'ui', pattern: 'synthi/src/components/**', owner: 'frontend' }],
    noFlyZones: ['synthi/prisma/**'],
  },
  documents: [
    { id: 'doc-1', title: 'Protected UI mutation approval', status: 'pending_review', documentType: 'change_order', evidenceRefs: ['evidence:doc:1'] },
  ],
  permits: [
    { id: 'permit-1', title: 'UI path lock approval', status: 'active', allowedPaths: ['synthi/src/components/**'] },
  ],
  routeRevisions: [
    { id: 'route-1', status: 'pending_review', reason: 'Move workflow rail into guarded panel', route: ['synthi/src/components/agent-workflows/**'] },
  ],
  mutationTxns: [
    { id: 'txn-1', status: 'open', mutationLeaseId: 'lease-1', changedPaths: ['synthi/src/components/agent-workflows/AgentWorkflowPanel.jsx'] },
  ],
  proofBundles: [
    { id: 'proof-1', status: 'verified', evidenceRefs: ['playwright:workflow-console', 'build:next'] },
  ],
  inspectionRuns: [
    { id: 'inspect-1', displayCallsign: 'AGENT-WF', status: 'passed', changedPaths: ['synthi/src/components/dojo/**'], evidenceRefs: ['build:next'] },
  ],
  incidents: [],
  assumptions: [
    { id: 'assume-1', title: 'Desktop operators need section jumps', status: 'validated' },
  ],
  counterfactualRuns: [
    {
      id: 'sim-1',
      result: {
        selected: 'serial_replay',
        status: 'passed',
        universes: [
          { strategy: 'serial_replay', result: 'passed', predictedCollisionRisk: 0.08, confidence: 0.91, inspectionCost: 2, sourceSignals: { locks: ['lease-1'], proof: ['proof-1'] } },
          { strategy: 'parallel_fast_path', result: 'warning', predictedCollisionRisk: 0.34, confidence: 0.74, inspectionCost: 1, sourceSignals: { locks: ['lease-1'] } },
        ],
      },
    },
  ],
  events: [
    { id: 'evt-1', eventType: 'tower_instruction', createdAt: new Date().toISOString(), actorType: 'system', displayCallsign: 'Coordinator', details: { message: 'Path lock issued', transactionId: 'txn-1' } },
  ],
};

const codeSiteControlState = {
  projectId: codeSiteProjectId,
  towerState: 'active',
  activeFlights: [
    { id: 'flight-1', displayCallsign: 'AGENT-WF', domain: 'frontend', mission: 'Harden workflow interaction shell', route: ['synthi/src/components/agent-workflows/**'], status: 'active' },
    { id: 'flight-2', displayCallsign: 'AGENT-CS', domain: 'release', mission: 'Validate Codesite command rail', route: ['synthi/src/components/codesite/**'], status: 'active' },
  ],
  activeMutationLeases: [
    { id: 'lease-1', displayCallsign: 'AGENT-WF', status: 'active', expiresAt: '2026-07-07T12:30:00.000Z', lease: { allowedPaths: ['synthi/src/components/**'] }, dojoProofRef: 'proofcap_release_7f1c', dojoLicenseRef: 'dojo_guarded_deploy' },
  ],
  activeTransactions: [
    { id: 'txn-1', mutationLeaseId: 'lease-1', status: 'open', changedPaths: ['synthi/src/components/agent-workflows/AgentWorkflowPanel.jsx'] },
  ],
  requiredActions: [
    { id: 'action-1', kind: 'document_review', title: 'Review protected UI mutation', documentId: 'doc-1', evidenceRefs: ['evidence:doc:1'] },
  ],
  collisionForecast: {
    riskLevel: 'medium',
    risks: [{ type: 'shared_path', severity: 'medium', conflictZone: 'synthi/src/components/**' }],
    runwayOccupancy: [
      { runwayClass: 'A', pathPattern: 'synthi/src/components/**', holders: ['AGENT-WF'], activeTransactions: ['txn-1'], status: 'holding' },
    ],
  },
  pilotLicenseHealth: [
    { displayCallsign: 'AGENT-WF', status: 'active', level: 'E3' },
    { displayCallsign: 'AGENT-CS', status: 'active', level: 'E2' },
  ],
  filesystemBoundaryProofs: [
    { path: 'synthi/src/components/**', proofComplete: true, transactionId: 'txn-1', evidenceRefs: ['fs-boundary:txn-1'] },
  ],
};

const codeSiteMetrics = {
  status: 'measured',
  summary: {
    collisionsAvoided: 2,
    lineProvenanceCoverage: 0.88,
    blackBoxCompletenessScore: 0.91,
  },
  sections: {
    release: [
      { key: 'blocked_mutations', label: 'Blocked mutations', value: 2, unit: 'count', target: 0, status: 'active' },
      { key: 'proof_coverage', label: 'Proof coverage', value: 0.92, unit: 'ratio', target: 0.9, status: 'active' },
      { key: 'handoff_time', label: 'Handoff time', value: 44000, unit: 'duration_ms', target: 60000, status: 'active' },
    ],
  },
};

function fulfillJson(route, body, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

function fulfillText(route, body = '', status = 200) {
  return route.fulfill({ status, contentType: 'text/plain', body });
}

async function installMocks(page) {
  await page.addInitScript(() => {
    window.__VECTANT_VISUAL_PROOF__ = true;
    window.EventSource = class MockEventSource {
      constructor() {
        this.readyState = 1;
        setTimeout(() => {
          if (typeof this.onopen === 'function') this.onopen({ type: 'open' });
        }, 0);
      }
      addEventListener() {}
      removeEventListener() {}
      dispatchEvent() { return false; }
      close() { this.readyState = 2; }
    };
    try {
      localStorage.setItem('synthi-last-workspace', JSON.stringify({
        slug: 'visual-workspace',
        name: 'Vectant Systems',
        updatedAt: Date.now(),
      }));
      localStorage.removeItem('synthi-dock-layout:visual-workspace');
      localStorage.removeItem('synthi-terminal-manager:visual-workspace');
    } catch (_) {}
  });

  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = req.url();
    const u = new URL(url);
    const p = u.pathname;

    if (p.startsWith('/_next/') || p.startsWith('/favicon') || p.startsWith('/fonts/') || p.startsWith('/images/')) {
      return route.continue();
    }

    if (p === '/api/auth/session') {
      return fulfillJson(route, {
        user: { id: 'visual-user', name: 'Alex Infra', email: 'alex@vectant.dev', image: null },
        expires: '2099-01-01T00:00:00.000Z',
      });
    }
    if (p === '/api/user/github-token') return fulfillJson(route, { hasToken: true, source: 'visual-proof' });
    if (p === `/api/workspace/${slug}`) return fulfillJson(route, { workspace: { slug, name: 'Vectant Systems', role: 'owner' }, name: 'Vectant Systems' });
    if (p === `/api/workspace/${slug}/members`) return fulfillJson(route, { currentMember: { role: 'owner' }, members: [] });
    if (p === `/api/workspace/${slug}/prepare` || p.endsWith(`/api/workspace/${slug}/prepare`)) return fulfillJson(route, { status: 'ready', ready: true, steps: [] });

    if (p.includes(`/program-runtime/${slug}/ensure-runtime`)) return fulfillJson(route, { ok: true, ready: true, sessionId: 'visual-runtime' });
    if (p === `/api/workspace/${slug}/program-sessions`) return fulfillJson(route, { sessions: [] });
    if (p === `/api/workspace/${slug}/programs/installed`) return fulfillJson(route, { installs: [{ id: 'postman', packageId: '@vectant/postman', displayName: 'Postman', installedAt: new Date().toISOString() }] });
    if (p === `/api/workspace/${slug}/programs/marketplace`) return fulfillJson(route, { programs: [{ packageId: '@vectant/dbeaver', displayName: 'DBeaver', latestVersion: '1.0.0', verified: true }] });
    if (p === `/api/workspace/${slug}/programs/detect`) return fulfillJson(route, { config: null, source: null });

    if (p.includes(`/git/${slug}/files-meta`)) return fulfillJson(route, { files });
    if (p.includes(`/git/${slug}/file`)) {
      const filePath = decodeURIComponent(u.searchParams.get('path') || 'src/app/main.tsx');
      return fulfillJson(route, { content: contents[filePath] || `// ${filePath}\nexport const proof = true;\n` });
    }
    if (p.includes(`/git/${slug}/search`)) return fulfillJson(route, { status: 'ready', results: [] });
    if (p.includes(`/git/${slug}/index-ensure`) || p.includes(`/api/workspace/${slug}/index/ensure`)) return fulfillJson(route, { ok: true, status: 'ready' });
    if (p.includes(`/api/workspace/${slug}/index/status`)) return fulfillJson(route, { ok: true, status: 'ready', indexedFiles: files.length });
    if (p.includes(`/git/${slug}/status`)) return fulfillJson(route, {
      current: 'main',
      ahead: 1,
      behind: 0,
      files: [{ path: 'src/components/CommandDeck.tsx', index: ' ', working_dir: 'M' }],
    });
    if (p.includes(`/git/${slug}/branches`)) return fulfillJson(route, {
      current: 'main',
      local: ['main', 'redesign/proof', 'infra/session-control'],
      all: ['main', 'redesign/proof', 'infra/session-control'],
    });
    if (p.includes(`/git/${slug}/remotes`)) return fulfillJson(route, { remotes: [{ name: 'origin', url: 'git@github.com:vectant/systems.git' }] });
    if (p.includes(`/git/${slug}/log`)) return fulfillJson(route, { commits: [{ hash: 'b5813d6', message: 'Redesign provenance audit overlay', author: 'Codex', date: new Date().toISOString() }] });
    if (p.includes(`/git/${slug}/`)) return fulfillJson(route, { ok: true, branch: 'main', changes: [] });

    if (p === '/api/extensions/search') return fulfillJson(route, { extensions: [] });
    if (p.startsWith('/api/code-intel')) return fulfillJson(route, { status: 'ready', metrics: { filesIndexed: files.length, symbols: 42 }, results: [] });
    if (p.startsWith('/api/integrations')) return fulfillJson(route, { connections: [], providers: [], programs: [], tokens: [] });
    if (p.startsWith('/api/provenance')) return fulfillJson(route, { records: [] });
    if (p.startsWith('/api/theme-generate')) return fulfillJson(route, { colors: {}, themeName: 'Vectant proof theme' });
    if (p.startsWith('/api/classify') || p.startsWith('/api/chat') || p.startsWith('/api/completion')) return fulfillJson(route, { intent: 'explain', needs_code_changes: false, response_mode: 'explain', message: 'visual proof' });
    if (p.startsWith('/api/turn-credentials')) return fulfillJson(route, { iceServers: [] });
    if (p.includes('/socket.io/')) return fulfillText(route);

    if (p === '/browser-workflows/state') {
      return fulfillJson(route, { ok: true, state: workflowState });
    }
    if (p === '/browser-workflows/tool') {
      return fulfillJson(route, { ok: true, state: workflowState, result: { ok: true } });
    }
    if (p === '/browser-workflows/open-external') {
      return fulfillJson(route, { ok: true });
    }

    if (p === `/api/workspace/${slug}/codesite/projects`) {
      if (req.method() === 'POST') return fulfillJson(route, { project: codeSiteProject });
      return fulfillJson(route, {
        projects: [
          {
            id: codeSiteProjectId,
            title: codeSiteProject.title,
            status: codeSiteProject.status,
            updatedAt: new Date().toISOString(),
          },
        ],
      });
    }
    if (p === `/api/workspace/${slug}/codesite/projects/${codeSiteProjectId}`) {
      return fulfillJson(route, { project: codeSiteProject });
    }
    if (p === `/api/workspace/${slug}/codesite/projects/${codeSiteProjectId}/control-state`) {
      return fulfillJson(route, codeSiteControlState);
    }
    if (p === `/api/workspace/${slug}/codesite/projects/${codeSiteProjectId}/events`) {
      return fulfillJson(route, { events: codeSiteProject.events });
    }
    if (p === `/api/workspace/${slug}/codesite/projects/${codeSiteProjectId}/metrics`) {
      return fulfillJson(route, { metrics: codeSiteMetrics });
    }
    if (p === `/api/workspace/${slug}/codesite/projects/${codeSiteProjectId}/artifacts/preview`) {
      return fulfillJson(route, {
        files: [
          {
            path: 'artifacts/release-proof.json',
            contentPreview: JSON.stringify({ ok: true, evidence: ['playwright', 'next-build'] }, null, 2),
          },
        ],
      });
    }
    if (p === `/api/workspace/${slug}/codesite/projects/${codeSiteProjectId}/artifacts/export`) {
      return fulfillJson(route, { ok: true, artifactId: 'codesite-export-1' });
    }
    if (p === `/api/workspace/${slug}/codesite/projects/${codeSiteProjectId}/shadow-merge-simulate`) {
      return fulfillJson(route, {
        result: {
          selected: 'serial_replay',
          status: 'passed',
          universes: codeSiteProject.counterfactualRuns[0]?.result?.universes || [],
        },
      });
    }
    if (p === `/api/workspace/${slug}/codesite/quarantines`) {
      return fulfillJson(route, {
        quarantines: [
          {
            quarantineId: 'qtn-1',
            transactionId: 'txn-1',
            mutationLeaseId: 'lease-1',
            displayCallsign: 'AGENT-WF',
            status: 'pending_review',
            capturedAt: new Date().toISOString(),
            changes: [
              { path: 'synthi/src/components/agent-workflows/AgentWorkflowPanel.jsx', status: 'pending_review', reason: 'guarded UI mutation' },
              { path: 'synthi/src/components/codesite/CodeSitePanel.jsx', status: 'pending_review', reason: 'command rail update' },
            ],
          },
        ],
      });
    }
    if (p.startsWith(`/api/workspace/${slug}/codesite/`)) {
      return fulfillJson(route, { ok: true, result: { ok: true } });
    }

    if (p === `/workspace-presence/${slug}`) {
      return fulfillJson(route, {
        activeUsers: [{ id: 'visual-user', displayName: 'Alex Infra', name: 'Alex Infra', avatarUrl: '' }],
        sessions: [],
      });
    }
    if (p === '/session/create') {
      return fulfillJson(route, {
        sessionId: 'vp-session-1',
        inviteToken: 'vp-token',
        inviteLink: `${baseURL}/collab/vp-session-1?token=vp-token`,
        roomCode: 'VP2026',
        slug,
        hostName: 'Alex Infra',
        createdAt: new Date().toISOString(),
      });
    }
    if (p === '/session/info/vp-session-1') {
      return fulfillJson(route, {
        sessionId: 'vp-session-1',
        slug,
        hostName: 'Alex Infra',
        inviteLink: `${baseURL}/collab/vp-session-1?token=vp-token`,
        inviteToken: 'vp-token',
        roomCode: 'VP2026',
        guests: [],
        pendingKnocks: [],
        createdAt: new Date().toISOString(),
      });
    }
    if (p.startsWith('/session/')) return fulfillJson(route, { ok: true });

    if (u.origin === baseURL) return route.continue();
    return fulfillText(route);
  });
}

async function waitForWorkspace(page) {
  await page.goto(`${baseURL}/workspace/${slug}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForSelector('.workspace-root, .dock-workspace-root', { timeout: 120000 });
  await page.waitForSelector('[data-panel-type="explorer"]', { state: 'attached', timeout: 120000 });
  await page.waitForSelector('[data-panel-type="editor"]', { timeout: 120000 });
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important; pointer-events: none !important; }' });
  await page.waitForTimeout(2500);
}

async function waitForEditorReady(page) {
  await page.waitForFunction(() => {
    if (document.querySelector('.monaco-editor .view-line')) return true;
    const editorPanel = document.querySelector('[data-panel-type="editor"]');
    const text = editorPanel?.textContent || '';
    return /\b(import|export|function|const)\b/.test(text);
  }, undefined, { timeout: 60000 });
}

async function metrics(page, name) {
  return page.evaluate((caseName) => {
    const visible = Array.from(document.querySelectorAll('body *')).filter((el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    });
    const panels = Array.from(document.querySelectorAll('[data-panel-type]')).map((el) => el.getAttribute('data-panel-type'));
    return {
      name: caseName,
      title: document.title,
      textLength: (document.body.innerText || '').length,
      visibleElementCount: visible.length,
      panels: [...new Set(panels)],
      hasWorkspaceRoot: Boolean(document.querySelector('.workspace-root, .dock-workspace-root')),
      hasWorkflowCommandStrip: Boolean(document.querySelector('[data-testid="agent-workflow-command-strip"]')),
      hasWorkflowModeStrip: Boolean(document.querySelector('[data-testid="agent-workflow-mode-strip"]')),
      hasWorkflowInspector: Boolean(document.querySelector('[data-testid="agent-workflow-stage-inspector"]')),
      hasDojoShell: Boolean(document.querySelector('[data-testid="dojo-shell"]')),
      hasDojoCapabilityRegistry: Boolean(document.querySelector('[data-testid="dojo-capability-registry"]')),
      hasCortexView: Boolean(document.querySelector('[data-testid="skill-cortex-view"]')),
      hasCortexRail: Boolean(document.querySelector('[data-testid="cortex-node-rail"]')),
      hasCortexInspectorMetrics: Boolean(document.querySelector('[data-testid="cortex-node-metrics"]')),
      hasCodeSitePanel: Boolean(document.querySelector('[data-testid="codesite-panel"]')),
      hasCodeSiteDesktopRail: Boolean(document.querySelector('[data-testid="codesite-desktop-section-rail"]')),
      hasCodeSiteOperatingQueue: Boolean(document.querySelector('[data-testid="codesite-operating-model"]')),
      hasExplorer: Boolean(document.querySelector('[data-panel-type="explorer"]')),
      hasEditor: Boolean(document.querySelector('[data-panel-type="editor"], .monaco-editor')),
      hasTerminal: Boolean(document.querySelector('[data-panel-type="terminal"]')),
      hasDialogSurface: Boolean(document.querySelector('.vt-dialog-surface')),
      hasConfirmDialog: Boolean(document.querySelector('[data-testid="confirm-dialog"]')),
      viewport: { width: innerWidth, height: innerHeight },
      bodyBackground: getComputedStyle(document.body).backgroundColor,
    };
  }, name);
}

async function shot(page, name, fullPage = true) {
  const file = path.join(outDir, `${name}.png`);
  await page.screenshot({ path: file, fullPage });
  return { name, screenshot: file, screenshotBytes: fs.statSync(file).size, metrics: await metrics(page, name) };
}

async function screenshotWorkspace(page, name, viewport) {
  await page.setViewportSize(viewport);
  await waitForWorkspace(page);
  await waitForEditorReady(page);
  return shot(page, name);
}

async function ensureStatusIslandExpanded(page) {
  const expanded = page.locator('.status-island-phase--expanded .status-island');
  if (await expanded.isVisible().catch(() => false)) return;

  const logo = page.getByLabel('Open status island');
  await logo.click({ timeout: 10000 });
  await page.waitForSelector('.status-island-phase--expanded .status-island', { timeout: 4000 });
}

async function screenshotBranchMenu(page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForWorkspace(page);
  await ensureStatusIslandExpanded(page);
  const branchTrigger = page
    .locator('.status-island-branch .vt-branch-trigger')
    .or(page.getByRole('combobox', { name: /Current branch|Select branch/ }))
    .first();
  await branchTrigger.click({ timeout: 10000 });
  await page.waitForSelector('.vt-branch-menu', { timeout: 5000 });
  await page.waitForTimeout(250);
  return shot(page, 'branch-selector-open');
}

async function screenshotSessionControl(page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForWorkspace(page);
  const sessionButton = page.getByTitle('Open session controls (Ctrl+Shift+K)').first();
  await sessionButton.click({ timeout: 15000 });
  await page.getByRole('dialog', { name: 'Session control' }).waitFor({ state: 'visible', timeout: 5000 });
  await page.waitForSelector('.vt-session-modal', { state: 'visible', timeout: 5000 });
  await page.waitForFunction(() => {
    const modal = document.querySelector('.vt-session-modal');
    if (!modal) return false;
    const rect = modal.getBoundingClientRect();
    return rect.width > 320 && rect.height > 180 && Number(getComputedStyle(modal).opacity || 1) > 0.85;
  }, undefined, { timeout: 5000 });
  await page.waitForTimeout(1000);
  const debug = await page.locator('.vt-session-modal').evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const centerX = rect.x + rect.width / 2;
    const centerY = rect.y + rect.height / 2;
    const topElement = document.elementFromPoint(centerX, centerY);
    const children = Array.from(el.querySelectorAll('*')).slice(0, 16).map((child) => {
      const childRect = child.getBoundingClientRect();
      const childStyle = getComputedStyle(child);
      return {
        tag: child.tagName.toLowerCase(),
        className: child.className,
        text: (child.innerText || child.textContent || '').trim().slice(0, 80),
        rect: { x: childRect.x, y: childRect.y, width: childRect.width, height: childRect.height },
        color: childStyle.color,
        opacity: childStyle.opacity,
        display: childStyle.display,
        visibility: childStyle.visibility,
        transform: childStyle.transform,
        zIndex: childStyle.zIndex,
      };
    });
    return {
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      opacity: style.opacity,
      display: style.display,
      visibility: style.visibility,
      color: style.color,
      transform: style.transform,
      zIndex: style.zIndex,
      centerTopElement: topElement
        ? {
            tag: topElement.tagName.toLowerCase(),
            className: topElement.className,
            text: (topElement.innerText || topElement.textContent || '').trim().slice(0, 120),
          }
        : null,
      centerIsModal: Boolean(topElement && (topElement === el || el.contains(topElement))),
      text: el.innerText,
      className: el.className,
      children,
    };
  });
  fs.writeFileSync(path.join(outDir, 'session-control-debug.json'), JSON.stringify(debug, null, 2));
  const panelPath = path.join(outDir, 'session-control-panel.png');
  await page.locator('.vt-session-modal').screenshot({ path: panelPath });
  const panelBytes = fs.statSync(panelPath).size;
  if (!debug.centerIsModal || panelBytes < 10000) {
    throw new Error(`Session control modal is not visually on top; centerIsModal=${debug.centerIsModal}, panelBytes=${panelBytes}`);
  }
  return shot(page, 'session-control-idle');
}

async function screenshotFloatingWindow(page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForWorkspace(page);
  await page.waitForSelector('.dock-workspace-root [data-tab-id][title="Output"]', { timeout: 20000 });
  const outputTab = page.locator('.dock-workspace-root [data-tab-id][title="Output"]').first();
  await outputTab.scrollIntoViewIfNeeded();
  await outputTab.dblclick({ delay: 60 });

  const floating = page.locator('.dock-floating-window').first();
  await floating.waitFor({ state: 'visible', timeout: 5000 });
  const summon = await shot(page, 'floating-summon-animation');
  await page.waitForTimeout(650);
  const settled = await shot(page, 'floating-material');
  return [summon, settled];
}

async function screenshotWorkflowConsole(page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForWorkspace(page);
  await page.getByLabel('Workflows', { exact: true }).click({ timeout: 15000 });
  await page.waitForSelector('[data-testid="agent-workflow-mode-strip"]', { timeout: 30000 });
  await page.waitForSelector('[data-testid="agent-workflow-command-strip"]', { timeout: 30000 });
  await page.waitForSelector('[data-testid="agent-workflow-stage-inspector"]', { timeout: 30000 });
  const modes = await shot(page, 'workflow-agent-modes');
  await page.getByRole('tab', { name: /Debug/ }).click({ timeout: 10000 });
  await page.getByRole('tab', { name: /Trace/ }).click({ timeout: 10000 });
  const stageRows = page.locator('[data-testid="agent-workflow-stages"] [data-workflow-stage-selector]');
  if (await stageRows.nth(1).isVisible().catch(() => false)) {
    await stageRows.nth(1).click();
  }
  await page.waitForTimeout(450);
  return [modes, await shot(page, 'workflow-console-interactive')];
}

async function screenshotDojoOverview(page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${baseURL}/workspace/${slug}/dojo`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForSelector('[data-testid="dojo-shell"]', { timeout: 60000 });
  await page.waitForSelector('[data-testid="dojo-nav-preview"]', { timeout: 60000 });
  await page.waitForSelector('[data-testid="dojo-capability-registry"]', { timeout: 60000 });
  await page.getByRole('link', { name: /Cortex/ }).hover({ timeout: 10000 });
  await page.waitForFunction(() => {
    const preview = document.querySelector('[data-testid="dojo-nav-preview"]');
    const overview = Array.from(document.querySelectorAll('a')).find((link) => link.textContent?.includes('Overview'));
    return preview?.textContent?.includes('Cortex') && overview?.getAttribute('aria-current') === 'page';
  }, undefined, { timeout: 10000 });
  await page.waitForTimeout(450);
  return shot(page, 'dojo-interactive-rail');
}

async function screenshotCortexRail(page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${baseURL}/workspace/${slug}/dojo/skills/dojo_guarded_deploy/cortex`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForSelector('[data-testid="skill-cortex-view"]', { timeout: 60000 });
  await page.waitForSelector('[data-testid="cortex-node-rail"]', { timeout: 60000 });
  await page.waitForSelector('[data-testid="cortex-node-metrics"]', { timeout: 60000 });
  const nodeButtons = page.locator('[data-testid="cortex-node-rail"] button');
  if (await nodeButtons.nth(1).isVisible().catch(() => false)) {
    await nodeButtons.nth(1).click();
  }
  await page.waitForFunction(() => {
    return Array.from(document.querySelectorAll('[data-testid="cortex-node-rail"] button')).every((button) => {
      const rect = button.getBoundingClientRect();
      return rect.width >= 44 && rect.height >= 44;
    });
  }, undefined, { timeout: 10000 });
  await page.waitForTimeout(450);
  return shot(page, 'cortex-node-rail');
}

async function screenshotCodeSiteRail(page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${baseURL}/workspace/${slug}/codesite`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForSelector('[data-testid="codesite-panel"]', { timeout: 60000 });
  await page.waitForSelector('[data-testid="codesite-desktop-section-rail"]', { timeout: 60000 });
  await page.waitForSelector('[data-testid="codesite-operating-model"]', { timeout: 60000 });
  await page.getByRole('tab', { name: /Governance/ }).click({ timeout: 10000 });
  await page.waitForSelector('[data-testid="codesite-governance-console"]', { timeout: 20000 });
  await page.waitForFunction(() => {
    const rail = document.querySelector('[data-testid="codesite-desktop-section-rail"]');
    const target = document.querySelector('[data-codesite-section="governance"]');
    const tabs = Array.from(document.querySelectorAll('[data-testid="codesite-desktop-section-tab"]'));
    if (!rail || !target || !tabs.length) return false;
    const railBottom = rail.getBoundingClientRect().bottom;
    const targetTop = target.getBoundingClientRect().top;
    const targetsSized = tabs.every((tab) => {
      const rect = tab.getBoundingClientRect();
      return rect.width >= 44 && rect.height >= 44;
    });
    return targetsSized && targetTop >= railBottom + 8;
  }, undefined, { timeout: 10000 });
  await page.waitForTimeout(600);
  return shot(page, 'codesite-desktop-command-rail');
}

async function openSettings(page) {
  await page.getByLabel('Settings', { exact: true }).click({ timeout: 15000 });
  await page.waitForSelector('text=Color Theme', { timeout: 20000 });
}

function isSurfaceReady(c) {
  return Boolean(
    c.metrics.hasWorkspaceRoot
      || c.metrics.hasDojoShell
      || c.metrics.hasCortexView
      || c.metrics.hasCodeSitePanel,
  );
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const consoleMessages = [];
  const pageErrors = [];
  page.on('console', (msg) => {
    if (['error', 'warning'].includes(msg.type())) {
      consoleMessages.push({ type: msg.type(), text: msg.text().slice(0, 500) });
    }
  });
  page.on('pageerror', (err) => pageErrors.push(String((err && err.stack) || err)));
  await installMocks(page);

  const cases = [];
  cases.push(await screenshotWorkspace(page, 'workspace-desktop', { width: 1440, height: 900 }));
  cases.push(await screenshotBranchMenu(page));
  cases.push(await screenshotSessionControl(page));
  cases.push(...await screenshotFloatingWindow(page));
  cases.push(...await screenshotWorkflowConsole(page));

  await openSettings(page);
  cases.push(await shot(page, 'settings-panel'));

  await page.getByText('Color Theme', { exact: true }).click({ timeout: 15000 });
  await page.waitForSelector('.vt-dialog-surface input[placeholder="Find theme"]', { timeout: 20000 });
  cases.push(await shot(page, 'theme-picker'));

  await page.getByText('New custom theme').click({ timeout: 15000 });
  await page.waitForSelector('input[placeholder="Ops dark, Platform light, Incident review"]', { timeout: 20000 });
  cases.push(await shot(page, 'theme-creator'));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(800);

  await waitForWorkspace(page);
  const targetFile = page.locator('[data-panel-type="explorer"] [data-node-path="README.md"]');
  if (!(await targetFile.isVisible().catch(() => false))) {
    await page.getByLabel('Explorer', { exact: true }).click({ timeout: 15000 });
  }
  await page.waitForSelector('[data-panel-type="explorer"]', { timeout: 20000 });
  await targetFile.waitFor({ state: 'visible', timeout: 30000 });
  await targetFile.click({ button: 'right', timeout: 20000 });
  await page.getByText('Delete', { exact: true }).click({ timeout: 15000 });
  await page.waitForSelector('[data-testid="confirm-dialog"]', { timeout: 15000 });
  cases.push(await shot(page, 'file-delete-confirm'));
  await page.getByTestId('confirm-cancel').click();

  cases.push(await screenshotWorkspace(page, 'workspace-tablet', { width: 900, height: 1024 }));
  cases.push(await screenshotWorkspace(page, 'workspace-mobile', { width: 390, height: 844 }));
  cases.push(await screenshotDojoOverview(page));
  cases.push(await screenshotCortexRail(page));
  cases.push(await screenshotCodeSiteRail(page));

  const report = {
    generatedAt: new Date().toISOString(),
    route: `/workspace/${slug}`,
    baseURL,
    cases,
    consoleMessages: consoleMessages.slice(-40),
    pageErrors,
    ok: cases.every((c) => c.screenshotBytes > 30000 && c.metrics.visibleElementCount > 30 && isSurfaceReady(c))
      && cases.some((c) => c.name === 'theme-picker' && c.metrics.hasDialogSurface)
      && cases.some((c) => c.name === 'file-delete-confirm' && c.metrics.hasConfirmDialog)
      && cases.some((c) => c.name === 'branch-selector-open')
      && cases.some((c) => c.name === 'session-control-idle' && c.metrics.hasDialogSurface)
      && cases.some((c) => c.name === 'floating-summon-animation')
      && cases.some((c) => c.name === 'floating-material')
      && cases.some((c) => c.name === 'workflow-agent-modes' && c.metrics.hasWorkflowModeStrip)
      && cases.some((c) => c.name === 'workflow-console-interactive' && c.metrics.hasWorkflowModeStrip && c.metrics.hasWorkflowCommandStrip && c.metrics.hasWorkflowInspector)
      && cases.some((c) => c.name === 'dojo-interactive-rail' && c.metrics.hasDojoShell && c.metrics.hasDojoCapabilityRegistry)
      && cases.some((c) => c.name === 'cortex-node-rail' && c.metrics.hasCortexView && c.metrics.hasCortexRail && c.metrics.hasCortexInspectorMetrics)
      && cases.some((c) => c.name === 'codesite-desktop-command-rail' && c.metrics.hasCodeSitePanel && c.metrics.hasCodeSiteDesktopRail && c.metrics.hasCodeSiteOperatingQueue),
  };
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
  if (!report.ok || pageErrors.length) process.exit(1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
