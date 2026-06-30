/* @vitest-environment jsdom */

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  createCodeSiteProject: vi.fn(),
  exportCodeSiteArtifacts: vi.fn(),
  fetchCodeSiteRadarState: vi.fn(),
}));

function emptyState(workspaceSlug = 'acme') {
  return {
    workspaceSlug,
    projects: [],
    project: null,
    controlState: null,
    events: [],
    artifactPreview: null,
    selectedProjectId: null,
    counts: {
      projects: 0,
      activeFlights: 0,
      activeMutationLeases: 0,
      activeTransactions: 0,
      requiredActions: 0,
      events: 0,
      proofBundles: 0,
      incidents: 0,
      inspectionRuns: 0,
    },
    collisionForecast: { riskLevel: 'unknown', risks: [] },
  };
}

vi.mock('../codesiteClient', () => ({
  createCodeSiteProject: h.createCodeSiteProject,
  createEmptyCodeSiteRadarState: emptyState,
  exportCodeSiteArtifacts: h.exportCodeSiteArtifacts,
  fetchCodeSiteRadarState: h.fetchCodeSiteRadarState,
}));

import CodeSitePanel from '../CodeSitePanel';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root;
let container;

function renderPanel(props = {}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(<CodeSitePanel workspaceSlug="acme" {...props} />);
  });
  return container;
}

async function flush(times = 4) {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function setNativeInputValue(element, value) {
  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value');
  descriptor?.set?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

function laneNamed(name) {
  return [...container.querySelectorAll('[data-testid="codesite-airspace-lane"]')]
    .find((lane) => lane.textContent.includes(name));
}

function testRadarPoint(angle, radius) {
  const radians = (angle - 90) * (Math.PI / 180);
  return {
    x: 50 + Math.cos(radians) * radius,
    y: 50 + Math.sin(radians) * radius,
  };
}

function testEventPoint(event, index, total) {
  const seed = String(event?.eventType || event?.id || index).split('').reduce((sum, char) => sum + char.charCodeAt(0), 0);
  const angle = (seed + (index * 29)) % 360;
  const radius = 12 + ((index % Math.max(1, total)) * (34 / Math.max(1, total)));
  return testRadarPoint(angle, radius);
}

function expectedReplayPath(events) {
  const newestFirstEvents = events.slice(-12).reverse();
  const replayEvents = newestFirstEvents.slice(0, 7).reverse();
  return replayEvents
    .map((event, index) => testEventPoint(event, index, replayEvents.length))
    .map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`)
    .join(' ');
}

function radarState() {
  return {
    workspaceSlug: 'acme',
    projects: [{ id: 'proj-1', title: 'Checkout coordination', counts: {} }],
    project: {
      id: 'proj-1',
      title: 'Checkout coordination',
      request: 'Coordinate checkout mutations',
      status: 'active',
      zonePolicy: {
        zones: [
          { zoneKey: 'api-zone', label: 'API airspace', class: 'B', paths: ['api/checkout/**'], risk: 'medium' },
          { zoneKey: 'api-check-zone', label: 'Health API airspace', class: 'C', paths: ['api/check/**'], risk: 'low' },
        ],
        noFlyZones: ['secrets/**'],
      },
      proofBundles: [{
        id: 'proof-1',
        bundleDigest: 'digest-proof-1',
        readSetDigest: 'digest-read',
        evidenceRefs: ['test:checkout'],
        trailers: {
          'CodeSite-Project': 'proj-1',
          'CodeSite-Flight': 'ATLAS-1',
          'CodeSite-Clearance': 'lease-1',
          'CodeSite-Landing': 'completed',
          'CodeSite-Transaction': 'txn-1',
        },
      }],
      incidents: [{
        id: 'incident-1',
        category: 'near_miss',
        severity: 'medium',
        participants: ['ATLAS-1'],
        affectedZones: ['api/**'],
        evidenceRefs: ['incident:evidence'],
        replayDigest: 'sha256:incident',
      }],
      inspectionRuns: [{
        id: 'inspection-1',
        displayCallsign: 'QA-1',
        status: 'passed',
        changedPaths: ['src/app/page.jsx'],
        inspectionSignals: [{ type: 'test', status: 'passed' }],
        evidenceRefs: ['test:checkout'],
      }],
      lineProvenance: [{
        id: 'line-1',
        filePath: 'api/checkout/route.js',
        lineAnchor: 'L42',
        displayCallsign: 'ATLAS-1',
        reasonRef: 'rfi:checkout',
        evidenceRefs: ['proof-1', 'hunk:checkout'],
        processAncestry: ['mcp:synthi_codesite_apply_patch'],
        promptSummary: 'Add checkout route',
      }],
      inboxItems: [{
        id: 'inbox-1',
        agentSessionId: 'agent-1',
        recipientUserId: 'user-1',
        eventId: 'event-1',
        documentId: 'doc-1',
        kind: 'rfi',
        requiresResponse: true,
        status: 'pending',
        redactedPayload: { title: 'Need schema owner', documentId: 'doc-1' },
      }],
    },
    controlState: {
      projectId: 'proj-1',
      towerState: 'holding',
      activeFlights: [{
        id: 'plan-1',
        displayCallsign: 'ATLAS-1',
        mission: 'Checkout API',
        domain: 'backend',
        status: 'holding',
        route: ['api/checkout/**'],
      }],
      activeMutationLeases: [{
        id: 'lease-1',
        displayCallsign: 'ATLAS-1',
        status: 'active',
        lease: { allowedPaths: ['api/checkout/**'] },
        dojoProofRef: 'pcap-checkout-schema',
        dojoLicenseRef: 'schema.level_2@2026-06-25',
        dojoEvidenceRefs: ['dojo:evidence:checkride-1'],
        dojoLedgerCheckpointHash: 'sha256:ledger',
        dojoDecisionDigest: 'sha256:dojo-decision',
        expiresAt: '2026-06-29T23:59:00.000Z',
      }],
      activeTransactions: [{
        id: 'txn-1',
        status: 'open',
        writeSet: ['api/checkout/route.js'],
        openedAt: '2026-06-29T23:30:00.000Z',
      }],
      requiredActions: ['ack_event:event-1'],
      allowedPaths: ['api/checkout/**'],
      blockedPaths: ['secrets/**'],
      collisionForecast: {
        riskLevel: 'medium',
        risks: [{ risk: 'write_overlap', severity: 'medium', conflictZone: 'api/checkout/**' }],
      },
    },
    events: [
      {
        id: 'event-1',
        eventType: 'flight_plan_filed',
        displayCallsign: 'ATLAS-1',
        logicalTime: 7,
        details: { executionPlanId: 'plan-1', mission: 'Checkout API' },
        evidenceRefs: ['event:evidence'],
        createdAt: '2026-06-29T23:31:00.000Z',
      },
      {
        id: 'event-2',
        eventType: 'clearance_issued',
        displayCallsign: 'ATLAS-1',
        logicalTime: 8,
        details: { leaseId: 'lease-1', route: 'api/checkout/**' },
        evidenceRefs: ['event:evidence:lease'],
        createdAt: '2026-06-29T23:32:00.000Z',
      },
    ],
    artifactPreview: { files: [{ path: 'projects/proj-1/control-state.json', bytes: 1200, contentPreview: '{\\n  \"towerState\": \"holding\"\\n}\\n' }] },
    selectedProjectId: 'proj-1',
    counts: {
      projects: 1,
      activeFlights: 1,
      activeMutationLeases: 1,
      activeTransactions: 1,
      requiredActions: 1,
      events: 2,
      proofBundles: 1,
      incidents: 1,
      inspectionRuns: 1,
    },
    collisionForecast: {
      riskLevel: 'medium',
      risks: [{ risk: 'write_overlap', severity: 'medium', conflictZone: 'api/checkout/**' }],
    },
  };
}

describe('CodeSitePanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.exportCodeSiteArtifacts.mockResolvedValue({ written: false, files: [] });
  });

  afterEach(() => {
    if (root) {
      act(() => root.unmount());
      root = undefined;
    }
    if (container) {
      container.remove();
      container = undefined;
    }
  });

  it('renders the radar state and exports artifact projection', async () => {
    h.fetchCodeSiteRadarState.mockResolvedValue(radarState());
    renderPanel();
    await flush();

    expect(container.querySelector('[data-testid="codesite-panel"]')).toBeTruthy();
    expect(container.textContent).toContain('Checkout coordination');
    expect(container.textContent).toContain('ATLAS-1');
    expect(container.textContent).toContain('pcap-checkout-schema');
    expect(container.textContent).toContain('schema.level_2@2026-06-25');
    expect(container.textContent).toContain('dojo:evidence:checkride-1');
    expect(container.textContent).toContain('Airspace Map');
    expect(container.textContent).toContain('API airspace');
    expect(container.textContent).toContain('write_overlap');
    const riskCones = container.querySelectorAll('[data-testid="codesite-risk-cone"]');
    const replayTrace = container.querySelector('[data-testid="codesite-replay-trace"]');
    const flightBlips = container.querySelectorAll('[data-testid="codesite-flight-blip"]');
    const holdingPatterns = container.querySelectorAll('[data-testid="codesite-holding-pattern"]');
    expect(container.querySelector('[data-testid="codesite-radar-graph"]')).toBeTruthy();
    expect(riskCones).toHaveLength(1);
    expect(riskCones[0].getAttribute('fill')).toBe('#fbbf24');
    expect(replayTrace.getAttribute('points').trim().split(/\s+/)).toHaveLength(2);
    expect(flightBlips).toHaveLength(1);
    expect(holdingPatterns).toHaveLength(1);
    expect(container.textContent).toContain('Landing queue');
    expect(container.textContent).toContain('QA-1');
    expect(container.textContent).toContain('passed');
    expect(laneNamed('API airspace').textContent).toContain('ATLAS-1');
    expect(laneNamed('Health API airspace').textContent).not.toContain('ATLAS-1');
    expect(container.textContent).toContain('CodeSite-Clearance');
    expect(container.textContent).toContain('CodeSite-Transaction');
    expect(container.textContent).toContain('Line Provenance');
    expect(container.textContent).toContain('api/checkout/route.js');
    expect(container.textContent).toContain('hunk:checkout');
    expect(container.textContent).toContain('mcp:synthi_codesite_apply_patch');
    expect(container.textContent).toContain('Add checkout route');
    expect(container.textContent).toContain('Agent Inbox');
    expect(container.textContent).toContain('Need schema owner');
    expect(container.textContent).toContain('logicalTime');
    expect(container.textContent).toContain('event:evidence');
    expect(container.textContent).toContain('projects/proj-1/control-state.json');
    expect(container.textContent).toContain('towerState');
    expect(container.querySelector('[data-testid="codesite-metric-flights"]').textContent).toContain('1');

    await act(async () => {
      container.querySelector('[data-testid="codesite-export"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(h.exportCodeSiteArtifacts).toHaveBeenCalledWith('acme', 'proj-1');
  });

  it('does not draw a holding pattern for airborne flights', async () => {
    const state = radarState();
    state.controlState.activeFlights = state.controlState.activeFlights.map((flight) => ({
      ...flight,
      status: 'airborne',
    }));
    h.fetchCodeSiteRadarState.mockResolvedValue(state);

    renderPanel();
    await flush();

    expect(container.querySelectorAll('[data-testid="codesite-flight-blip"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-testid="codesite-holding-pattern"]')).toHaveLength(0);
  });

  it('draws the replay trace from the latest event tail', async () => {
    const state = radarState();
    state.events = [
      'flight_plan_filed',
      'clearance_requested',
      'clearance_issued',
      'transaction_opened',
      'write_attempted',
      'write_allowed',
      'transaction_validated',
      'landing_requested',
      'inspection_result',
    ].map((eventType, index) => ({
      id: `event-${index + 1}`,
      eventType,
      displayCallsign: 'ATLAS-1',
      logicalTime: index + 1,
      details: { index },
      evidenceRefs: [`event:evidence:${index + 1}`],
      createdAt: `2026-06-29T23:${String(31 + index).padStart(2, '0')}:00.000Z`,
    }));
    state.counts.events = state.events.length;

    h.fetchCodeSiteRadarState.mockResolvedValue(state);
    renderPanel();
    await flush();

    expect(container.querySelector('[data-testid="codesite-replay-trace"]').getAttribute('points')).toBe(expectedReplayPath(state.events));
  });

  it('opens the first project from the empty state', async () => {
    h.fetchCodeSiteRadarState
      .mockResolvedValueOnce(emptyState())
      .mockResolvedValue(radarState());
    h.createCodeSiteProject.mockResolvedValue({ id: 'proj-1', title: 'Landing project' });

    renderPanel();
    await flush();

    expect(container.querySelector('[data-testid="codesite-empty-state"]')).toBeTruthy();
    const input = container.querySelector('input');
    act(() => {
      setNativeInputValue(input, 'Landing project');
    });

    await act(async () => {
      container.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    await flush();

    expect(h.createCodeSiteProject).toHaveBeenCalledWith(
      'acme',
      expect.objectContaining({ title: 'Landing project', request: 'Landing project' }),
    );
    expect(container.textContent).toContain('Checkout coordination');
  });
});
