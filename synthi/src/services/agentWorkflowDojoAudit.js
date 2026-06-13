'use client';

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function stringValue(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(stringValue)
    .filter(Boolean))];
}

function pushRef(refs, prefix, value) {
  const id = stringValue(value);
  if (id) refs.push(`${prefix}:${id}`);
}

function collectEvidenceFields(value, refs, depth = 0, seen = new Set()) {
  if (!value || depth > 5) return;
  if (typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);

  if (Array.isArray(value)) {
    value.forEach((item) => collectEvidenceFields(item, refs, depth + 1, seen));
    return;
  }

  Object.entries(value).forEach(([key, nested]) => {
    if (
      key === 'evidence_refs'
      || key === 'evidenceRefs'
      || key === 'evidence_record_ids'
      || key === 'evidenceRecordIds'
    ) {
      refs.push(...uniqueStrings(nested));
      return;
    }
    collectEvidenceFields(nested, refs, depth + 1, seen);
  });
}

export function collectDojoAuditEvidenceRefs({ workflowState, extraRefs = [] } = {}) {
  const state = asRecord(workflowState);
  const dojo = asRecord(state.dojo);
  const workflow = asRecord(state.workflow);
  const license = asRecord(dojo.license);
  const checkride = asRecord(dojo.checkride);
  const proof = asRecord(dojo.proof);
  const proofDryRun = asRecord(dojo.proofDryRun || dojo.proof_dry_run);
  const vivariumRun = asRecord(dojo.vivariumRun || dojo.vivarium_run);
  const windTunnel = asRecord(dojo.windTunnel || dojo.wind_tunnel);
  const caseLawRecord = asRecord(dojo.caseLawRecord || dojo.case_law_record);

  const refs = uniqueStrings(extraRefs);
  collectEvidenceFields(dojo, refs);

  pushRef(refs, 'skill', dojo.skillId || dojo.skill_id);
  pushRef(refs, 'workflow', dojo.workflowId || dojo.workflow_id || workflow.workflowId || workflow.workflow_id);
  pushRef(refs, 'license', dojo.licenseId || dojo.license_id || license.licenseId || license.license_id);
  pushRef(refs, 'checkride', checkride.checkrideId || checkride.checkride_id);
  pushRef(refs, 'proof', proof.capsuleId || proof.capsule_id);
  pushRef(refs, 'proof_dry_run', proofDryRun.runId || proofDryRun.run_id);
  pushRef(refs, 'vivarium', vivariumRun.runId || vivariumRun.run_id);
  pushRef(refs, 'wind_tunnel', windTunnel.runId || windTunnel.run_id);
  pushRef(refs, 'case_law', caseLawRecord.caseId || caseLawRecord.case_id);

  return uniqueStrings(refs);
}
