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
        zones: [{ zoneKey: 'api-zone', label: 'API airspace', class: 'B', paths: ['api/checkout/**'], risk: 'medium' }],
        noFlyZones: ['secrets/**'],
      },
      proofBundles: [{
        id: 'proof-1',
        bundleDigest: 'digest-proof-1',
        readSetDigest: 'digest-read',
        evidenceRefs: ['test:checkout'],
        trailers: { 'CodeSite-Transaction': 'txn-1' },
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
        status: 'airborne',
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
    events: [{
      id: 'event-1',
      eventType: 'flight_plan_filed',
      displayCallsign: 'ATLAS-1',
      logicalTime: 7,
      details: { executionPlanId: 'plan-1', mission: 'Checkout API' },
      evidenceRefs: ['event:evidence'],
      createdAt: '2026-06-29T23:31:00.000Z',
    }],
    artifactPreview: { files: [{ path: 'projects/proj-1/control-state.json', bytes: 1200, contentPreview: '{\\n  \"towerState\": \"holding\"\\n}\\n' }] },
    selectedProjectId: 'proj-1',
    counts: {
      projects: 1,
      activeFlights: 1,
      activeMutationLeases: 1,
      activeTransactions: 1,
      requiredActions: 1,
      events: 1,
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
