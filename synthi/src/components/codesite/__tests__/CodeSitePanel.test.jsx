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
      proofBundles: [{ id: 'proof-1', bundleDigest: 'digest-proof-1', readSetDigest: 'digest-read' }],
      incidents: [{ id: 'incident-1', category: 'near_miss', severity: 'medium', affectedZones: ['api/**'] }],
      inspectionRuns: [{ id: 'inspection-1', displayCallsign: 'QA-1', status: 'passed', changedPaths: ['src/app/page.jsx'] }],
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
      createdAt: '2026-06-29T23:31:00.000Z',
    }],
    artifactPreview: { files: [{ path: 'projects/proj-1/control-state.json', bytes: 1200 }] },
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
    expect(container.textContent).toContain('write_overlap');
    expect(container.textContent).toContain('projects/proj-1/control-state.json');
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
