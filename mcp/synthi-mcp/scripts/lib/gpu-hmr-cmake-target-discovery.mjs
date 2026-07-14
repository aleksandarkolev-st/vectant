import { createHash } from 'node:crypto';
import path from 'node:path';

export const GPU_HMR_CMAKE_TARGET_RESOLUTION_SCHEMA =
  'synthi.gpu_hmr.cmake_target_resolution.v1';
export const GPU_HMR_CMAKE_TARGET_RESOLUTION_AUTHORITY =
  'cmake_file_api_source_ownership_only_not_gpu_hmr_success';

const BUILDABLE_TARGET_TYPES = new Set([
  'EXECUTABLE',
  'MODULE_LIBRARY',
  'OBJECT_LIBRARY',
  'SHARED_LIBRARY',
  'STATIC_LIBRARY',
]);
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const TARGET_RESOLUTION_EVIDENCE_KEYS = Object.freeze([
  'schemaVersion',
  'proofAuthority',
  'status',
  'method',
  'requestedTargetName',
  'requestedTargetType',
  'resolvedTargetId',
  'resolvedTargetName',
  'resolvedTargetType',
  'resolvedTargetArtifacts',
  'declaredSourcePaths',
  'sourceOwners',
  'candidateTargets',
  'compileDatabaseStatus',
  'compileDatabaseSourcePaths',
  'codemodelHash',
  'replySetHash',
  'blockingGaps',
  'accepted',
  'acceptedAsTargetResolutionEvidence',
  'acceptedAsRefusalEvidence',
  'acceptedForGpuHmr',
  'gpuHmrSuccess',
  'canSatisfyRuntimeProof',
  'canSatisfyDispatchProof',
  'evidenceHash',
]);
const SOURCE_OWNER_KEYS = Object.freeze([
  'sourcePath',
  'directTargetIds',
  'closureTargetIds',
  'compileDatabaseCovered',
]);
const CANDIDATE_TARGET_KEYS = Object.freeze([
  'id',
  'name',
  'type',
  'artifacts',
  'directSourcePaths',
  'closureSourcePaths',
  'closureTargetIds',
  'documentHash',
]);

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function contentHash(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function recomputeEvidenceHash(value) {
  const projection = { ...value };
  delete projection.evidenceHash;
  return contentHash(stableJson(projection));
}

function compactStrings(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value ?? '').trim())
    .filter(Boolean))].sort();
}

function exactKeys(value, keys) {
  return value
    && typeof value === 'object'
    && !Array.isArray(value)
    && stableJson(Object.keys(value).sort()) === stableJson([...keys].sort());
}

function isSortedUniqueStrings(values) {
  return Array.isArray(values)
    && values.every((value, index) => (
      typeof value === 'string'
      && value.length > 0
      && (index === 0 || value > values[index - 1])
    ));
}

function normalizedRoot(value) {
  return String(value ?? '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
}

function rootRelativeValue(value, roots) {
  for (const root of roots) {
    const caseInsensitive = /^[A-Za-z]:\//.test(root);
    const candidate = caseInsensitive ? value.toLowerCase() : value;
    const rootCandidate = caseInsensitive ? root.toLowerCase() : root;
    if (candidate === rootCandidate) return '';
    if (candidate.startsWith(`${rootCandidate}/`)) {
      return value.slice(root.length + 1);
    }
  }
  return value;
}

export function normalizeCmakeSourcePath(value, { sourceRoots = [] } = {}) {
  if (typeof value !== 'string' || value.length === 0 || /[\0\r\n]/.test(value)) return null;
  const roots = compactStrings(sourceRoots.map(normalizedRoot))
    .sort((left, right) => right.length - left.length || left.localeCompare(right));
  let normalized = rootRelativeValue(value.replace(/\\/g, '/'), roots);
  if (path.posix.isAbsolute(normalized) || path.win32.isAbsolute(normalized)) return null;
  normalized = path.posix.normalize(normalized).replace(/^\.\//, '').normalize('NFC');
  if (
    !normalized
    || normalized === '.'
    || normalized === '..'
    || normalized.startsWith('../')
  ) {
    return null;
  }
  return normalized;
}

function parseReplyDocuments(replyFiles) {
  const documents = new Map();
  const blockingGaps = [];
  for (const entry of Array.isArray(replyFiles) ? replyFiles : []) {
    const filePath = String(entry?.path ?? '').replace(/\\/g, '/');
    const name = path.posix.basename(filePath);
    const content = typeof entry?.content === 'string' ? entry.content : null;
    if (!name.endsWith('.json') || content === null) {
      blockingGaps.push('cmake_target_resolution_reply_entry_invalid');
      continue;
    }
    if (documents.has(name)) {
      blockingGaps.push('cmake_target_resolution_reply_basename_duplicate');
      continue;
    }
    try {
      documents.set(name, {
        content,
        contentHash: contentHash(content),
        json: JSON.parse(content),
        name,
      });
    } catch {
      blockingGaps.push('cmake_target_resolution_reply_json_invalid');
    }
  }
  return { blockingGaps, documents };
}

function codemodelReferences(index) {
  const reply = index?.reply;
  if (!reply || typeof reply !== 'object' || Array.isArray(reply)) return [];
  return Object.values(reply)
    .filter((entry) => entry?.kind === 'codemodel' && typeof entry?.jsonFile === 'string')
    .map((entry) => entry.jsonFile);
}

function normalizeCompileCommands(compileCommands, options) {
  if (compileCommands === null || compileCommands === undefined || compileCommands === '') {
    return {
      status: 'absent',
      sourcePaths: [],
      blockingGaps: [],
    };
  }
  let parsed = compileCommands;
  try {
    if (typeof parsed === 'string') parsed = JSON.parse(parsed);
  } catch {
    return {
      status: 'malformed',
      sourcePaths: [],
      blockingGaps: ['cmake_target_resolution_compile_database_malformed'],
    };
  }
  if (!Array.isArray(parsed)) {
    return {
      status: 'malformed',
      sourcePaths: [],
      blockingGaps: ['cmake_target_resolution_compile_database_malformed'],
    };
  }
  const sourcePaths = [];
  for (const entry of parsed) {
    const sourcePath = normalizeCmakeSourcePath(entry?.file, options);
    if (!sourcePath) {
      return {
        status: 'malformed',
        sourcePaths: [],
        blockingGaps: ['cmake_target_resolution_compile_database_source_invalid'],
      };
    }
    sourcePaths.push(sourcePath);
  }
  return {
    status: 'valid',
    sourcePaths: compactStrings(sourcePaths),
    blockingGaps: [],
  };
}

function targetClosure(targetId, targetsById, memo, visiting, malformedDependencies) {
  if (memo.has(targetId)) return memo.get(targetId);
  if (visiting.has(targetId)) {
    malformedDependencies.add(targetId);
    return { sourcePaths: [], targetIds: [] };
  }
  const target = targetsById.get(targetId);
  if (!target) {
    malformedDependencies.add(targetId);
    return { sourcePaths: [], targetIds: [] };
  }
  visiting.add(targetId);
  const sourcePaths = new Set(target.sourcePaths);
  const targetIds = new Set([targetId]);
  for (const dependencyId of target.dependencyIds) {
    const dependency = targetClosure(
      dependencyId,
      targetsById,
      memo,
      visiting,
      malformedDependencies,
    );
    for (const sourcePath of dependency.sourcePaths) sourcePaths.add(sourcePath);
    for (const dependencyTargetId of dependency.targetIds) targetIds.add(dependencyTargetId);
  }
  visiting.delete(targetId);
  const result = {
    sourcePaths: [...sourcePaths].sort(),
    targetIds: [...targetIds].sort(),
  };
  memo.set(targetId, result);
  return result;
}

function normalizedArtifactPath(value) {
  if (typeof value !== 'string' || value.length === 0 || /[\0\r\n]/.test(value)) return null;
  return path.posix.normalize(value.replace(/\\/g, '/')).normalize('NFC');
}

function buildRefusalResult({
  blockingGaps,
  candidateTargets = [],
  codemodelHash = null,
  compileDatabase,
  declaredSourcePaths,
  method = 'refused',
  replySetHash,
  requestedTargetName,
  requestedTargetType,
  sourceOwners = [],
}) {
  const result = {
    schemaVersion: GPU_HMR_CMAKE_TARGET_RESOLUTION_SCHEMA,
    proofAuthority: GPU_HMR_CMAKE_TARGET_RESOLUTION_AUTHORITY,
    status: 'target_resolution_refused',
    method,
    requestedTargetName: requestedTargetName || null,
    requestedTargetType: requestedTargetType || null,
    resolvedTargetId: null,
    resolvedTargetName: null,
    resolvedTargetType: null,
    resolvedTargetArtifacts: [],
    declaredSourcePaths,
    sourceOwners,
    candidateTargets,
    compileDatabaseStatus: compileDatabase.status,
    compileDatabaseSourcePaths: compileDatabase.sourcePaths,
    codemodelHash,
    replySetHash,
    blockingGaps: compactStrings(blockingGaps),
    accepted: false,
    acceptedAsTargetResolutionEvidence: false,
    acceptedAsRefusalEvidence: true,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
    canSatisfyDispatchProof: false,
  };
  result.evidenceHash = recomputeEvidenceHash(result);
  return result;
}

export function resolveCmakeTargetFromFileApi({
  replyFiles = [],
  compileCommands = null,
  declaredSourcePaths = [],
  requestedTargetName = null,
  requestedTargetType = null,
  configuration = null,
  sourceRoots = [],
  requireCompileDatabaseCorroboration = false,
} = {}) {
  const pathOptions = { sourceRoots };
  const rawDeclaredSources = Array.isArray(declaredSourcePaths) ? declaredSourcePaths : [];
  const normalizedDeclaredSourceEntries = rawDeclaredSources.map((sourcePath) =>
    normalizeCmakeSourcePath(sourcePath, pathOptions)
  );
  const normalizedDeclaredSources = compactStrings(normalizedDeclaredSourceEntries);
  const normalizedRequestedName = String(requestedTargetName ?? '').trim();
  const normalizedRequestedType = String(requestedTargetType ?? '').trim().toUpperCase();
  const compileDatabase = normalizeCompileCommands(compileCommands, pathOptions);
  const parsed = parseReplyDocuments(replyFiles);
  const replySetHash = contentHash(stableJson([...parsed.documents.values()]
    .map((document) => ({ name: document.name, contentHash: document.contentHash }))
    .sort((left, right) => left.name.localeCompare(right.name))));
  const earlyGaps = [...parsed.blockingGaps, ...compileDatabase.blockingGaps];
  if (
    normalizedDeclaredSourceEntries.some((sourcePath) => !sourcePath)
    || normalizedDeclaredSources.length === 0
  ) {
    earlyGaps.push('cmake_target_resolution_declared_source_invalid');
  }
  const indexDocuments = [...parsed.documents.values()]
    .filter((document) => /^index-.*\.json$/.test(document.name));
  if (indexDocuments.length === 0) earlyGaps.push('cmake_target_resolution_index_missing');
  if (indexDocuments.length > 1) earlyGaps.push('cmake_target_resolution_index_ambiguous');
  if (earlyGaps.length > 0) {
    return buildRefusalResult({
      blockingGaps: earlyGaps,
      compileDatabase,
      declaredSourcePaths: normalizedDeclaredSources,
      replySetHash,
      requestedTargetName: normalizedRequestedName,
      requestedTargetType: normalizedRequestedType,
    });
  }

  const codemodelRefs = codemodelReferences(indexDocuments[0].json);
  if (codemodelRefs.length !== 1) {
    return buildRefusalResult({
      blockingGaps: [codemodelRefs.length === 0
        ? 'cmake_target_resolution_codemodel_reference_missing'
        : 'cmake_target_resolution_codemodel_reference_ambiguous'],
      compileDatabase,
      declaredSourcePaths: normalizedDeclaredSources,
      replySetHash,
      requestedTargetName: normalizedRequestedName,
      requestedTargetType: normalizedRequestedType,
    });
  }
  const codemodelName = path.posix.basename(codemodelRefs[0].replace(/\\/g, '/'));
  const codemodelDocument = parsed.documents.get(codemodelName);
  if (!codemodelDocument || codemodelDocument.json?.kind !== 'codemodel') {
    return buildRefusalResult({
      blockingGaps: ['cmake_target_resolution_codemodel_document_missing'],
      compileDatabase,
      declaredSourcePaths: normalizedDeclaredSources,
      replySetHash,
      requestedTargetName: normalizedRequestedName,
      requestedTargetType: normalizedRequestedType,
    });
  }
  const configurations = Array.isArray(codemodelDocument.json.configurations)
    ? codemodelDocument.json.configurations
    : [];
  const selectedConfigurations = configuration
    ? configurations.filter((candidate) => candidate?.name === configuration)
    : configurations;
  if (selectedConfigurations.length !== 1) {
    return buildRefusalResult({
      blockingGaps: [selectedConfigurations.length === 0
        ? 'cmake_target_resolution_configuration_missing'
        : 'cmake_target_resolution_configuration_ambiguous'],
      codemodelHash: codemodelDocument.contentHash,
      compileDatabase,
      declaredSourcePaths: normalizedDeclaredSources,
      replySetHash,
      requestedTargetName: normalizedRequestedName,
      requestedTargetType: normalizedRequestedType,
    });
  }

  const targetRefs = Array.isArray(selectedConfigurations[0]?.targets)
    ? selectedConfigurations[0].targets
    : [];
  const targetsById = new Map();
  const targetParseGaps = [];
  for (const targetRef of targetRefs) {
    const targetDocumentName = typeof targetRef?.jsonFile === 'string'
      ? path.posix.basename(targetRef.jsonFile.replace(/\\/g, '/'))
      : '';
    const targetDocument = parsed.documents.get(targetDocumentName);
    const targetJson = targetDocument?.json;
    if (
      !targetDocument
      || typeof targetJson?.id !== 'string'
      || typeof targetJson?.name !== 'string'
      || typeof targetJson?.type !== 'string'
      || targetJson.id !== targetRef?.id
      || targetJson.name !== targetRef?.name
      || targetsById.has(targetJson.id)
    ) {
      targetParseGaps.push('cmake_target_resolution_target_reference_invalid');
      continue;
    }
    const sourcePaths = [];
    let sourceInvalid = false;
    for (const source of Array.isArray(targetJson.sources) ? targetJson.sources : []) {
      const sourcePath = normalizeCmakeSourcePath(source?.path, pathOptions);
      if (!sourcePath) {
        if (source?.isGenerated !== true) sourceInvalid = true;
        continue;
      }
      sourcePaths.push(sourcePath);
    }
    if (sourceInvalid) targetParseGaps.push('cmake_target_resolution_target_source_invalid');
    const dependencyIds = compactStrings((Array.isArray(targetJson.dependencies)
      ? targetJson.dependencies
      : []).map((dependency) => dependency?.id));
    const artifacts = compactStrings((Array.isArray(targetJson.artifacts)
      ? targetJson.artifacts
      : []).map((artifact) => normalizedArtifactPath(artifact?.path)));
    targetsById.set(targetJson.id, {
      id: targetJson.id,
      name: targetJson.name,
      type: targetJson.type.toUpperCase(),
      sourcePaths: compactStrings(sourcePaths),
      dependencyIds,
      artifacts,
      documentHash: targetDocument.contentHash,
    });
  }
  if (targetRefs.length === 0) targetParseGaps.push('cmake_target_resolution_target_reference_missing');
  if (targetParseGaps.length > 0) {
    return buildRefusalResult({
      blockingGaps: targetParseGaps,
      codemodelHash: codemodelDocument.contentHash,
      compileDatabase,
      declaredSourcePaths: normalizedDeclaredSources,
      replySetHash,
      requestedTargetName: normalizedRequestedName,
      requestedTargetType: normalizedRequestedType,
    });
  }

  const malformedDependencies = new Set();
  const closureMemo = new Map();
  for (const targetId of targetsById.keys()) {
    targetClosure(targetId, targetsById, closureMemo, new Set(), malformedDependencies);
  }
  if (malformedDependencies.size > 0) {
    return buildRefusalResult({
      blockingGaps: ['cmake_target_resolution_dependency_graph_invalid'],
      codemodelHash: codemodelDocument.contentHash,
      compileDatabase,
      declaredSourcePaths: normalizedDeclaredSources,
      replySetHash,
      requestedTargetName: normalizedRequestedName,
      requestedTargetType: normalizedRequestedType,
    });
  }

  const typeAccepted = (target) => normalizedRequestedType
    ? target.type === normalizedRequestedType
    : BUILDABLE_TARGET_TYPES.has(target.type);
  const candidates = [...targetsById.values()].filter(typeAccepted);
  const coversAll = (target) => {
    const closureSources = new Set(closureMemo.get(target.id)?.sourcePaths ?? []);
    return normalizedDeclaredSources.every((sourcePath) => closureSources.has(sourcePath));
  };
  const fullOwners = candidates.filter(coversAll);
  const sourceOwners = normalizedDeclaredSources.map((sourcePath) => ({
    sourcePath,
    directTargetIds: [...targetsById.values()]
      .filter((target) => target.sourcePaths.includes(sourcePath))
      .map((target) => target.id)
      .sort(),
    closureTargetIds: candidates
      .filter((target) => (closureMemo.get(target.id)?.sourcePaths ?? []).includes(sourcePath))
      .map((target) => target.id)
      .sort(),
    compileDatabaseCovered: compileDatabase.sourcePaths.includes(sourcePath),
  }));
  const candidateTargets = candidates.map((target) => ({
    id: target.id,
    name: target.name,
    type: target.type,
    artifacts: target.artifacts,
    directSourcePaths: target.sourcePaths,
    closureSourcePaths: closureMemo.get(target.id)?.sourcePaths ?? [],
    closureTargetIds: closureMemo.get(target.id)?.targetIds ?? [],
    documentHash: target.documentHash,
  })).sort((left, right) => left.id.localeCompare(right.id));

  const requestedTargets = normalizedRequestedName
    ? candidates.filter((target) => target.name === normalizedRequestedName)
    : [];
  let resolvedTarget = null;
  let method = 'unique_source_owner';
  const resolutionGaps = [];
  if (normalizedRequestedName && requestedTargets.length > 1) {
    resolutionGaps.push('cmake_target_resolution_requested_target_ambiguous');
  } else if (normalizedRequestedName && requestedTargets.length === 1) {
    if (!coversAll(requestedTargets[0])) {
      resolutionGaps.push('cmake_target_resolution_requested_target_source_conflict');
    } else {
      resolvedTarget = requestedTargets[0];
      method = 'requested_target_verified_by_codemodel';
    }
  } else if (normalizedRequestedName) {
    const namedTargets = [...targetsById.values()]
      .filter((target) => target.name === normalizedRequestedName);
    if (namedTargets.length > 0) {
      resolutionGaps.push('cmake_target_resolution_requested_target_type_conflict');
    }
  }
  if (!resolvedTarget && resolutionGaps.length === 0) {
    if (fullOwners.length === 1) {
      resolvedTarget = fullOwners[0];
    } else if (fullOwners.length > 1) {
      resolutionGaps.push('cmake_target_resolution_ambiguous');
    } else if (sourceOwners.some((owner) => owner.closureTargetIds.length === 0)) {
      resolutionGaps.push('cmake_target_resolution_unmatched');
    } else {
      resolutionGaps.push('cmake_target_resolution_split_ownership');
    }
  }
  if (
    requireCompileDatabaseCorroboration
    && compileDatabase.status !== 'valid'
  ) {
    resolutionGaps.push('cmake_target_resolution_compile_database_required');
  }
  if (
    requireCompileDatabaseCorroboration
    && compileDatabase.status === 'valid'
    && sourceOwners.some((owner) => owner.compileDatabaseCovered !== true)
  ) {
    resolutionGaps.push('cmake_target_resolution_compile_database_conflict');
  }
  if (resolutionGaps.length > 0 || !resolvedTarget) {
    return buildRefusalResult({
      blockingGaps: resolutionGaps,
      candidateTargets,
      codemodelHash: codemodelDocument.contentHash,
      compileDatabase,
      declaredSourcePaths: normalizedDeclaredSources,
      method,
      replySetHash,
      requestedTargetName: normalizedRequestedName,
      requestedTargetType: normalizedRequestedType,
      sourceOwners,
    });
  }

  const result = {
    schemaVersion: GPU_HMR_CMAKE_TARGET_RESOLUTION_SCHEMA,
    proofAuthority: GPU_HMR_CMAKE_TARGET_RESOLUTION_AUTHORITY,
    status: 'target_resolution_accepted',
    method,
    requestedTargetName: normalizedRequestedName || null,
    requestedTargetType: normalizedRequestedType || null,
    resolvedTargetId: resolvedTarget.id,
    resolvedTargetName: resolvedTarget.name,
    resolvedTargetType: resolvedTarget.type,
    resolvedTargetArtifacts: resolvedTarget.artifacts,
    declaredSourcePaths: normalizedDeclaredSources,
    sourceOwners,
    candidateTargets,
    compileDatabaseStatus: compileDatabase.status,
    compileDatabaseSourcePaths: compileDatabase.sourcePaths,
    codemodelHash: codemodelDocument.contentHash,
    replySetHash,
    blockingGaps: [],
    accepted: true,
    acceptedAsTargetResolutionEvidence: true,
    acceptedAsRefusalEvidence: false,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
    canSatisfyDispatchProof: false,
  };
  result.evidenceHash = recomputeEvidenceHash(result);
  return result;
}

export function verifyCmakeTargetResolutionEvidence(evidence) {
  const candidateIds = Array.isArray(evidence?.candidateTargets)
    ? evidence.candidateTargets.map((candidate) => candidate?.id)
    : [];
  const candidatesValid = Array.isArray(evidence?.candidateTargets)
    && evidence.candidateTargets.every((candidate) => (
      exactKeys(candidate, CANDIDATE_TARGET_KEYS)
      && typeof candidate.id === 'string'
      && candidate.id.length > 0
      && typeof candidate.name === 'string'
      && candidate.name.length > 0
      && typeof candidate.type === 'string'
      && candidate.type.length > 0
      && isSortedUniqueStrings(candidate.artifacts)
      && isSortedUniqueStrings(candidate.directSourcePaths)
      && isSortedUniqueStrings(candidate.closureSourcePaths)
      && isSortedUniqueStrings(candidate.closureTargetIds)
      && HASH_PATTERN.test(candidate.documentHash ?? '')
    ));
  const ownersValid = Array.isArray(evidence?.sourceOwners)
    && evidence.sourceOwners.every((owner) => (
      exactKeys(owner, SOURCE_OWNER_KEYS)
      && typeof owner.sourcePath === 'string'
      && owner.sourcePath.length > 0
      && isSortedUniqueStrings(owner.directTargetIds)
      && isSortedUniqueStrings(owner.closureTargetIds)
      && typeof owner.compileDatabaseCovered === 'boolean'
    ));
  const accepted = evidence?.accepted === true;
  const resolvedCandidate = accepted
    ? evidence?.candidateTargets?.find((candidate) => candidate.id === evidence.resolvedTargetId)
    : null;
  if (
    !exactKeys(evidence, TARGET_RESOLUTION_EVIDENCE_KEYS)
    || evidence?.schemaVersion !== GPU_HMR_CMAKE_TARGET_RESOLUTION_SCHEMA
    || evidence?.proofAuthority !== GPU_HMR_CMAKE_TARGET_RESOLUTION_AUTHORITY
    || !['target_resolution_accepted', 'target_resolution_refused'].includes(evidence.status)
    || !['refused', 'requested_target_verified_by_codemodel', 'unique_source_owner']
      .includes(evidence.method)
    || !isSortedUniqueStrings(evidence.declaredSourcePaths)
    || !ownersValid
    || evidence.sourceOwners.length !== evidence.declaredSourcePaths.length
    || stableJson(evidence.sourceOwners.map((owner) => owner.sourcePath))
      !== stableJson(evidence.declaredSourcePaths)
    || !candidatesValid
    || !isSortedUniqueStrings(candidateIds)
    || !isSortedUniqueStrings(evidence.compileDatabaseSourcePaths)
    || !['absent', 'malformed', 'valid'].includes(evidence.compileDatabaseStatus)
    || !(evidence.codemodelHash === null || HASH_PATTERN.test(evidence.codemodelHash ?? ''))
    || !HASH_PATTERN.test(evidence.replySetHash ?? '')
    || !isSortedUniqueStrings(evidence.blockingGaps)
    || !HASH_PATTERN.test(evidence.evidenceHash ?? '')
    || evidence.acceptedForGpuHmr !== false
    || evidence.gpuHmrSuccess !== false
    || evidence.canSatisfyRuntimeProof !== false
    || evidence.canSatisfyDispatchProof !== false
    || evidence.accepted !== (evidence.blockingGaps.length === 0)
    || evidence.acceptedAsTargetResolutionEvidence !== evidence.accepted
    || evidence.acceptedAsRefusalEvidence !== !evidence.accepted
    || evidence.status !== (accepted ? 'target_resolution_accepted' : 'target_resolution_refused')
    || (
      accepted
      && (
        !resolvedCandidate
        || evidence.resolvedTargetName !== resolvedCandidate.name
        || evidence.resolvedTargetType !== resolvedCandidate.type
        || stableJson(evidence.resolvedTargetArtifacts) !== stableJson(resolvedCandidate.artifacts)
      )
    )
    || (
      !accepted
      && (
        evidence.resolvedTargetId !== null
        || evidence.resolvedTargetName !== null
        || evidence.resolvedTargetType !== null
        || !Array.isArray(evidence.resolvedTargetArtifacts)
        || evidence.resolvedTargetArtifacts.length !== 0
      )
    )
    || recomputeEvidenceHash(evidence) !== evidence.evidenceHash
  ) {
    throw new Error('cmake_target_resolution_evidence_invalid');
  }
  return evidence;
}
