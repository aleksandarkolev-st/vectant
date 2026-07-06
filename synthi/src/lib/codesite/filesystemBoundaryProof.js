import { asArray } from './json';

export const FILESYSTEM_BOUNDARY_PROOF_SCHEMA_VERSION = 'synthi.codesite.filesystemBoundaryProof.v1';

export function buildFilesystemBoundaryProofRecords(project = {}) {
  const leasesById = new Map(asArray(project.mutationLeases).map((lease) => [lease.id, lease]));
  const decisionsById = new Map(asArray(project.policyDecisions).map((decision) => [decision.id, decision]));
  const records = [];

  for (const event of asArray(project.events)) {
    if (!isFilesystemBoundaryEvent(event)) continue;
    const details = event.details || {};
    const codesiteFsEvent = details.codesiteFsEvent || details.codesite_fs_event || {};
    const fsDetails = codesiteFsEvent.details || {};
    const quarantineEvidence = details.quarantineEvidence
      || details.quarantine_evidence
      || fsDetails.quarantineEvidence
      || fsDetails.quarantine_evidence
      || null;
    const policyDecisionId = details.policyDecisionId || details.policy_decision_id || event.actorId || null;
    const policyDecision = policyDecisionId ? decisionsById.get(policyDecisionId) || null : null;
    const disposition = normalizeDisposition(details.disposition || codesiteFsEvent.type || event.eventType);
    const boundaryLease = resolveBoundaryLease(event, details, codesiteFsEvent, fsDetails, policyDecision, disposition);
    const lease = boundaryLease.matchedLeaseId ? leasesById.get(boundaryLease.matchedLeaseId) || null : null;
    const path = normalizePath(details.path || codesiteFsEvent.path || fsDetails.path || quarantineEvidence?.path);
    const evidenceRefs = unique([
      event.id ? `event:${event.id}` : null,
      ...asArray(event.evidenceRefs),
      ...asArray(details.evidenceRefs || details.evidence_refs),
      ...asArray(codesiteFsEvent.evidence_refs || codesiteFsEvent.evidenceRefs),
      ...asArray(fsDetails.evidenceRefs || fsDetails.evidence_refs),
      ...asArray(policyDecision?.evidenceRefs),
      fsDetails.evidenceRef || fsDetails.evidence_ref,
      details.evidenceRef || details.evidence_ref,
    ]);
    const reasonCodes = unique([
      ...asArray(details.reasonCodes || details.reason_codes),
      ...asArray(fsDetails.reasonCodes || fsDetails.reason_codes),
      ...asArray(policyDecision?.reasonCodes),
    ]);
    const reason = details.reason
      || details.message
      || fsDetails.reason
      || fsDetails.message
      || policyDecision?.decisionBody?.towerInstruction
      || reasonCodes.join(', ');
    const processAncestry = unique([
      ...asArray(details.processAncestry || details.process_ancestry),
      ...asArray(fsDetails.processAncestry || fsDetails.process_ancestry),
      ...asArray(codesiteFsEvent.processAncestry || codesiteFsEvent.process_ancestry),
    ]);
    const lineProvenance = asArray(details.lineProvenance || details.line_provenance || fsDetails.lineProvenance || fsDetails.line_provenance);
    const changedLineRanges = asArray(details.changedLineRanges || details.changed_line_ranges || fsDetails.changedLineRanges || fsDetails.changed_line_ranges);
    const dojoSourceRefs = unique([
      ...asArray(details.dojoSourceRefs || details.dojo_source_refs),
      ...asArray(fsDetails.dojoSourceRefs || fsDetails.dojo_source_refs),
    ]);
    const quarantineId = details.quarantineId
      || details.quarantine_id
      || fsDetails.quarantineId
      || fsDetails.quarantine_id
      || quarantineEvidence?.quarantineId
      || quarantineEvidence?.quarantine_id
      || null;

    records.push({
      schemaVersion: FILESYSTEM_BOUNDARY_PROOF_SCHEMA_VERSION,
      proofId: filesystemBoundaryProofId(event, path, disposition),
      projectId: project.id || event.projectId || null,
      workspaceSlug: project.workspaceSlug || null,
      eventId: event.id || null,
      policyDecisionId,
      eventType: event.eventType,
      disposition,
      prevented: disposition !== 'write_allowed',
      quarantined: disposition === 'write_quarantined',
      path,
      transactionId: details.transactionId || details.transaction_id || codesiteFsEvent.transaction_id || null,
      mutationLeaseId: boundaryLease.matchedLeaseId,
      requestedMutationLeaseId: boundaryLease.requestedLeaseId,
      inspectedLeases: boundaryLease.inspectedLeases,
      displayCallsign: event.displayCallsign || lease?.displayCallsign || policyDecision?.displayCallsign || null,
      leaseState: filesystemBoundaryLeaseState({ lease, boundaryLease }),
      lease: lease ? boundaryLeaseSummary(lease) : null,
      reasonCodes,
      reason,
      zone: details.zone || policyDecision?.decisionBody?.zone || null,
      boundary: {
        source: details.source || codesiteFsEvent.source || fsDetails.source || event.actorType || 'codesitefs',
        tool: details.tool || codesiteFsEvent.tool || codesiteFsEvent.operation || fsDetails.tool || fsDetails.operation || 'write',
        operation: codesiteFsEvent.operation || details.operation || fsDetails.operation || 'write',
        actorType: event.actorType || null,
        actorId: event.actorId || null,
      },
      process: {
        ancestry: processAncestry,
        display: processAncestry.length ? processAncestry.join(' <- ') : null,
      },
      evidence: {
        refs: evidenceRefs,
        lineProvenanceCount: lineProvenance.length,
        changedLineRanges,
        dojoSourceRefs,
      },
      evidenceRefs,
      quarantine: quarantineId || quarantineEvidence ? {
        quarantineId,
        evidenceRef: quarantineEvidence?.evidenceRef || quarantineEvidence?.evidence_ref || null,
        kind: quarantineEvidence?.kind || null,
        beforeDigest: quarantineEvidence?.beforeDigest || quarantineEvidence?.before_digest || null,
        afterDigest: quarantineEvidence?.afterDigest || quarantineEvidence?.after_digest || null,
        symlinkSanitization: fsDetails.symlinkSanitization
          || fsDetails.symlink_sanitization
          || details.symlinkSanitization
          || details.symlink_sanitization
          || null,
      } : null,
      proofComplete: Boolean(path && reasonCodes.length && processAncestry.length && evidenceRefs.length),
      missingProofFields: missingProofFields({ path, reasonCodes, processAncestry, evidenceRefs }),
      createdAt: event.createdAt || null,
    });
  }

  return records.sort((left, right) => (
    String(right.createdAt || '').localeCompare(String(left.createdAt || ''))
    || String(right.eventId || '').localeCompare(String(left.eventId || ''))
  ));
}

function resolveBoundaryLease(event, details, codesiteFsEvent, fsDetails, policyDecision, disposition) {
  const inspectedLeases = normalizeInspectedLeases(policyDecision?.decisionBody?.inspectedLeases);
  const matchedLeaseCandidates = unique([
    event.mutationLeaseId,
    details.matchedLeaseId,
    details.matched_lease_id,
    policyDecision?.mutationLeaseId,
    policyDecision?.decisionBody?.matchedLeaseId,
  ]);
  const positiveInspectedLeaseIds = inspectedLeases.filter((lease) => lease.ok).map((lease) => lease.mutationLeaseId);
  const blocksWrite = disposition === 'write_denied' || String(policyDecision?.decision || '').toLowerCase() === 'block';
  const matchedLeaseId = blocksWrite
    ? null
    : unique([
      ...matchedLeaseCandidates.filter((leaseId) => positiveInspectedLeaseIds.includes(leaseId)),
      ...positiveInspectedLeaseIds,
      ...(inspectedLeases.length ? [] : matchedLeaseCandidates),
    ])[0] || null;
  const requestedLeaseId = unique([
    details.mutationLeaseId,
    details.mutation_lease_id,
    codesiteFsEvent.mutationLeaseId,
    codesiteFsEvent.mutation_lease_id,
    codesiteFsEvent.mutation_lease,
    fsDetails.mutationLeaseId,
    fsDetails.mutation_lease_id,
    policyDecision?.decisionBody?.requestedLeaseId,
    policyDecision?.input?.mutationLeaseId,
    ...matchedLeaseCandidates.filter((leaseId) => leaseId !== matchedLeaseId),
  ])[0] || null;
  return {
    matchedLeaseId,
    requestedLeaseId: requestedLeaseId && requestedLeaseId !== matchedLeaseId ? requestedLeaseId : null,
    inspectedLeases,
  };
}

function normalizeInspectedLeases(value) {
  return asArray(value).map((item) => ({
    mutationLeaseId: item?.mutationLeaseId || item?.mutation_lease_id || item?.id || null,
    displayCallsign: item?.displayCallsign || item?.display_callsign || null,
    ok: item?.ok === true,
    reasonCodes: unique(item?.reasonCodes || item?.reason_codes || []),
  })).filter((item) => item.mutationLeaseId);
}

function filesystemBoundaryLeaseState({ lease, boundaryLease }) {
  if (lease) return 'matched_clearance';
  if (asArray(boundaryLease?.inspectedLeases).some((item) => item.ok === false)) return 'inspected_clearance_rejected';
  if (boundaryLease?.requestedLeaseId) return 'unmatched_clearance';
  return 'no_active_clearance';
}

function missingProofFields({ path, reasonCodes, processAncestry, evidenceRefs }) {
  const missing = [];
  if (!path) missing.push('path');
  if (!asArray(reasonCodes).length) missing.push('reason');
  if (!asArray(processAncestry).length) missing.push('process');
  if (!asArray(evidenceRefs).length) missing.push('evidence');
  return missing;
}

function isFilesystemBoundaryEvent(event = {}) {
  if (!['write_denied', 'write_quarantined'].includes(event.eventType)) return false;
  const details = event.details || {};
  if (event.actorType === 'codesitefs') return true;
  if (details.codesiteFsEvent || details.codesite_fs_event) return true;
  const source = String(details.source || '').toLowerCase();
  return source.includes('codesitefs') || source.includes('runtime_pod') || source.includes('filesystem');
}

function normalizeDisposition(value) {
  const disposition = String(value || '').trim();
  return ['write_allowed', 'write_denied', 'write_quarantined'].includes(disposition)
    ? disposition
    : 'write_denied';
}

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');
}

function filesystemBoundaryProofId(event, path, disposition) {
  if (event?.id) return `fs-boundary-${event.id}`;
  return `fs-boundary-${disposition}-${path || 'unknown-path'}`.replace(/[^a-zA-Z0-9._-]+/g, '-');
}

function boundaryLeaseSummary(lease = {}) {
  const leaseBody = lease.lease || lease.leaseBody || {};
  return {
    id: lease.id || null,
    displayCallsign: lease.displayCallsign || null,
    status: lease.status || null,
    allowedPaths: asArray(leaseBody.allowedPaths || lease.allowedPaths),
    blockedPaths: asArray(leaseBody.blockedPaths || lease.blockedPaths),
    allowedTools: asArray(leaseBody.allowedTools || lease.allowedTools),
    dojoLicenseRef: lease.dojoLicenseRef || null,
    dojoProofRef: lease.dojoProofRef || null,
  };
}

function unique(values) {
  return [...new Set(asArray(values).filter((value) => value != null && value !== '').map((value) => String(value)))];
}
