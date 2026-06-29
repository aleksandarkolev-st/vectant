import fs from 'fs/promises';
import path from 'path';
import { asArray, stableJson } from './json';
import { buildProofBundle, formatCommitTrailers } from './proof';

export const CODESITE_ARTIFACT_VERSION = 1;

export function codesiteSchemas() {
  return {
    'execution-plan.schema.json': schema('ExecutionPlan', {
      agentSessionId: { type: 'string' },
      displayCallsign: { type: 'string' },
      mission: { type: 'string' },
      domain: { type: 'string' },
      route: { type: 'array', items: { type: 'string' } },
      blockedZones: { type: 'array', items: { type: 'string' } },
      requestedTools: { type: 'array', items: { type: 'string' } },
      abortConditions: { type: 'array' },
    }, ['agentSessionId', 'mission', 'route']),
    'mutation-lease.schema.json': schema('MutationLease', {
      executionPlanId: { type: 'string' },
      displayCallsign: { type: 'string' },
      status: { type: 'string' },
      lease: { type: 'object' },
      dojoProofRef: { type: ['string', 'null'] },
      implementationStatus: { type: 'object' },
    }, ['executionPlanId', 'displayCallsign', 'status', 'lease']),
    'mutation-transaction.schema.json': schema('MutationTransaction', {
      mutationLeaseId: { type: 'string' },
      baseSnapshot: { type: 'string' },
      isolation: { type: 'string' },
      status: { type: 'string' },
      readSet: { type: 'array', items: { type: 'string' } },
      writeSet: { type: 'array', items: { type: 'string' } },
      invariants: { type: 'array' },
    }, ['mutationLeaseId', 'baseSnapshot', 'isolation', 'status']),
    'assumption-lease.schema.json': schema('AssumptionLease', {
      assumptionKey: { type: 'string' },
      dependsOn: { type: 'array' },
      usedBy: { type: 'array' },
      status: { type: 'string' },
      invalidatedBy: { type: ['string', 'null'] },
    }, ['assumptionKey', 'status']),
    'document.schema.json': schema('Document', {
      kind: { type: 'string' },
      status: { type: 'string' },
      title: { type: 'string' },
      body: { type: 'object' },
      blocking: { type: 'boolean' },
    }, ['kind', 'status', 'title']),
    'event.schema.json': schema('Event', {
      eventType: { type: 'string' },
      displayCallsign: { type: ['string', 'null'] },
      logicalTime: { type: ['number', 'null'] },
      details: { type: 'object' },
      evidenceRefs: { type: 'array' },
    }, ['eventType', 'details']),
    'proof-bundle.schema.json': schema('ProofBundle', {
      transactionId: { type: 'string' },
      mutationLeaseId: { type: ['string', 'null'] },
      readSetDigest: { type: 'string' },
      writeSetDigest: { type: 'string' },
      invariants: { type: 'array' },
      portableDigest: { type: 'string' },
    }, ['transactionId', 'readSetDigest', 'writeSetDigest', 'portableDigest']),
  };
}

function schema(title, properties, required) {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: `CodeSite ${title}`,
    type: 'object',
    required,
    properties,
    additionalProperties: true,
  };
}

export function buildArtifactProjection(project, controlState = null) {
  const projectDir = `projects/${project.id}`;
  const files = [
    jsonFile('manifest.json', {
      version: CODESITE_ARTIFACT_VERSION,
      project_id: project.id,
      workspace_slug: project.workspaceSlug,
      control_state: `${projectDir}/control-state.json`,
      events: `${projectDir}/events.jsonl`,
      schemas: 'schemas/',
      inbox_root: `${projectDir}/inbox/`,
      proof_bundle_root: `${projectDir}/proof-bundles/`,
      mcp_tools: [
        'synthi_codesite_next_event',
        'synthi_codesite_ack_event',
        'synthi_codesite_open_transaction',
        'synthi_codesite_validate_transaction',
      ],
    }),
    jsonFile('airspace/zones.json', project.zonePolicy?.zones || []),
    jsonFile('airspace/no-fly-zones.json', project.zonePolicy?.noFlyZones || []),
    jsonFile('airspace/class-rules.json', project.zonePolicy?.classRules || {}),
    jsonFile(`${projectDir}/tower-plan.json`, project.controlPlan || {}),
    jsonFile(`${projectDir}/control-state.json`, controlState || minimalControlState(project)),
    jsonFile(`${projectDir}/radar-snapshot.json`, controlState || minimalControlState(project)),
    jsonFile(`${projectDir}/collision-forecast.json`, controlState?.collisionForecast || {}),
    {
      relativePath: `${projectDir}/events.jsonl`,
      content: asArray(project.events).map((event) => stableJson(event)).join('\n') + (project.events?.length ? '\n' : ''),
    },
    {
      relativePath: `${projectDir}/provenance/line-provenance.jsonl`,
      content: asArray(project.lineProvenance).map((row) => stableJson(row)).join('\n') + (project.lineProvenance?.length ? '\n' : ''),
    },
    {
      relativePath: `${projectDir}/handover.md`,
      content: handoverMarkdown(project, controlState),
    },
  ];

  for (const [filename, schemaDoc] of Object.entries(codesiteSchemas())) {
    files.push(jsonFile(`schemas/${filename}`, schemaDoc));
  }

  for (const decision of asArray(project.policyDecisions)) {
    files.push(jsonFile(`${projectDir}/policy-decisions/${decision.id}.json`, decision));
  }

  for (const session of asArray(project.agentSessions)) {
    const callsign = safeSegment(session.displayCallsign);
    files.push(jsonFile(`${projectDir}/flights/${callsign}/agent-session.json`, session));
    for (const plan of asArray(project.executionPlans).filter((item) => item.agentSessionId === session.id)) {
      files.push(jsonFile(`${projectDir}/flights/${callsign}/flight-plan.json`, plan));
    }
    for (const lease of asArray(project.mutationLeases).filter((item) => item.agentSessionId === session.id)) {
      files.push(jsonFile(`${projectDir}/flights/${callsign}/clearance.json`, lease));
    }
    for (const txn of asArray(project.mutationTxns).filter((item) => item.agentSessionId === session.id)) {
      files.push(jsonFile(`${projectDir}/flights/${callsign}/transaction-${txn.id}.json`, txn));
    }
    const assumptions = asArray(project.assumptions).filter((item) => item.ownerSessionId === session.id);
    files.push(jsonFile(`${projectDir}/flights/${callsign}/assumptions.json`, assumptions));
    const inbox = asArray(project.inboxItems).filter((item) => item.agentSessionId === session.id);
    for (const item of inbox) {
      files.push(jsonFile(`${projectDir}/inbox/${callsign}/${item.eventId || item.id}.json`, item));
    }
  }

  for (const document of asArray(project.documents)) {
    files.push(jsonFile(`${projectDir}/documents/${document.kind}-${document.id}.json`, document));
  }

  for (const incident of asArray(project.incidents)) {
    const folder = incident.category === 'near_miss' ? 'near-misses' : 'incidents';
    files.push(jsonFile(`${projectDir}/${folder}/${incident.id}.json`, incident));
    files.push({
      relativePath: `${projectDir}/incidents/incident-replay-${incident.id}.jsonl`,
      content: stableJson(incident.incidentReplay || {}) + '\n',
    });
  }

  for (const run of asArray(project.counterfactualRuns)) {
    files.push(jsonFile(`${projectDir}/counterfactual-runs/${run.id}.json`, run));
  }

  for (const delta of asArray(project.policyDeltas)) {
    files.push(jsonFile(`${projectDir}/policy-deltas/${delta.id}.json`, delta));
  }

  for (const proof of asArray(project.proofBundles)) {
    const transaction = asArray(project.mutationTxns).find((item) => item.id === proof.transactionId);
    const mutationLease = transaction
      ? asArray(project.mutationLeases).find((item) => item.id === transaction.mutationLeaseId)
      : null;
    const lineProvenance = asArray(project.lineProvenance).filter((row) => row.proofBundleId === proof.id);
    const portable = buildProofBundle({ project, transaction, mutationLease, proofBundle: proof, incidents: project.incidents, lineProvenance });
    files.push(jsonFile(`${projectDir}/proof-bundles/${proof.id}.proof.json`, portable));
    files.push({
      relativePath: `${projectDir}/proof-bundles/${proof.id}.trailers.txt`,
      content: `${formatCommitTrailers(portable)}\n`,
    });
  }

  return files;
}

function minimalControlState(project) {
  return {
    projectId: project.id,
    workspaceSlug: project.workspaceSlug,
    towerState: project.status,
    activeFlights: asArray(project.executionPlans).filter((plan) => plan.status !== 'closed'),
    activeMutationLeases: asArray(project.mutationLeases).filter((lease) => lease.status === 'active'),
    requiredActions: [],
  };
}

function handoverMarkdown(project, controlState) {
  const forecast = controlState?.collisionForecast;
  const lines = [
    `# CodeSite Handover: ${project.title}`,
    '',
    `Workspace: ${project.workspaceSlug}`,
    `Project: ${project.id}`,
    `Status: ${project.status}`,
    '',
    '## Black Box',
    '',
    `- Events recorded: ${asArray(project.events).length}`,
    `- Clearances issued: ${asArray(project.mutationLeases).length}`,
    `- Transactions tracked: ${asArray(project.mutationTxns).length}`,
    `- Incidents replayable: ${asArray(project.incidents).length}`,
    `- Proof bundles: ${asArray(project.proofBundles).length}`,
    '',
    '## Collision Forecast',
    '',
    `Risk level: ${forecast?.riskLevel || 'unknown'}`,
  ];
  for (const risk of asArray(forecast?.risks)) {
    lines.push(`- ${risk.severity}: ${risk.risk} in ${risk.conflictZone}`);
  }
  return `${lines.join('\n')}\n`;
}

function jsonFile(relativePath, value) {
  return {
    relativePath,
    content: `${JSON.stringify(value ?? null, null, 2)}\n`,
  };
}

export function resolveConfiguredArtifactRoot(workspaceSlug) {
  const root = process.env.SYNTHI_CODESITE_ARTIFACT_ROOT;
  if (!root) return null;
  const safeSlug = safeSegment(workspaceSlug);
  return path.join(root, safeSlug, '.synthi', 'codesite');
}

export async function writeArtifactProjection(project, controlState, artifactRoot = resolveConfiguredArtifactRoot(project.workspaceSlug)) {
  if (!artifactRoot) {
    return {
      written: false,
      reason: 'artifact_root_not_configured',
      files: buildArtifactProjection(project, controlState).map((file) => file.relativePath),
    };
  }
  const root = path.resolve(artifactRoot);
  const files = buildArtifactProjection(project, controlState);
  const written = [];
  for (const file of files) {
    const target = path.resolve(root, file.relativePath);
    if (!isPathInside(root, target)) {
      throw new Error('codesite_artifact_path_escape');
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, file.content, 'utf8');
    written.push(file.relativePath);
  }
  return { written: true, root, files: written };
}

function isPathInside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function safeSegment(value) {
  return String(value || 'unknown')
    .replace(/[^a-z0-9_.-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || 'unknown';
}
