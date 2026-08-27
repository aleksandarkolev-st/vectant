import fs from 'fs/promises';
import { getCodeSiteRuntimeConfig } from './runtimeConfig';
import path from 'path';
import crypto from 'crypto';
import { asArray, stableJson } from './json';
import { CODE_SITE_EVENT_TYPES } from './policy';
import { buildProofBundle, formatCommitTrailers } from './proof';
import { buildCodeSiteMetrics } from './metrics';
import { buildPilotLicenseHealthRecords, pilotLicenseHealthSummary } from './pilotLicense';
import { buildFilesystemBoundaryProofRecords } from './filesystemBoundaryProof';
import { projectKnowledgeRecord } from './knowledgeRecords';
import { safeKnowledgeProjection } from './knowledgePolicy';
import { loadExpertisePolicy } from './expertisePolicyRuntime';

export const CODESITE_ARTIFACT_VERSION = 1;
const ARTIFACT_FILE_INDEX = '.codesite-projection-files.json';
const ARTIFACT_PATH_HISTORY = 'artifact-path-history.jsonl';
const DEFAULT_ARTIFACT_PATH_HISTORY_MAX_BYTES = 4 * 1024 * 1024;
const artifactWriteQueues = new Map();
const ACTIVE_EXPERTISE_POLICY = loadExpertisePolicy();

export const CODESITE_MCP_TOOLS = [
  'synthi_codesite_list_projects',
  'synthi_codesite_create_project',
  'synthi_codesite_get_project',
  'synthi_codesite_update_zone_policy',
  'synthi_codesite_update_control_plan',
  'synthi_codesite_register_agent_session',
  'synthi_codesite_list_project_members',
  'synthi_codesite_upsert_project_member',
  'synthi_codesite_revoke_project_member',
  'synthi_codesite_file_flight_plan',
  'synthi_codesite_request_clearance',
  'synthi_codesite_open_transaction',
  'synthi_codesite_abort_transaction',
  'synthi_codesite_revoke_clearance',
  'synthi_codesite_record_policy_decision',
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
  'synthi_codesite_get_metrics',
  'synthi_codesite_get_agent_manifest',
  'synthi_codesite_get_relevant_context',
  'synthi_codesite_record_discovery',
  'synthi_codesite_record_lead',
  'synthi_codesite_publish_shared_skill',
  'synthi_codesite_file_handoff',
  'synthi_codesite_get_shared_knowledge',
  'synthi_codesite_respond_impact_notice',
  'synthi_codesite_get_schemas',
  'synthi_codesite_get_active_state',
  'synthi_codesite_list_active_transactions',
  'synthi_codesite_next_event',
  'synthi_codesite_get_inbox',
  'synthi_codesite_ack_event',
  'synthi_codesite_predict_collision',
  'synthi_codesite_shadow_merge_simulate',
  'synthi_codesite_report_counterfactual_run',
  'synthi_codesite_file_rfi',
  'synthi_codesite_file_change_order',
  'synthi_codesite_list_permits',
  'synthi_codesite_issue_permit',
  'synthi_codesite_review_document',
  'synthi_codesite_list_route_revisions',
  'synthi_codesite_propose_route_revision',
  'synthi_codesite_review_route_revision',
  'synthi_codesite_apply_route_revision',
  'synthi_codesite_declare_mayday',
  'synthi_codesite_get_incident_replay',
  'synthi_codesite_resume_mayday',
  'synthi_codesite_file_policy_delta',
  'synthi_codesite_promote_policy_delta',
  'synthi_codesite_reject_policy_delta',
  'synthi_codesite_request_landing',
  'synthi_codesite_complete_landing',
  'synthi_codesite_generate_black_box',
  'synthi_codesite_preview_artifacts',
  'synthi_codesite_get_proof_bundle',
  'synthi_codesite_attach_proof_bundle_commit',
  'synthi_codesite_get_line_provenance',
  'synthi_codesite_review_quarantine',
  'synthi_codesite_replay_quarantine',
  'synthi_codesite_apply_quarantine',
];

export function codesiteSchemas() {
  return {
    'agent-session.schema.json': schema('AgentSession', {
      ownerUserId: { type: 'string' },
      agentProvider: { type: 'string' },
      agentRuntime: { type: ['string', 'null'] },
      providerSessionBound: { type: 'boolean' },
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
      pilotLicenseHealth: { type: ['object', 'null'] },
      pilotLicenseRequirement: { type: ['object', 'null'] },
    }, ['executionPlanId', 'agentSessionId', 'displayCallsign', 'status', 'lease']),
    'pilot-license-health.schema.json': schema('PilotLicenseHealth', {
      schemaVersion: { type: 'string' },
      key: { type: 'string' },
      agentSessionId: { type: ['string', 'null'] },
      displayCallsign: { type: ['string', 'null'] },
      status: { type: 'string' },
      level: { type: 'string' },
      levelRank: { type: 'number' },
      dojoPilotLicenseRef: { type: ['string', 'null'] },
      dojoLicenseRef: { type: ['string', 'null'] },
      dojoProofRef: { type: ['string', 'null'] },
      repoScope: { type: ['string', 'null'] },
      authorizedAirspace: { type: 'array', items: { type: 'string' } },
      restrictedAirspace: { type: 'array', items: { type: 'string' } },
      requiredRadar: { type: 'array', items: { type: 'string' } },
      earnedBy: { type: 'array' },
      sourceDrift: { type: 'object' },
      landingStats: { type: 'object' },
      violationStats: { type: 'object' },
      reasonCodes: { type: 'array', items: { type: 'string' } },
      requiredAction: { type: ['string', 'null'] },
      evidenceRefs: { type: 'array', items: { type: 'string' } },
      lifecycle: { type: 'object' },
    }, ['schemaVersion', 'key', 'status', 'level']),
    'mutation-transaction.schema.json': schema('MutationTransaction', {
      mutationLeaseId: { type: 'string' },
      baseSnapshot: { type: 'string' },
      baseSnapshotEvidence: {
        type: ['object', 'null'],
        properties: {
          scope: { type: 'string', enum: ['read_set', 'repo_wide'] },
          snapshotDigest: { type: 'string' },
          evidenceDigest: { type: 'string' },
          repoManifestDigest: { type: ['string', 'null'] },
          repoManifestFileCount: { type: 'number' },
          repoManifestScannedEntries: { type: 'number' },
          repoManifestTruncated: { type: 'boolean' },
          repoManifestSkippedPaths: { type: 'array' },
          readSet: { type: 'array', items: { type: 'string' } },
          fileDigests: { type: 'array' },
          skippedPaths: { type: 'array' },
          truncated: { type: 'boolean' },
        },
      },
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
    'filesystem-boundary-proof.schema.json': schema('FilesystemBoundaryProof', {
      schemaVersion: { type: 'string' },
      proofId: { type: 'string' },
      projectId: { type: ['string', 'null'] },
      workspaceSlug: { type: ['string', 'null'] },
      eventId: { type: ['string', 'null'] },
      policyDecisionId: { type: ['string', 'null'] },
      eventType: { type: 'string' },
      disposition: { type: 'string', enum: ['write_denied', 'write_quarantined'] },
      prevented: { type: 'boolean' },
      quarantined: { type: 'boolean' },
      path: { type: 'string' },
      transactionId: { type: ['string', 'null'] },
      mutationLeaseId: { type: ['string', 'null'] },
      requestedMutationLeaseId: { type: ['string', 'null'] },
      inspectedLeases: { type: 'array' },
      displayCallsign: { type: ['string', 'null'] },
      leaseState: { type: 'string' },
      lease: { type: ['object', 'null'] },
      reasonCodes: { type: 'array', items: { type: 'string' } },
      reason: { type: 'string' },
      zone: { type: ['object', 'null'] },
      boundary: { type: 'object' },
      process: { type: 'object' },
      evidence: { type: 'object' },
      evidenceRefs: { type: 'array', items: { type: 'string' } },
      quarantine: { type: ['object', 'null'] },
      proofComplete: { type: 'boolean' },
      missingProofFields: { type: 'array', items: { type: 'string' } },
      createdAt: { type: ['string', 'null'] },
    }, ['schemaVersion', 'proofId', 'eventType', 'disposition', 'path', 'leaseState', 'reasonCodes', 'evidenceRefs', 'proofComplete']),
    'codesitefs-quarantine.schema.json': schema('CodeSiteFSQuarantine', {
      quarantineId: { type: 'string' },
      workspaceSlug: { type: ['string', 'null'] },
      projectId: { type: ['string', 'null'] },
      transactionId: { type: ['string', 'null'] },
      mutationLeaseId: { type: ['string', 'null'] },
      displayCallsign: { type: ['string', 'null'] },
      status: { type: 'string' },
      paths: { type: 'array', items: { type: 'string' } },
      changes: { type: 'array' },
      lifecycle: { type: 'object' },
      rejected: { type: 'array' },
      applied: { type: 'array' },
      appliedPaths: { type: 'array', items: { type: 'string' } },
      remainingPaths: { type: 'array', items: { type: 'string' } },
      latestReplayAttempt: { type: ['object', 'null'] },
      replayAttempts: { type: 'array' },
      successfulReplay: { type: ['object', 'null'] },
      evidenceRefs: { type: 'array', items: { type: 'string' } },
      eventRefs: { type: 'array', items: { type: 'string' } },
      symlinkSanitization: { type: ['object', 'null'] },
    }, ['quarantineId', 'status', 'paths', 'changes', 'lifecycle', 'evidenceRefs']),
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
      baseSnapshot: { type: ['string', 'null'] },
      baseSnapshotEvidence: { type: ['object', 'null'] },
      incidentReplayDigest: { type: ['string', 'null'] },
      bundleDigest: { type: ['string', 'null'] },
      incidents: { type: 'array' },
      lineProvenance: { type: 'array' },
      createdAt: { type: 'string' },
      portableDigest: { type: 'string' },
      proofSignature: { type: 'object' },
    }, ['schemaVersion', 'projectId', 'transactionId', 'mutationLeaseId', 'readSetDigest', 'writeSetDigest', 'invariants', 'evidenceRefs', 'portableDigest', 'proofSignature']),
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
      pendingQuarantines: { type: 'array' },
      pilotLicenseHealth: { type: 'array' },
      pilotLicenseSummary: { type: 'object' },
      filesystemBoundaryProofs: { type: 'array' },
      requiredActions: { type: 'array', items: { type: 'string' } },
      collisionForecast: { type: 'object' },
    }, ['projectId', 'workspaceSlug', 'towerState']),
    'shared-knowledge-summary.schema.json': {
      ...schema('SharedKnowledgeSummary', {
        schemaVersion: { type: 'string', const: 'synthi.codesite.sharedKnowledgeSummary.v1' },
        id: { type: ['string', 'null'] },
        projectId: { type: 'string' },
        kind: { enum: ['discovery', 'lead', 'shared_skill', 'handoff'] },
        status: { type: 'string' },
        title: { type: 'string' },
        summary: { type: 'string' },
        confidence: { type: ['number', 'null'], minimum: 0, maximum: 1 },
        source: {
          type: 'object',
          properties: {
            actorType: { type: 'string' },
            actorId: { type: 'string' },
            agentSessionId: { type: ['string', 'null'] },
          },
          additionalProperties: false,
        },
        references: {
          type: 'object',
          properties: {
            paths: { type: 'array', items: { type: 'string' } },
            symbols: { type: 'array', items: { type: 'string' } },
            contracts: { type: 'array', items: { type: 'string' } },
            runtimeSessionIds: { type: 'array', items: { type: 'string' } },
            agentSessionIds: { type: 'array', items: { type: 'string' } },
            workstreamIds: { type: 'array', items: { type: 'string' } },
            transactionIds: { type: 'array', items: { type: 'string' } },
          },
          additionalProperties: false,
        },
        createdAt: { type: ['string', 'null'] },
        updatedAt: { type: ['string', 'null'] },
      }, ['schemaVersion', 'projectId', 'kind', 'status', 'title', 'summary', 'references']),
      additionalProperties: false,
    },
    'metrics.schema.json': schema('Metrics', {
      schemaVersion: { type: 'string' },
      projectId: { type: ['string', 'null'] },
      workspaceSlug: { type: ['string', 'null'] },
      generatedAt: { type: 'string' },
      sections: { type: 'object' },
      summary: { type: 'object' },
      evidence: { type: 'object' },
    }, ['schemaVersion', 'projectId', 'sections', 'summary']),
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

const REPO_SHARED_KNOWLEDGE_KINDS = new Set(['discovery', 'lead', 'shared_skill', 'handoff']);
const REPO_SHARED_KNOWLEDGE_REFERENCE_KEYS = [
  'paths',
  'symbols',
  'contracts',
  'runtimeSessionIds',
  'agentSessionIds',
  'workstreamIds',
  'transactionIds',
];
const PRIVATE_KNOWLEDGE_LITERAL = /(?:providerSessionRef|privatePrompt|terminalTranscript|chainOfThought|(?:api[-_ ]?)?token|credential|cookie|privateKey|environmentValue|accountState)\s*[:=]/i;
const PRIVATE_KEY_MATERIAL = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;

function repoKnowledgeProjection(item) {
  try {
    // Artifact sync projects persisted rows, so preserve an already-stored
    // unrouted question instead of rejecting historical facts during resync.
    const storedItem = item?.kind === 'agent_question' ? { ...item, allowUnrouted: true } : item;
    const projected = storedItem?.payloadJson != null || storedItem?.scopeJson != null
      ? projectKnowledgeRecord(storedItem, ACTIVE_EXPERTISE_POLICY)
      : safeKnowledgeProjection(storedItem, ACTIVE_EXPERTISE_POLICY);
    if (!projected
      || projected.visibility !== 'project'
      || projected.redactionClass === 'owner_private'
      || !REPO_SHARED_KNOWLEDGE_KINDS.has(projected.kind)) {
      return null;
    }
    if (PRIVATE_KNOWLEDGE_LITERAL.test(projected.title)
      || PRIVATE_KNOWLEDGE_LITERAL.test(projected.summary)
      || PRIVATE_KEY_MATERIAL.test(projected.summary)) {
      return null;
    }
    const references = Object.fromEntries(REPO_SHARED_KNOWLEDGE_REFERENCE_KEYS.map((key) => [
      key,
      asArray(projected.references?.[key]).map((value) => String(value)),
    ]));
    return {
      schemaVersion: 'synthi.codesite.sharedKnowledgeSummary.v1',
      id: projected.id || null,
      projectId: projected.projectId,
      kind: projected.kind,
      status: projected.status,
      title: projected.title,
      summary: projected.summary,
      confidence: projected.confidence ?? null,
      source: {
        actorType: projected.source.actorType,
        actorId: projected.source.actorId,
        agentSessionId: projected.source.agentSessionId || null,
      },
      references,
      createdAt: projected.createdAt || null,
      updatedAt: projected.updatedAt || null,
    };
  } catch (_) {
    return null;
  }
}

export function buildSharedKnowledgeRepoProjection(knowledgeItems = []) {
  return asArray(knowledgeItems)
    .map(repoKnowledgeProjection)
    .filter(Boolean)
    .sort((left, right) => (
      String(left.createdAt || '').localeCompare(String(right.createdAt || ''))
      || String(left.id || '').localeCompare(String(right.id || ''))
    ));
}

export function buildArtifactProjection(project, controlState = null) {
  const projectDir = `projects/${project.id}`;
  const pilotLicenseHealth = asArray(controlState?.pilotLicenseHealth).length
    ? asArray(controlState.pilotLicenseHealth)
    : buildPilotLicenseHealthRecords(project);
  const metrics = buildCodeSiteMetrics({ project, controlState: controlState || minimalControlState(project), workspaceSlug: project.workspaceSlug });
  const quarantines = quarantineReviewRecords(project);
  const filesystemBoundaryProofs = buildFilesystemBoundaryProofRecords(project);
  const sharedKnowledge = buildSharedKnowledgeRepoProjection(project.knowledgeItems);
  const files = [
    jsonFile('manifest.json', {
      version: CODESITE_ARTIFACT_VERSION,
      project_id: project.id,
      workspace_slug: project.workspaceSlug,
      control_state: `${projectDir}/control-state.json`,
      metrics: `${projectDir}/metrics.json`,
      events: `${projectDir}/events.jsonl`,
      schemas: 'schemas/',
      compiler_output: 'airspace/compiler-output.json',
      pilot_license_health: `${projectDir}/pilot-license-health.json`,
      quarantine_root: `${projectDir}/quarantines/`,
      quarantine_index: `${projectDir}/quarantines/index.jsonl`,
      filesystem_boundary_proof: `${projectDir}/filesystem-boundary-proof.json`,
      filesystem_boundary_proof_index: `${projectDir}/filesystem-boundary-proofs/index.jsonl`,
      proof_bundle_root: `${projectDir}/proof-bundles/`,
      shared_knowledge: `${projectDir}/knowledge/index.jsonl`,
      shared_knowledge_schema: 'schemas/shared-knowledge-summary.schema.json',
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
    jsonFile(`${projectDir}/pilot-license-health.json`, {
      schemaVersion: 'synthi.codesite.pilotLicenseHealth.index.v1',
      summary: pilotLicenseHealthSummary(pilotLicenseHealth),
      records: pilotLicenseHealth,
    }),
    jsonFile(`${projectDir}/metrics.json`, metrics),
    {
      relativePath: `${projectDir}/events.jsonl`,
      content: asArray(project.events).map((event) => stableJson(event)).join('\n') + (project.events?.length ? '\n' : ''),
    },
    {
      relativePath: `${projectDir}/knowledge/index.jsonl`,
      content: sharedKnowledge.map((item) => stableJson(item)).join('\n')
        + (sharedKnowledge.length ? '\n' : ''),
    },
    {
      relativePath: `${projectDir}/quarantines/index.jsonl`,
      content: quarantines.map((record) => stableJson(record)).join('\n') + (quarantines.length ? '\n' : ''),
    },
    jsonFile(`${projectDir}/filesystem-boundary-proof.json`, {
      schemaVersion: 'synthi.codesite.filesystemBoundaryProof.index.v1',
      summary: {
        total: filesystemBoundaryProofs.length,
        denied: filesystemBoundaryProofs.filter((record) => record.disposition === 'write_denied').length,
        quarantined: filesystemBoundaryProofs.filter((record) => record.disposition === 'write_quarantined').length,
        complete: filesystemBoundaryProofs.filter((record) => record.proofComplete).length,
        incomplete: filesystemBoundaryProofs.filter((record) => !record.proofComplete).length,
      },
      records: filesystemBoundaryProofs,
    }),
    {
      relativePath: `${projectDir}/filesystem-boundary-proofs/index.jsonl`,
      content: filesystemBoundaryProofs.map((record) => stableJson(record)).join('\n') + (filesystemBoundaryProofs.length ? '\n' : ''),
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
    const sharedSession = sharedAgentSessionProjection(session);
    const callsign = safeSegment(session.displayCallsign);
    const flightPlans = asArray(project.executionPlans).filter((item) => item.agentSessionId === session.id);
    const clearances = asArray(project.mutationLeases).filter((item) => item.agentSessionId === session.id);
    const transactions = asArray(project.mutationTxns).filter((item) => item.agentSessionId === session.id);
    const assumptions = asArray(project.assumptions).filter((item) => item.ownerSessionId === session.id);
    const events = eventsForSession(project.events, session, transactions, clearances);
    const landings = landingRunsForSession(project.inspectionRuns, session, flightPlans);
    const proofs = asArray(project.proofBundles).filter((proof) => transactions.some((txn) => txn.id === proof.transactionId));
    const pilotHealth = pilotLicenseHealth.find((record) => (
      record.agentSessionId === session.id
      || record.displayCallsign === session.displayCallsign
    )) || null;
    const sessionQuarantines = quarantines.filter((record) => (
      record.displayCallsign === session.displayCallsign
      || transactions.some((txn) => txn.id === record.transactionId)
      || clearances.some((lease) => lease.id === record.mutationLeaseId)
    ));
    const sessionFilesystemBoundaryProofs = filesystemBoundaryProofs.filter((record) => (
      record.displayCallsign === session.displayCallsign
      || transactions.some((txn) => txn.id === record.transactionId)
      || clearances.some((lease) => (
        lease.id === record.mutationLeaseId
        || lease.id === record.requestedMutationLeaseId
        || asArray(record.inspectedLeases).some((inspected) => inspected.mutationLeaseId === lease.id)
      ))
    ));
    const sessionIncidents = incidentsForSession(project.incidents, session, transactions, proofs);

    files.push(jsonFile(`${projectDir}/flights/${callsign}/agent-session.json`, sharedSession));
    files.push(jsonFile(`${projectDir}/flights/${callsign}/pilot-license-health.json`, pilotHealth));
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
      files.push(jsonFile(`${projectDir}/flight-plans/${plan.id}.json`, plan));
      files.push(jsonFile(`${projectDir}/flights/${callsign}/flight-plans/${plan.id}.json`, plan));
      files.push(jsonFile(`${projectDir}/flights/${callsign}/flight-plan.json`, plan));
    }
    for (const lease of clearances) {
      files.push(jsonFile(`${projectDir}/clearances/${lease.id}.json`, lease));
      files.push(jsonFile(`${projectDir}/flights/${callsign}/clearances/${lease.id}.json`, lease));
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
      session: sharedSession,
      flightPlans,
      clearances,
      transactions,
      assumptions,
      events,
      inspections: landings,
      pilotLicenseHealth: pilotHealth,
      proofBundles: proofs,
      quarantines: sessionQuarantines,
      filesystemBoundaryProofs: sessionFilesystemBoundaryProofs,
      causalReplays: sessionIncidents.map((incident) => incidentHandoverSummary(project, incident)),
    }));
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

  for (const quarantine of quarantines) {
    files.push(jsonFile(`${projectDir}/quarantines/${safeSegment(quarantine.quarantineId)}.json`, quarantine));
  }

  for (const proof of filesystemBoundaryProofs) {
    files.push(jsonFile(`${projectDir}/filesystem-boundary-proofs/${safeSegment(proof.proofId)}.json`, proof));
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
    const incidents = proofBundleScopedIncidents(project, proof);
    const portable = buildProofBundle({ project, transaction, mutationLease, proofBundle: proof, incidents, landingRuns: landings, lineProvenance });
    files.push(jsonFile(`${projectDir}/proof-bundles/${proof.id}.proof.json`, portable));
    files.push({
      relativePath: `${projectDir}/proof-bundles/${proof.id}.trailers.txt`,
      content: `${formatCommitTrailers(portable)}\n`,
    });
  }

  return files;
}

function proofBundleScopedIncidents(project, proof) {
  return asArray(project.incidents).filter((incident) => artifactIncidentReferencesProofBundle(incident, proof));
}

function artifactIncidentReferencesProofBundle(incident, proof) {
  if (!incident || !proof) return false;
  const replay = incident.incidentReplay || incident.incident_replay || {};
  const evidenceRefs = asArray(incident.evidenceRefs || incident.evidence_refs);
  const proofBundleRef = `codesite:proof-bundle:${proof.id}`;
  return evidenceRefs.includes(proofBundleRef)
    || replay.proofBundle?.id === proof.id
    || replay.proofBundleId === proof.id
    || replay.proof_bundle_id === proof.id
    || replay.handover?.proofBundleId === proof.id
    || replay.handover?.proof_bundle_id === proof.id
    || (proof.incidentReplayDigest && incident.replayDigest === proof.incidentReplayDigest)
    || (incident.category === 'black_box' && replay.transactionId === proof.transactionId);
}

export function quarantineReviewRecords(project = {}) {
  const records = new Map();
  const lifecycleTypes = new Set(['quarantine_reviewed', 'quarantine_replayed', 'quarantine_applied']);
  const relevantEvents = asArray(project.events).filter((event) => (
    event?.eventType === 'write_quarantined'
    || lifecycleTypes.has(event?.eventType)
  ));

  for (const event of relevantEvents) {
    const details = event.details || {};
    const codesiteFsEvent = details.codesiteFsEvent || details.codesite_fs_event || {};
    const fsDetails = codesiteFsEvent.details || {};
    const evidence = details.quarantineEvidence
      || details.quarantine_evidence
      || fsDetails.quarantineEvidence
      || fsDetails.quarantine_evidence
      || {};
    const quarantineId = quarantineEventId(event, details, fsDetails, evidence);
    const record = records.get(quarantineId) || {
      schemaVersion: 'synthi.codesite.codesitefs.quarantine.v1',
      quarantineId,
      workspaceSlug: project.workspaceSlug || null,
      projectId: project.id || null,
      transactionId: details.transactionId || details.transaction_id || codesiteFsEvent.transaction_id || null,
      mutationLeaseId: event.mutationLeaseId || details.mutationLeaseId || details.mutation_lease_id || null,
      displayCallsign: event.displayCallsign || null,
      status: 'reviewable',
      paths: [],
      changes: [],
      lifecycle: {
        capturedAt: null,
        reviewedAt: null,
        replayedAt: null,
        appliedAt: null,
      },
      rejected: [],
      applied: [],
      appliedPaths: [],
      remainingPaths: [],
      latestReplayAttempt: null,
      replayAttempts: [],
      successfulReplay: null,
      eventRefs: [],
      evidenceRefs: [],
      symlinkSanitization: null,
      createdAt: event.createdAt || null,
      updatedAt: event.createdAt || null,
    };

    record.eventRefs = appendUnique(record.eventRefs, event.id);
    record.evidenceRefs = appendUnique(record.evidenceRefs, [
      ...asArray(event.evidenceRefs),
      ...asArray(details.evidenceRefs || details.evidence_refs),
      ...asArray(codesiteFsEvent.evidence_refs || codesiteFsEvent.evidenceRefs),
      evidence.evidenceRef,
      ...(asArray(evidence.evidenceRefs || evidence.evidence_refs)),
    ]);
    const manifestPaths = asArray(details.manifestPaths || details.manifest_paths).filter(Boolean);
    const manifestChanges = asArray(details.manifestChanges || details.manifest_changes)
      .map(quarantineChangeFromManifest)
      .filter((change) => change.path);
    record.paths = appendUnique(record.paths, [
      details.path,
      codesiteFsEvent.path,
      evidence.path,
      ...asArray(details.paths || details.changedPaths || details.changed_paths),
      ...manifestPaths,
    ].filter(Boolean));
    for (const change of manifestChanges) {
      record.changes = upsertByKey(record.changes, change, (item) => item.evidenceRef || `${item.path}:${item.afterDigest || item.kind}`);
    }
    const manifestSymlinkSanitization = details.symlinkSanitization || details.symlink_sanitization;
    if (manifestSymlinkSanitization) {
      record.symlinkSanitization = record.symlinkSanitization || manifestSymlinkSanitization;
    }
    record.transactionId = record.transactionId || details.transactionId || details.transaction_id || null;
    record.mutationLeaseId = record.mutationLeaseId || event.mutationLeaseId || details.mutationLeaseId || details.mutation_lease_id || null;
    record.displayCallsign = record.displayCallsign || event.displayCallsign || null;
    record.updatedAt = laterIso(record.updatedAt, event.createdAt);

    if (event.eventType === 'write_quarantined') {
      record.lifecycle.capturedAt = record.lifecycle.capturedAt || event.createdAt || null;
      record.status = record.status === 'applied' ? record.status : 'reviewable';
      const change = quarantineChangeFromEvent(event, details, codesiteFsEvent, evidence);
      if (change.path) {
        record.changes = upsertByKey(record.changes, change, (item) => item.evidenceRef || `${item.path}:${item.afterDigest || item.kind}`);
      }
      if (fsDetails.symlinkSanitization || fsDetails.symlink_sanitization || details.symlinkSanitization || details.symlink_sanitization) {
        record.symlinkSanitization = fsDetails.symlinkSanitization
          || fsDetails.symlink_sanitization
          || details.symlinkSanitization
          || details.symlink_sanitization;
      }
    } else if (event.eventType === 'quarantine_reviewed') {
      record.lifecycle.reviewedAt = record.lifecycle.reviewedAt || event.createdAt || null;
      record.status = record.status === 'applied' ? record.status : 'reviewed';
      record.review = {
        selectedChangeCount: details.selectedChangeCount ?? null,
        replayableChangeCount: details.replayableChangeCount ?? null,
        rejectedChangeCount: details.rejectedChangeCount ?? null,
      };
    } else if (event.eventType === 'quarantine_replayed') {
      const replayAttempt = quarantineReplayAttemptFromEvent(event, details);
      record.latestReplayAttempt = replayAttempt;
      record.replayAttempts = appendUniqueObjects(record.replayAttempts, [replayAttempt]);
      record.rejected = appendUniqueObjects(record.rejected, asArray(details.rejected || event.rejected));
      if (isSuccessfulQuarantineReplay(replayAttempt)) {
        if (isReplayAttemptBeforeApply(replayAttempt, record.lifecycle)) {
          record.lifecycle.replayedAt = replayAttempt.attemptedAt || record.lifecycle.replayedAt || null;
          record.replay = replayAttempt;
          record.successfulReplay = replayAttempt;
        } else if (!record.successfulReplay) {
          record.replay = replayAttempt;
          record.successfulReplay = replayAttempt;
        }
        record.status = record.status === 'applied' ? record.status : 'replayed';
      } else if (record.status !== 'applied' && record.status !== 'replayed') {
        record.status = 'blocked';
      }
    } else if (event.eventType === 'quarantine_applied') {
      record.lifecycle.appliedAt = event.createdAt || record.lifecycle.appliedAt;
      record.applied = appendUniqueObjects(record.applied, asArray(details.applied));
      record.boundaryPhase = details.boundaryPhase || null;
    }

    records.set(quarantineId, record);
  }

  return [...records.values()].map(finalizeQuarantineRecord).sort((left, right) => (
    String(right.updatedAt || right.createdAt || '').localeCompare(String(left.updatedAt || left.createdAt || ''))
  ));
}

function finalizeQuarantineRecord(record) {
  const paths = appendUnique(record.paths, asArray(record.changes).map((change) => change.path));
  const applied = asArray(record.applied);
  const appliedPaths = appendUnique([], applied.map((change) => change.path));
  const remainingPaths = paths.filter((item) => !appliedPaths.includes(item));
  let status = record.status;
  if (appliedPaths.length > 0) {
    status = remainingPaths.length > 0 ? 'partially_applied' : 'applied';
  }
  return {
    ...record,
    status,
    paths,
    applied,
    appliedPaths,
    remainingPaths,
  };
}

function quarantineEventId(event, details = {}, fsDetails = {}, evidence = {}) {
  return String(
    details.quarantineId
    || details.quarantine_id
    || fsDetails.quarantineId
    || fsDetails.quarantine_id
    || evidence.quarantineId
    || evidence.quarantine_id
    || event.actorId
    || evidence.evidenceRef
    || event.id
    || 'unknown-quarantine'
  );
}

function quarantineChangeFromEvent(event, details = {}, codesiteFsEvent = {}, evidence = {}) {
  return {
    path: normalizeRecordPath(evidence.path || details.path || codesiteFsEvent.path),
    kind: evidence.kind || details.changeKind || details.change_kind || codesiteFsEvent.kind || 'modified',
    evidenceRef: evidence.evidenceRef || asArray(event.evidenceRefs)[0] || null,
    beforeDigest: evidence.beforeDigest || evidence.before_digest || null,
    afterDigest: evidence.afterDigest || evidence.after_digest || null,
    currentDigest: evidence.currentDigest || evidence.current_digest || null,
    expectedDigest: evidence.expectedDigest || evidence.expected_digest || null,
    beforeSize: evidence.beforeSize ?? evidence.before_size ?? null,
    afterSize: evidence.afterSize ?? evidence.after_size ?? null,
    lineProvenanceCount: asArray(details.lineProvenance || details.line_provenance).length,
  };
}

function quarantineChangeFromManifest(change = {}) {
  const evidence = change.quarantineEvidence || change.quarantine_evidence || {};
  return {
    path: normalizeRecordPath(change.path || evidence.path),
    kind: change.kind || evidence.kind || 'modified',
    evidenceRef: change.evidenceRef || change.evidence_ref || evidence.evidenceRef || evidence.evidence_ref || null,
    beforeDigest: change.beforeDigest || change.before_digest || evidence.beforeDigest || evidence.before_digest || null,
    afterDigest: change.afterDigest || change.after_digest || evidence.afterDigest || evidence.after_digest || null,
    currentDigest: change.currentDigest || change.current_digest || evidence.currentDigest || evidence.current_digest || null,
    expectedDigest: change.expectedDigest || change.expected_digest || evidence.expectedDigest || evidence.expected_digest || null,
    beforeSize: change.beforeSize ?? change.before_size ?? evidence.beforeSize ?? evidence.before_size ?? null,
    afterSize: change.afterSize ?? change.after_size ?? evidence.afterSize ?? evidence.after_size ?? null,
    lineProvenanceCount: asArray(change.lineProvenance || change.line_provenance).length,
  };
}

function quarantineReplayAttemptFromEvent(event, details = {}) {
  return {
    attemptedAt: event.createdAt || null,
    selectedChangeCount: details.selectedChangeCount ?? null,
    replayableChangeCount: details.replayableChangeCount ?? null,
    rejectedChangeCount: details.rejectedChangeCount ?? null,
    paths: asArray(details.paths || details.selectedPaths || details.selected_paths),
    replayablePaths: asArray(details.replay || details.replayable || details.prepared).map((item) => item.path).filter(Boolean),
    rejectedPaths: asArray(details.rejected).map((item) => item.path).filter(Boolean),
  };
}

function isSuccessfulQuarantineReplay(attempt = {}) {
  return Number(attempt.replayableChangeCount || 0) > 0 && Number(attempt.rejectedChangeCount || 0) === 0;
}

function isReplayAttemptBeforeApply(attempt = {}, lifecycle = {}) {
  if (!lifecycle.appliedAt) return true;
  const attemptedAt = Date.parse(attempt.attemptedAt || '');
  const appliedAt = Date.parse(lifecycle.appliedAt);
  if (Number.isNaN(attemptedAt) || Number.isNaN(appliedAt)) return false;
  return attemptedAt <= appliedAt;
}

function normalizeRecordPath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');
}

function appendUnique(current, values) {
  const next = [...asArray(current)];
  for (const value of asArray(values)) {
    if (value == null || value === '') continue;
    const stringValue = String(value);
    if (!next.includes(stringValue)) next.push(stringValue);
  }
  return next;
}

function unique(values) {
  return [...new Set(asArray(values).filter(Boolean).map((value) => String(value)))];
}

function appendUniqueObjects(current, values) {
  const next = [...asArray(current)];
  const seen = new Set(next.map((item) => stableJson(item)));
  for (const value of asArray(values)) {
    const key = stableJson(value);
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(value);
  }
  return next;
}

function upsertByKey(items, item, keyOf) {
  const key = keyOf(item);
  const next = asArray(items).filter((existing) => keyOf(existing) !== key);
  next.push(item);
  return next;
}

function laterIso(left, right) {
  if (!right) return left || null;
  if (!left) return right;
  return Date.parse(right) > Date.parse(left) ? right : left;
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
  const pilotLicenseHealth = buildPilotLicenseHealthRecords(project);
  const filesystemBoundaryProofs = buildFilesystemBoundaryProofRecords(project);
  return {
    projectId: project.id,
    workspaceSlug: project.workspaceSlug,
    towerState: project.status,
    activeFlights: asArray(project.executionPlans).filter((plan) => plan.status !== 'closed'),
    activeMutationLeases: asArray(project.mutationLeases).filter((lease) => lease.status === 'active'),
    pilotLicenseHealth,
    pilotLicenseSummary: pilotLicenseHealthSummary(pilotLicenseHealth),
    filesystemBoundaryProofs,
    requiredActions: [],
  };
}

function handoverMarkdown(project, controlState) {
  const forecast = controlState?.collisionForecast;
  const replaySummaries = asArray(project.incidents)
    .filter((incident) => incident.replayDigest || incident.incidentReplay)
    .map((incident) => incidentHandoverSummary(project, incident));
  const proofSummaries = asArray(project.proofBundles).map((proof) => {
    const transaction = asArray(project.mutationTxns).find((item) => item.id === proof.transactionId);
    const replay = replaySummaries.find((item) => (
      item.replayDigest && item.replayDigest === proof.incidentReplayDigest
    )) || null;
    return {
      proof,
      transaction,
      replay,
      blackBoxTrailer: proof.trailers?.['CodeSite-Black-Box'] || proof.incidentReplayDigest || proof.bundleDigest,
    };
  });
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
    '## Proof-Carrying Commits',
    '',
  ];
  if (proofSummaries.length === 0) {
    lines.push('- No proof bundles exported yet.');
  }
  for (const item of proofSummaries) {
    lines.push(`- ${item.proof.id}: transaction ${item.proof.transactionId || item.transaction?.id || 'unknown'}, CodeSite-Black-Box ${item.blackBoxTrailer || 'missing'}, replay ${item.replay?.replayDigest || item.proof.incidentReplayDigest || 'missing'}`);
  }
  lines.push(
    '',
    '## Causal Replay Packets',
    '',
  );
  if (replaySummaries.length === 0) {
    lines.push('- No causal replay packets closed yet.');
  }
  for (const replay of replaySummaries) {
    lines.push(`- ${replay.incidentId}: ${replay.category} ${replay.replayDigest || 'missing digest'} (${Math.round((Number(replay.completeness?.score) || 0) * 100)}% complete)`);
    if (replay.transactionId || replay.proofBundleId) {
      lines.push(`  Transaction: ${replay.transactionId || 'n/a'}; proof: ${replay.proofBundleId || 'n/a'}`);
    }
    if (asArray(replay.missingEventTypes).length) {
      lines.push(`  Missing event kinds: ${replay.missingEventTypes.join(', ')}`);
    }
    if (asArray(replay.exportPaths).length) {
      lines.push(`  Export refs: ${replay.exportPaths.slice(0, 4).join(', ')}`);
    }
  }
  lines.push(
    '',
    '## Collision Forecast',
    '',
    `Risk level: ${forecast?.riskLevel || 'unknown'}`,
  );
  for (const risk of asArray(forecast?.risks)) {
    lines.push(`- ${risk.severity}: ${risk.risk} in ${risk.conflictZone}`);
  }
  return `${lines.join('\n')}\n`;
}

function incidentsForSession(incidents, session, transactions, proofBundles) {
  const transactionIds = new Set(transactions.map((txn) => txn.id));
  const proofReplayDigests = new Set(proofBundles.map((proof) => proof.incidentReplayDigest).filter(Boolean));
  return asArray(incidents).filter((incident) => {
    const summary = incidentHandoverSummary({ proofBundles: [], mutationTxns: [] }, incident);
    return asArray(incident.participants).includes(session.displayCallsign)
      || transactionIds.has(summary.transactionId)
      || proofReplayDigests.has(summary.replayDigest);
  });
}

function incidentHandoverSummary(project, incident) {
  const replay = incident.incidentReplay || {};
  const transactionId = replay.transaction?.id
    || replay.transactionId
    || asArray(replay.causalEvents).map((event) => event.transactionId || event.details?.transactionId).find(Boolean)
    || null;
  const proofBundle = asArray(project.proofBundles).find((proof) => (
    proof.incidentReplayDigest === incident.replayDigest
    || proof.id === replay.proofBundle?.id
    || (transactionId && proof.transactionId === transactionId)
  )) || null;
  return {
    incidentId: incident.id,
    category: incident.category,
    severity: incident.severity,
    replayDigest: incident.replayDigest || null,
    transactionId,
    proofBundleId: proofBundle?.id || replay.proofBundle?.id || null,
    proofBundleDigest: proofBundle?.bundleDigest || replay.proofBundle?.bundleDigest || null,
    codeSiteBlackBox: proofBundle?.trailers?.['CodeSite-Black-Box'] || proofBundle?.incidentReplayDigest || incident.replayDigest || null,
    completeness: replay.completeness || null,
    presentEventTypes: asArray(replay.completeness?.presentEventTypes),
    missingEventTypes: asArray(replay.completeness?.missingEventTypes),
    totalEvents: asArray(replay.causalEvents).length,
    exportPaths: unique([
      `projects/${project.id || '<project-id>'}/incidents/incident-replay-${incident.id}.jsonl`,
      `projects/${project.id || '<project-id>'}/handover.md`,
      ...(proofBundle?.id ? [
        `projects/${project.id || '<project-id>'}/proof-bundles/${proofBundle.id}.proof.json`,
        `projects/${project.id || '<project-id>'}/proof-bundles/${proofBundle.id}.trailers.txt`,
      ] : []),
      ...asArray(replay.handover?.exportPaths),
    ]),
  };
}

function jsonFile(relativePath, value) {
  return {
    relativePath,
    content: `${JSON.stringify(value ?? null, null, 2)}\n`,
  };
}

function sharedAgentSessionProjection(session = {}) {
  return scrubSharedAgentValue(session);
}

function scrubSharedAgentValue(value) {
  if (Array.isArray(value)) {
    return value
      .filter((item) => item !== 'repo_local_projection')
      .map(scrubSharedAgentValue);
  }
  if (!value || typeof value !== 'object') return value;

  const output = {};
  let providerSessionBound = Boolean(value.providerSessionBound);
  for (const [key, item] of Object.entries(value)) {
    if (key === 'providerSessionRef') {
      providerSessionBound = providerSessionBound || Boolean(item);
      continue;
    }
    if (/(?:token|secret|credential|prompt|transcript)/i.test(key)) continue;
    output[key] = scrubSharedAgentValue(item);
  }
  if (providerSessionBound || Object.hasOwn(value, 'providerSessionBound') || Object.hasOwn(value, 'providerSessionRef')) {
    output.providerSessionBound = providerSessionBound;
  }
  return output;
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
    const historyEntries = [];
    const generationId = artifactGenerationId(project, files);
    const manifest = files.filter((file) => file.relativePath === 'manifest.json');
    const bodyFiles = files.filter((file) => file.relativePath !== 'manifest.json');
    for (const file of bodyFiles) {
      const metadata = await writeArtifactFile(root, file);
      written.push(file.relativePath);
      historyEntries.push(artifactHistoryEntry('write', generationId, project, metadata));
    }
    const removed = await removeStaleProjectionFiles(root, currentPaths);
    historyEntries.push(...removed.map((metadata) => artifactHistoryEntry('remove', generationId, project, metadata)));
    for (const file of manifest) {
      const metadata = await writeArtifactFile(root, file);
      written.push(file.relativePath);
      historyEntries.push(artifactHistoryEntry('write', generationId, project, metadata));
    }
    const indexMetadata = await writeArtifactFile(root, jsonFile(ARTIFACT_FILE_INDEX, [...currentPaths].sort()));
    historyEntries.push(artifactHistoryEntry('write', generationId, project, indexMetadata));
    await appendArtifactPathHistory(root, historyEntries);
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
  return {
    relativePath: file.relativePath,
    digest: artifactContentDigest(file.content),
    bytes: Buffer.byteLength(file.content, 'utf8'),
  };
}

async function removeStaleProjectionFiles(root, currentPaths) {
  const previous = await readProjectionFileIndex(root);
  const removed = [];
  for (const rel of previous) {
    if (currentPaths.has(rel)) continue;
    const target = path.resolve(root, rel);
    if (!isPathInside(root, target)) continue;
    const metadata = await artifactFileMetadata(root, rel);
    await fs.rm(target, { force: true });
    removed.push(metadata || { relativePath: rel, digest: null, bytes: null });
  }
  return removed;
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

function artifactGenerationId(project, files) {
  return `artifact-generation:${artifactContentDigest(stableJson({
    projectId: project.id,
    workspaceSlug: project.workspaceSlug,
    projectedPaths: files.map((file) => file.relativePath).sort(),
    generatedAt: new Date().toISOString(),
  }))}`;
}

function artifactContentDigest(content) {
  return `sha256:${crypto.createHash('sha256').update(String(content ?? '')).digest('hex')}`;
}

async function artifactFileMetadata(root, relativePath) {
  const target = path.resolve(root, relativePath);
  if (!isPathInside(root, target)) return null;
  try {
    const content = await fs.readFile(target, 'utf8');
    return {
      relativePath,
      digest: artifactContentDigest(content),
      bytes: Buffer.byteLength(content, 'utf8'),
    };
  } catch (_) {
    return {
      relativePath,
      digest: null,
      bytes: null,
    };
  }
}

function artifactHistoryEntry(action, generationId, project, metadata = {}) {
  return {
    schemaVersion: 'synthi.codesite.artifactPathHistory.v1',
    action,
    generationId,
    workspaceSlug: project.workspaceSlug,
    projectId: project.id,
    relativePath: metadata.relativePath,
    digest: metadata.digest || null,
    bytes: metadata.bytes ?? null,
    recordedAt: new Date().toISOString(),
  };
}

async function appendArtifactPathHistory(root, entries) {
  if (!entries.length) return;
  const target = path.join(root, ARTIFACT_PATH_HISTORY);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.appendFile(target, `${entries.map((entry) => stableJson(entry)).join('\n')}\n`, 'utf8');
  await compactArtifactPathHistory(target);
}

async function compactArtifactPathHistory(target) {
  const maxBytes = artifactPathHistoryMaxBytes();
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return;
  const stat = await fs.stat(target).catch(() => null);
  if (!stat || stat.size <= maxBytes) return;
  const text = await fs.readFile(target, 'utf8');
  const lines = text.trimEnd().split('\n').filter(Boolean);
  const parsed = lines.map((line) => {
    try {
      return { line, entry: JSON.parse(line) };
    } catch (_) {
      return { line, entry: null };
    }
  });
  const latestGenerationId = [...parsed].reverse().find((item) => item.entry?.generationId)?.entry?.generationId || null;
  const retainedIndexes = new Set();
  if (latestGenerationId) {
    parsed.forEach((item, index) => {
      if (item.entry?.generationId === latestGenerationId) retainedIndexes.add(index);
    });
  }
  let retainedBytes = [...retainedIndexes]
    .reduce((sum, index) => sum + Buffer.byteLength(lines[index], 'utf8') + 1, 0);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (retainedIndexes.has(index)) continue;
    const line = lines[index];
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1;
    if (retainedIndexes.size && retainedBytes + lineBytes > maxBytes) break;
    retainedIndexes.add(index);
    retainedBytes += lineBytes;
  }
  const retained = [...retainedIndexes]
    .sort((left, right) => left - right)
    .map((index) => lines[index]);
  const marker = stableJson({
    schemaVersion: 'synthi.codesite.artifactPathHistory.compaction.v1',
    action: 'compact',
    originalBytes: stat.size,
    retainedLineCount: retained.length,
    prunedLineCount: Math.max(0, lines.length - retained.length),
    maxBytes,
    recordedAt: new Date().toISOString(),
  });
  await fs.writeFile(target, `${[marker, ...retained].join('\n')}\n`, 'utf8');
}

function artifactPathHistoryMaxBytes() {
  return getCodeSiteRuntimeConfig().artifactPathHistoryMaxBytes;
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
