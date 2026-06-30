import { digest } from './policy';
import { stableJson } from './json';

export function buildProofBundle({
  project,
  transaction,
  mutationLease,
  proofBundle,
  incidents = [],
  landingRuns = [],
  lineProvenance = [],
} = {}) {
  const payload = {
    schemaVersion: 'synthi.codesite.proofBundle.v1',
    projectId: project?.id || proofBundle?.projectId || transaction?.projectId,
    workspaceSlug: project?.workspaceSlug || null,
    transactionId: transaction?.id || proofBundle?.transactionId,
    mutationLeaseId: mutationLease?.id || transaction?.mutationLeaseId,
    displayCallsign: mutationLease?.displayCallsign || null,
    landingStatus: proofBundle?.landingStatus || proofBundle?.landing_status || landingStatusForRuns(landingRuns),
    readSetDigest: proofBundle?.readSetDigest || digest(transaction?.readSet || []),
    writeSetDigest: proofBundle?.writeSetDigest || digest(transaction?.writeSet || []),
    invariants: proofBundle?.invariants || transaction?.invariants || [],
    evidenceRefs: proofBundle?.evidenceRefs || [],
    dojoEvidenceRefs: proofBundle?.dojoEvidenceRefs || [],
    repoState: proofBundle?.repoState || null,
    incidentReplayDigest: proofBundle?.incidentReplayDigest || null,
    bundleDigest: proofBundle?.bundleDigest || null,
    incidents: incidents.map((incident) => ({
      id: incident.id,
      severity: incident.severity,
      category: incident.category,
      replayDigest: incident.replayDigest,
    })),
    lineProvenance: lineProvenance.map((row) => ({
      filePath: row.filePath,
      lineAnchor: row.lineAnchor,
      displayCallsign: row.displayCallsign,
      proofBundleId: row.proofBundleId,
    })),
    createdAt: normalizeProofTimestamp(proofBundle?.createdAt) || new Date().toISOString(),
  };
  return {
    ...payload,
    portableDigest: digest(payload),
  };
}

function landingStatusForRuns(runs = []) {
  if (!runs.length) return null;
  if (runs.some((run) => ['failed', 'blocked', 'red'].includes(String(run.status || '').toLowerCase()))) {
    return 'go-around';
  }
  const latest = runs.at(-1);
  return latest?.status || 'landed';
}

function normalizeProofTimestamp(value) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && value.trim()) return value;
  return null;
}

export function proofCommitTrailers(proofBundle) {
  const bundle = proofBundle?.schemaVersion === 'synthi.codesite.proofBundle.v1'
    ? proofBundle
    : buildProofBundle({ proofBundle });
  return {
    'CodeSite-Project': bundle.projectId,
    'CodeSite-Flight': bundle.displayCallsign,
    'CodeSite-Clearance': bundle.mutationLeaseId,
    'CodeSite-Landing': bundle.landingStatus,
    'CodeSite-Transaction': bundle.transactionId,
    'CodeSite-Lease': bundle.mutationLeaseId,
    'CodeSite-Read-Set': bundle.readSetDigest,
    'CodeSite-Write-Set': bundle.writeSetDigest,
    'CodeSite-Invariants': (bundle.invariants || []).join(','),
    'CodeSite-Black-Box': bundle.incidentReplayDigest || bundle.bundleDigest || bundle.portableDigest,
  };
}

export function formatCommitTrailers(proofBundle) {
  return Object.entries(proofCommitTrailers(proofBundle))
    .filter(([, value]) => value != null && value !== '')
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');
}

export function verifyProofBundle(bundle) {
  if (!bundle || typeof bundle !== 'object') {
    return { ok: false, reasonCodes: ['invalid_bundle'] };
  }
  const { portableDigest, ...unsigned } = bundle;
  const expected = digest(unsigned);
  const legacyDateDigest = legacyDateObjectDigest(unsigned);
  const legacyDateDigestMatched = Boolean(portableDigest && legacyDateDigest && portableDigest === legacyDateDigest);
  const ok = !portableDigest || portableDigest === expected || legacyDateDigestMatched;
  return {
    ok,
    reasonCodes: ok
      ? [
        'proof_bundle_digest_valid',
        ...(legacyDateDigestMatched ? ['proof_bundle_legacy_date_digest_valid'] : []),
      ]
      : ['proof_bundle_digest_mismatch'],
    expectedDigest: expected,
    legacyDateDigest,
    observedDigest: portableDigest || null,
    canonicalJson: stableJson(unsigned),
  };
}

function legacyDateObjectDigest(unsigned) {
  if (!unsigned || typeof unsigned.createdAt !== 'string') return null;
  return digest({ ...unsigned, createdAt: {} });
}
