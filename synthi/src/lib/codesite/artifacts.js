import fs from 'fs/promises';
import path from 'path';
import { asArray, stableJson } from './json';
import { CODE_SITE_EVENT_TYPES } from './policy';
import { buildProofBundle, formatCommitTrailers } from './proof';

export const CODESITE_ARTIFACT_VERSION = 1;
const ARTIFACT_FILE_INDEX = '.codesite-projection-files.json';
const artifactWriteQueues = new Map();

export const CODESITE_MCP_TOOLS = [
  'synthi_codesite_file_flight_plan',
  'synthi_codesite_request_clearance',
  'synthi_codesite_open_transaction',
  'synthi_codesite_get_transaction_status',
  'synthi_codesite_preview_transaction',
  'synthi_codesite_dry_run_patch',
  'synthi_codesite_preflight_write',
  'synthi_codesite_apply_patch',
  'synthi_codesite_record_assumption',
  'synthi_codesite_record_read',
  'synthi_codesite_record_write',
  'synthi_codesite_validate_transaction',
  'synthi_codesite_request_commit',
  'synthi_codesite_get_source_state_since',
  'synthi_codesite_get_radar',
  'synthi_codesite_next_event',
  'synthi_codesite_get_inbox',
  'synthi_codesite_ack_event',
  'synthi_codesite_predict_collision',
  'synthi_codesite_shadow_merge_simulate',
  'synthi_codesite_report_counterfactual_run',
  'synthi_codesite_file_rfi',
  'synthi_codesite_file_change_order',
  'synthi_codesite_declare_mayday',
  'synthi_codesite_request_landing',
  'synthi_codesite_generate_black_box',
  'synthi_codesite_get_line_provenance',
];

export function codesiteSchemas() {
  return {
    'agent-session.schema.json': schema('AgentSession', {
      ownerUserId: { type: 'string' },
      agentProvider: { type: 'string' },
      agentRuntime: { type: ['string', 'null'] },
      displayCallsign: { type: 'string' },
      status: { type: 'string' },
      permissions: { type: 'array' },
      redactionPolicy: { type: 'object' },
      dojoPilotLicenseRef: { type: ['string', 'null'] },
      dojoProofRef: { type: ['string', 'null'] },
      dojoEvidenceRefs: { type: 'array', items: { type: 'string' } },
      dojoDecisionDigest: { type: ['string', 'null'] },
      pilotLicenseSnapshot: { type: ['object', 'null'] },
    }, ['ownerUserId', 'agentProvider', 'displayCallsign', 'status']),
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
    'clearance.schema.json': schema('Clearance', {
      executionPlanId: { type: 'string' },
      agentSessionId: { type: 'string' },
      displayCallsign: { type: 'string' },
      status: { type: 'string' },
      lease: { type: 'object' },
      dojoProofRef: { type: ['string', 'null'] },
      dojoLicenseRef: { type: ['string', 'null'] },
      dojoEvidenceRefs: { type: 'array', items: { type: 'string' } },
      dojoLedgerCheckpointHash: { type: ['string', 'null'] },
      dojoDecisionDigest: { type: ['string', 'null'] },
      implementationStatus: { type: 'object' },
    }, ['executionPlanId', 'agentSessionId', 'displayCallsign', 'status', 'lease']),
    'mutation-transaction.schema.json': schema('MutationTransaction', {
      mutationLeaseId: { type: 'string' },
      baseSnapshot: { type: 'string' },
      baseSnapshotEvidence: { type: ['object', 'null'] },
      isolation: { type: 'string', enum: ['serializable'] },
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
      eventType: { type: 'string', enum: CODE_SITE_EVENT_TYPES },
      displayCallsign: { type: ['string', 'null'] },
      logicalTime: { type: ['number', 'null'] },
      details: { type: 'object' },
      evidenceRefs: { type: 'array' },
    }, ['eventType', 'details']),
    'codesitefs-prewrite.schema.json': schema('CodeSiteFSPrewrite', {
      path: { type: 'string' },
      source: { type: 'string' },
      tool: { type: 'string' },
      disposition: { type: 'string', enum: ['write_allowed', 'write_denied', 'write_quarantined'] },
      reasonCodes: { type: 'array', items: { type: 'string' } },
      matchedLease: { type: ['object', 'null'] },
      policyDecision: { type: 'object' },
      processAncestry: { type: 'array', items: { type: 'string' } },
      evidenceRefs: { type: 'array', items: { type: 'string' } },
    }, ['path', 'source', 'tool', 'disposition', 'reasonCodes', 'policyDecision']),
    'inspection-run.schema.json': schema('InspectionRun', {
      executionPlanId: { type: ['string', 'null'] },
      displayCallsign: { type: 'string' },
      status: { type: 'string' },
      changedPaths: { type: 'array', items: { type: 'string' } },
      inspectionSignals: { type: 'array' },
      evidenceRefs: { type: 'array', items: { type: 'string' } },
    }, ['displayCallsign', 'status']),
    'incident.schema.json': schema('Incident', {
      severity: { type: 'string' },
      category: { type: 'string' },
      participants: { type: 'array' },
      affectedZones: { type: 'array', items: { type: 'string' } },
      incidentReplay: { type: 'object' },
      replayDigest: { type: 'string' },
      timelineEventRefs: { type: 'array', items: { type: 'string' } },
      policyDelta: { type: ['object', 'null'] },
      evidenceRefs: { type: 'array', items: { type: 'string' } },
    }, ['severity', 'category', 'replayDigest']),
    'incident-replay.schema.json': schema('IncidentReplay', {
      incidentId: { type: 'string' },
      replayDigest: { type: 'string' },
      event: { type: 'object' },
      source: { type: 'string' },
      sequence: { type: 'number' },
    }, ['incidentId', 'event', 'source', 'sequence']),
    'proof-bundle.schema.json': schema('ProofBundle', {
      schemaVersion: { type: 'string' },
      projectId: { type: 'string' },
      workspaceSlug: { type: ['string', 'null'] },
      transactionId: { type: 'string' },
      mutationLeaseId: { type: 'string' },
      displayCallsign: { type: ['string', 'null'] },
      landingStatus: { type: ['string', 'null'] },
      readSetDigest: { type: 'string' },
      writeSetDigest: { type: 'string' },
      invariants: { type: 'array' },
      evidenceRefs: { type: 'array' },
      dojoEvidenceRefs: { type: 'array' },
      repoState: { type: ['object', 'null'] },
      incidentReplayDigest: { type: ['string', 'null'] },
      bundleDigest: { type: ['string', 'null'] },
      incidents: { type: 'array' },
      lineProvenance: { type: 'array' },
      createdAt: { type: 'string' },
      portableDigest: { type: 'string' },
    }, ['schemaVersion', 'projectId', 'transactionId', 'mutationLeaseId', 'readSetDigest', 'writeSetDigest', 'invariants', 'evidenceRefs', 'portableDigest']),
    'line-provenance.schema.json': schema('LineProvenance', {
      filePath: { type: 'string' },
      lineAnchor: { type: 'string' },
      startLine: { type: ['number', 'null'] },
      endLine: { type: ['number', 'null'] },
      displayCallsign: { type: 'string' },
      reasonRef: { type: 'string' },
      evidenceRefs: { type: 'array', items: { type: 'string' } },
      dojoSourceRefs: { type: 'array', items: { type: 'string' } },
      proofBundleId: { type: ['string', 'null'] },
      processAncestry: { type: 'array' },
      promptSummary: { type: ['string', 'null'] },
    }, ['filePath', 'lineAnchor', 'displayCallsign']),
    'control-state.schema.json': schema('ControlState', {
      projectId: { type: 'string' },
      workspaceSlug: { type: 'string' },
      towerState: { type: 'string' },
      activeFlights: { type: 'array' },
      activeMutationLeases: { type: 'array' },
      activeTransactions: { type: 'array' },
      allowedPaths: { type: 'array', items: { type: 'string' } },
      blockedPaths: { type: 'array', items: { type: 'string' } },
      requiredActions: { type: 'array', items: { type: 'string' } },
      collisionForecast: { type: 'object' },
    }, ['projectId', 'workspaceSlug', 'towerState']),
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
      compiler_output: 'airspace/compiler-output.json',
      inbox_root: `${projectDir}/inbox/`,
      proof_bundle_root: `${projectDir}/proof-bundles/`,
      mcp_tools: CODESITE_MCP_TOOLS,
    }),
    jsonFile('airspace/zones.json', project.zonePolicy?.zones || []),
    jsonFile('airspace/no-fly-zones.json', project.zonePolicy?.noFlyZones || []),
    jsonFile('airspace/class-rules.json', project.zonePolicy?.classRules || {}),
    jsonFile('airspace/compiler-output.json', compilerOutput(project.zonePolicy || {})),
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
    const flightPlans = asArray(project.executionPlans).filter((item) => item.agentSessionId === session.id);
    const clearances = asArray(project.mutationLeases).filter((item) => item.agentSessionId === session.id);
    const transactions = asArray(project.mutationTxns).filter((item) => item.agentSessionId === session.id);
    const assumptions = asArray(project.assumptions).filter((item) => item.ownerSessionId === session.id);
    const inbox = asArray(project.inboxItems).filter((item) => item.agentSessionId === session.id);
    const events = eventsForSession(project.events, session, transactions, clearances);
    const landings = landingRunsForSession(project.inspectionRuns, session, flightPlans);
    const proofs = asArray(project.proofBundles).filter((proof) => transactions.some((txn) => txn.id === proof.transactionId));

    files.push(jsonFile(`${projectDir}/flights/${callsign}/agent-session.json`, session));
    files.push({
      relativePath: `${projectDir}/flights/${callsign}/transponder.jsonl`,
      content: events.map((event) => stableJson(event)).join('\n') + (events.length ? '\n' : ''),
    });
    files.push(jsonFile(`${projectDir}/flights/${callsign}/landing.json`, {
      displayCallsign: session.displayCallsign,
      inspections: landings,
      status: landings.some((run) => run.status === 'failed') ? 'go-around' : landings.at(-1)?.status || 'not-requested',
    }));
    for (const plan of flightPlans) {
      files.push(jsonFile(`${projectDir}/flights/${callsign}/flight-plan.json`, plan));
    }
    for (const lease of clearances) {
      files.push(jsonFile(`${projectDir}/flights/${callsign}/clearance.json`, lease));
    }
    for (const txn of transactions) {
      files.push(jsonFile(`${projectDir}/flights/${callsign}/transaction-${txn.id}.json`, txn));
    }
    if (transactions.length) {
      files.push(jsonFile(`${projectDir}/flights/${callsign}/transaction.json`, transactions.at(-1)));
    }
    files.push(jsonFile(`${projectDir}/flights/${callsign}/assumptions.json`, assumptions));
    files.push(jsonFile(`${projectDir}/flights/${callsign}/black-box.json`, {
      displayCallsign: session.displayCallsign,
      session,
      flightPlans,
      clearances,
      transactions,
      assumptions,
      inbox,
      events,
      inspections: landings,
      proofBundles: proofs,
    }));
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
      content: incidentReplayLines(project, incident).map((entry) => stableJson(entry)).join('\n') + '\n',
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
    const landings = transaction
      ? asArray(project.inspectionRuns).filter((run) => run.executionPlanId === mutationLease?.executionPlanId)
      : [];
    const portable = buildProofBundle({ project, transaction, mutationLease, proofBundle: proof, incidents: project.incidents, landingRuns: landings, lineProvenance });
    files.push(jsonFile(`${projectDir}/proof-bundles/${proof.id}.proof.json`, portable));
    files.push({
      relativePath: `${projectDir}/proof-bundles/${proof.id}.trailers.txt`,
      content: `${formatCommitTrailers(portable)}\n`,
    });
  }

  return files;
}

function compilerOutput(zonePolicy = {}) {
  return {
    schemaVersion: 'synthi.codesite.repoPolicyCompilerOutput.v1',
    compiler: zonePolicy.compiler || null,
    policyDigest: zonePolicy.policyDigest || zonePolicy.compiler?.policyDigest || null,
    policySources: zonePolicy.policySources || {},
    semanticGraph: zonePolicy.semanticGraph || {},
  };
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
  if (process.env.SYNTHI_CODESITE_DISABLE_ARTIFACT_WRITE === '1') return null;
  const root = process.env.SYNTHI_CODESITE_ARTIFACT_ROOT;
  if (root) {
    const safeSlug = safeSegment(workspaceSlug);
    return path.join(root, safeSlug, '.synthi', 'codesite');
  }
  return path.join(resolveRepoRootCandidate(), '.synthi', 'codesite');
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
  return enqueueArtifactWrite(root, async () => {
    const files = buildArtifactProjection(project, controlState);
    const currentPaths = new Set(files.map((file) => file.relativePath));
    const written = [];
    const manifest = files.filter((file) => file.relativePath === 'manifest.json');
    const bodyFiles = files.filter((file) => file.relativePath !== 'manifest.json');
    for (const file of bodyFiles) {
      await writeArtifactFile(root, file);
      written.push(file.relativePath);
    }
    await removeStaleProjectionFiles(root, currentPaths);
    for (const file of manifest) {
      await writeArtifactFile(root, file);
      written.push(file.relativePath);
    }
    await writeArtifactFile(root, jsonFile(ARTIFACT_FILE_INDEX, [...currentPaths].sort()));
    return { written: true, root, files: written };
  });
}

function enqueueArtifactWrite(root, task) {
  const previous = artifactWriteQueues.get(root) || Promise.resolve();
  let queued;
  queued = previous.catch(() => null).then(task).finally(() => {
    if (artifactWriteQueues.get(root) === queued) artifactWriteQueues.delete(root);
  });
  artifactWriteQueues.set(root, queued);
  return queued;
}

async function writeArtifactFile(root, file) {
  const target = path.resolve(root, file.relativePath);
  if (!isPathInside(root, target)) {
    throw new Error('codesite_artifact_path_escape');
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(tmp, file.content, 'utf8');
  await fs.rename(tmp, target);
}

async function removeStaleProjectionFiles(root, currentPaths) {
  const previous = await readProjectionFileIndex(root);
  for (const rel of previous) {
    if (currentPaths.has(rel)) continue;
    const target = path.resolve(root, rel);
    if (!isPathInside(root, target)) continue;
    await fs.rm(target, { force: true });
  }
}

async function readProjectionFileIndex(root) {
  try {
    const indexPath = path.join(root, ARTIFACT_FILE_INDEX);
    const parsed = JSON.parse(await fs.readFile(indexPath, 'utf8'));
    return asArray(parsed).map(String).filter(Boolean);
  } catch (_) {
    return [];
  }
}

function isPathInside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function resolveRepoRootCandidate() {
  const cwd = process.cwd();
  if (path.basename(cwd) === 'synthi') return path.dirname(cwd);
  return cwd;
}

function eventsForSession(events, session, transactions, clearances) {
  const transactionIds = new Set(transactions.map((txn) => txn.id));
  const clearanceIds = new Set(clearances.map((lease) => lease.id));
  return asArray(events).filter((event) => {
    const details = event.details || {};
    return event.displayCallsign === session.displayCallsign
      || event.actorId === session.id
      || transactionIds.has(details.transactionId)
      || clearanceIds.has(event.mutationLeaseId)
      || clearanceIds.has(details.mutationLeaseId);
  });
}

function landingRunsForSession(inspectionRuns, session, flightPlans) {
  const planIds = new Set(flightPlans.map((plan) => plan.id));
  return asArray(inspectionRuns).filter((run) => {
    return run.displayCallsign === session.displayCallsign || planIds.has(run.executionPlanId);
  });
}

function incidentReplayLines(project, incident) {
  const refs = new Set([
    ...asArray(incident.timelineEventRefs),
    ...asArray(incident.incidentReplay?.eventRefs),
    ...asArray(incident.incidentReplay?.events),
  ].filter(Boolean));
  const events = asArray(project.events).filter((event) => (
    refs.has(event.id)
    || refs.has(event.eventType)
    || asArray(incident.participants).includes(event.displayCallsign)
  ));
  const eventLines = events.map((event, index) => ({
    incidentId: incident.id,
    replayDigest: incident.replayDigest,
    sequence: index + 1,
    source: 'codesite_event',
    event,
  }));
  return [
    ...eventLines,
    {
      incidentId: incident.id,
      replayDigest: incident.replayDigest,
      sequence: eventLines.length + 1,
      source: 'incident_record',
      event: {
        severity: incident.severity,
        category: incident.category,
        affectedZones: incident.affectedZones,
        evidenceRefs: incident.evidenceRefs,
        replay: incident.incidentReplay,
        createdAt: incident.createdAt,
      },
    },
  ];
}

function safeSegment(value) {
  return String(value || 'unknown')
    .replace(/[^a-z0-9_.-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || 'unknown';
}
