import {
  classifyGpuHmrEpochSwapProof,
  classifyGpuHmrHostPreservationProof,
} from './gpu-hmr-runtime-proof.mjs';

function parseRuntimeKeyValues(line) {
  const out = {};
  const re = /\b([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|[^\s]+)/g;
  let match;
  while ((match = re.exec(String(line ?? ''))) !== null) {
    const raw = match[2];
    out[match[1]] = raw.startsWith('"') && raw.endsWith('"')
      ? raw.slice(1, -1)
      : raw;
  }
  return out;
}

function boolValue(value) {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return null;
}

function integerValue(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function compactStringList(values) {
  return Array.isArray(values)
    ? [...new Set(values.filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim()))]
    : [];
}

function epochRecord(line) {
  const fields = parseRuntimeKeyValues(line);
  return {
    line,
    event: fields.event ?? null,
    runtimeSession: fields.runtime_session ?? null,
    previousGeneration: integerValue(fields.previous_generation),
    activeGeneration: integerValue(fields.active_generation),
    dispatchTableHash: fields.dispatch_table_hash ?? null,
    changedEntries: integerValue(fields.changed_entries),
    retiredModules: integerValue(fields.retired_modules),
    retirementTracked: boolValue(fields.retirement_tracked),
    oldGenerationRetired: boolValue(fields.old_generation_retired),
    streamScope: fields.stream_scope ?? null,
    streamOrderingProven: boolValue(fields.stream_ordering_proven),
    drainResult: fields.drain_result ?? null,
  };
}

function matchingRetirement(publication, retirements) {
  return retirements.find((record) =>
    record.previousGeneration === publication.previousGeneration
    && record.activeGeneration === publication.activeGeneration
    && record.oldGenerationRetired === true
  ) ?? null;
}

function epochEvidenceRefs(publication, retirement) {
  if (!publication) return [];
  const lineage = `${publication.previousGeneration}->${publication.activeGeneration}`;
  const refs = [`worker-log:dispatcher_epoch:published:${lineage}`];
  if (retirement) refs.push(`worker-log:dispatcher_epoch:retired:${lineage}`);
  return refs;
}

export function runtimeEpochSwapEvidence(lines) {
  const records = (Array.isArray(lines) ? lines : [])
    .filter((line) => /\bdispatcher_epoch\b/i.test(String(line ?? '')))
    .map(epochRecord);
  const publications = records.filter((record) => record.event === 'published');
  const retirements = records.filter((record) => record.event === 'retired');
  const latestPublication = publications.at(-1) ?? null;
  const retirement = latestPublication ? matchingRetirement(latestPublication, retirements) : null;
  const runtimeSessionIds = compactStringList(records.map((record) => record.runtimeSession));
  const runtimeSessionObserved = runtimeSessionIds.length > 0;
  const runtimeSessionConsistent = runtimeSessionIds.length <= 1;
  const generationLineageObserved = latestPublication
    ? Number.isFinite(latestPublication.previousGeneration)
      && Number.isFinite(latestPublication.activeGeneration)
      && latestPublication.activeGeneration > latestPublication.previousGeneration
    : false;
  const dispatchTableHashObserved = typeof latestPublication?.dispatchTableHash === 'string'
    && /^0x[0-9a-f]+$/i.test(latestPublication.dispatchTableHash);
  const changedEntriesObserved = Number.isFinite(latestPublication?.changedEntries)
    && latestPublication.changedEntries >= 0;
  const retirementTracked = latestPublication?.retirementTracked === true;
  const oldGenerationRetired = latestPublication?.oldGenerationRetired === true || retirement !== null;
  const streamOrderingProven =
    latestPublication?.streamOrderingProven === true && latestPublication?.drainResult === 'synced';

  return {
    total_count: records.length,
    published_count: publications.length,
    retired_count: retirements.length,
    published: latestPublication !== null,
    runtime_session_observed: runtimeSessionObserved,
    runtime_session_ids: runtimeSessionIds,
    runtime_session_consistent: runtimeSessionConsistent,
    generation_lineage_observed: generationLineageObserved,
    dispatch_table_hash_observed: dispatchTableHashObserved,
    changed_entries_observed: changedEntriesObserved,
    retirement_tracked: retirementTracked,
    old_generation_retired: oldGenerationRetired,
    stream_ordering_proven: streamOrderingProven,
    stream_scope: latestPublication?.streamScope ?? null,
    drain_result: latestPublication?.drainResult ?? null,
    latest_publication: latestPublication,
    matching_retirement: retirement,
    evidence_refs: epochEvidenceRefs(latestPublication, retirement),
    lines: records.map((record) => record.line).slice(-20),
  };
}

export function epochSwapProofFromRuntimeEvidence(lines) {
  const evidence = runtimeEpochSwapEvidence(lines);
  const proof = classifyGpuHmrEpochSwapProof({
    published: evidence.published,
    generationLineageObserved: evidence.generation_lineage_observed,
    dispatchTableHashObserved: evidence.dispatch_table_hash_observed,
    changedEntriesObserved: evidence.changed_entries_observed,
    runtimeSessionObserved: evidence.runtime_session_observed,
    runtimeSessionIds: evidence.runtime_session_ids,
    runtimeSessionConsistent: evidence.runtime_session_consistent,
    streamOrderingProven: evidence.stream_ordering_proven,
    retirementTracked: evidence.retirement_tracked,
    oldGenerationRetired: evidence.old_generation_retired,
    evidenceRefs: evidence.evidence_refs,
  });
  return { evidence, proof };
}

function hostIdentityRecord(line) {
  const fields = parseRuntimeKeyValues(line);
  return {
    line,
    role: fields.role ?? null,
    ptr: fields.ptr ?? null,
    aux: fields.aux ?? null,
    generation: integerValue(fields.generation),
    runtimeSession: fields.runtime_session ?? null,
  };
}

export function runtimeHostIdentityEvidence(lines) {
  const records = (Array.isArray(lines) ? lines : [])
    .filter((line) => /\bhost_identity\b/i.test(String(line ?? '')))
    .map(hostIdentityRecord)
    .filter((record) =>
      typeof record.role === 'string'
      && record.role.trim()
      && typeof record.ptr === 'string'
      && /^0x[0-9a-f]+$/i.test(record.ptr)
      && record.ptr !== '0x0'
      && Number.isFinite(record.generation)
    );
  const byRole = new Map();
  for (const record of records) {
    if (!byRole.has(record.role)) byRole.set(record.role, []);
    byRole.get(record.role).push(record);
  }

  const preservedRoles = [];
  const changedRoles = [];
  for (const [role, roleRecords] of byRole) {
    const identities = new Set(roleRecords.map((record) => `${record.ptr}:${record.aux ?? ''}`));
    const generations = new Set(roleRecords.map((record) => record.generation));
    if (identities.size === 1 && generations.size >= 2) {
      preservedRoles.push(role);
    } else if (identities.size > 1) {
      changedRoles.push(role);
    }
  }
  preservedRoles.sort();
  changedRoles.sort();

  return {
    total_count: records.length,
    role_count: byRole.size,
    preserved_roles: preservedRoles,
    changed_roles: changedRoles,
    identity_checks_passed: records.length > 0 && changedRoles.length === 0 && preservedRoles.length > 0,
    evidence_refs: preservedRoles.map((role) => `worker-log:host_identity:${role}`),
    lines: records.map((record) => record.line).slice(-20),
  };
}

export function hostPreservationProofFromRuntimeEvidence(lines, observation = {}) {
  const evidence = runtimeHostIdentityEvidence(lines);
  const externalIdentityEvidenceRefs = Array.isArray(observation.identityEvidenceRefs)
    ? observation.identityEvidenceRefs.filter((ref) => typeof ref === 'string' && ref.trim())
    : [];
  const proof = classifyGpuHmrHostPreservationProof({
    hostRestartObserved: observation.hostRestartObserved === true,
    hostReplacementObserved: observation.hostReplacementObserved === true,
    identityChecksPassed: evidence.identity_checks_passed,
    identityEvidenceRefs: [...evidence.evidence_refs, ...externalIdentityEvidenceRefs],
  });
  return { evidence, proof };
}

function outputOracleRecord(line) {
  const fields = parseRuntimeKeyValues(line);
  return {
    line,
    oracleId: fields.id ?? fields.oracle_id ?? null,
    kind: fields.kind ?? null,
    expected: Object.prototype.hasOwnProperty.call(fields, 'expected') ? fields.expected : null,
    actual: Object.prototype.hasOwnProperty.call(fields, 'actual') ? fields.actual : null,
    passed: boolValue(fields.passed),
    generation: integerValue(fields.generation),
    runtimeSession: fields.runtime_session ?? null,
  };
}

function normalizeOracleContract(contract) {
  if (!contract || typeof contract !== 'object') return null;
  const normalized = {};
  for (const field of ['id', 'oracleId', 'kind', 'expected']) {
    if (typeof contract[field] === 'string' && contract[field].trim()) {
      normalized[field] = contract[field].trim();
    }
  }
  const oracleId = normalized.id ?? normalized.oracleId ?? null;
  if (oracleId === null && !normalized.kind && !normalized.expected) return null;
  return {
    oracleId,
    kind: normalized.kind ?? null,
    expected: normalized.expected ?? null,
  };
}

function oracleMatchesContract(record, contract) {
  if (!contract) return true;
  if (contract.oracleId !== null && record.oracleId !== contract.oracleId) return false;
  if (contract.kind !== null && record.kind !== contract.kind) return false;
  if (contract.expected !== null && record.expected !== contract.expected) return false;
  return true;
}

export function runtimeOutputOracleEvidence(lines, observation = {}) {
  const records = (Array.isArray(lines) ? lines : [])
    .filter((line) => /\boutput_oracle\b/i.test(String(line ?? '')))
    .map(outputOracleRecord)
    .filter((record) =>
      typeof record.oracleId === 'string'
      && record.oracleId.trim()
      && typeof record.kind === 'string'
      && record.kind.trim()
      && record.expected !== null
      && record.actual !== null
      && record.passed !== null
    );
  const expectedContract = normalizeOracleContract(observation.expectedOracle ?? observation.outputOracleContract);
  const matchingRecords = records.filter((record) => oracleMatchesContract(record, expectedContract));
  const latest = matchingRecords.at(-1) ?? null;
  const passedRecords = matchingRecords.filter((record) => record.passed === true);
  const evidenceRefs = latest ? [`worker-log:output_oracle:${latest.oracleId}`] : [];

  return {
    total_count: records.length,
    matched_count: matchingRecords.length,
    passed_count: passedRecords.length,
    failed_count: matchingRecords.length - passedRecords.length,
    latest,
    expected_contract: expectedContract,
    deterministic_output_observed: latest !== null && latest.actual !== null,
    deterministic_oracle_provided: latest !== null && latest.expected !== null && typeof latest.kind === 'string',
    deterministic_oracle_passed: latest?.passed === true,
    output_oracle: latest
      ? {
          kind: latest.kind,
          expected: latest.expected,
          actual: latest.actual,
          evidenceRefs,
        }
      : null,
    evidence_refs: evidenceRefs,
    lines: records.map((record) => record.line).slice(-20),
  };
}
