import { evaluateGpuHmrAcceptanceContract } from './gpu-hmr-acceptance-contract.mjs';
import { queryGpuHmrLedgerInvariants } from './gpu-hmr-proof-ledger.mjs';

export const GPU_HMR_STRICT_PROOF_GATES_SCHEMA_VERSION =
  'synthi.gpu_hmr.strict_proof_gates.v1';

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function compactStrings(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value ?? '').trim())
    .filter(Boolean))];
}

function firstObject(...values) {
  return values.find((value) => isObject(value)) ?? null;
}

function sortedCodes(values) {
  return compactStrings((Array.isArray(values) ? values : [])
    .map((value) => value?.code ?? value))
    .sort();
}

function sameCodes(a, b) {
  const left = sortedCodes(a);
  const right = sortedCodes(b);
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function gateRow(name, failures, successDetail) {
  const normalizedFailures = compactStrings(failures);
  return {
    schemaVersion: GPU_HMR_STRICT_PROOF_GATES_SCHEMA_VERSION,
    name,
    status: normalizedFailures.length === 0 ? 'pass' : 'fail',
    accepted: normalizedFailures.length === 0,
    failures: normalizedFailures,
    detail: normalizedFailures.length === 0
      ? successDetail
      : `failures=${normalizedFailures.join(',')}`,
  };
}

function proofArtifactFromRecord(record) {
  if (isObject(record?.artifact)) return record.artifact;
  if (isObject(record)) return record;
  return null;
}

function proofArtifactLabel(record, index) {
  const candidate = record?.label
    ?? record?.name
    ?? record?.proofId
    ?? record?.proof_id
    ?? record?.artifact?.proofId
    ?? record?.artifact?.proof_id
    ?? `artifact-${index + 1}`;
  return String(candidate || `artifact-${index + 1}`).replace(/\s+/g, '-');
}

export function adversarialPreflightStrictGate(preflight, options = {}) {
  const failures = [];
  if (!isObject(preflight)) {
    failures.push('adversarial_preflight_missing');
  } else {
    if (preflight.skipped === true) failures.push('adversarial_preflight_skipped');
    if (preflight.ok !== true) failures.push('adversarial_preflight_not_ok');
    if (Number.isFinite(preflight.exitCode) && preflight.exitCode !== 0) {
      failures.push('adversarial_preflight_exit_nonzero');
    }
    if (preflight.error) failures.push('adversarial_preflight_error_present');
    if (typeof preflight.scriptPath !== 'string' || !preflight.scriptPath.trim()) {
      failures.push('adversarial_preflight_script_path_missing');
    }
    if (typeof preflight.stdoutHash !== 'string' || !preflight.stdoutHash.trim()) {
      failures.push('adversarial_preflight_stdout_hash_missing');
    }
    if (typeof preflight.stderrHash !== 'string' || !preflight.stderrHash.trim()) {
      failures.push('adversarial_preflight_stderr_hash_missing');
    }
  }
  return gateRow(
    options.name ?? 'strict adversarial preflight acceptance',
    failures,
    `script=${preflight?.scriptPath ?? 'unknown'} elapsed_ms=${Number(preflight?.elapsedMs ?? 0).toFixed(1)}`,
  );
}

export function runtimeProofArtifactStrictGate(record, options = {}) {
  const artifact = proofArtifactFromRecord(record);
  const failures = [];
  if (!artifact) {
    failures.push('runtime_proof_artifact_missing');
  } else {
    const proofLedgerQuery = firstObject(
      artifact.proofLedgerQuery,
      artifact.proof_ledger_query,
    );
    const proofLedger = firstObject(
      artifact.proofLedger,
      artifact.proof_ledger,
    );
    const acceptanceContract = firstObject(
      artifact.acceptanceContract,
      artifact.acceptance_contract,
    );
    const acceptanceContractEvaluation = firstObject(
      artifact.acceptanceContractEvaluation,
      artifact.acceptance_contract_evaluation,
    );
    const acceptanceContractConsistency = firstObject(
      artifact.acceptanceContractConsistency,
      artifact.acceptance_contract_consistency,
    );
    const gpuHmrSuccess = artifact.gpuHmrSuccess === true
      || artifact.gpu_hmr_success === true;

    if (artifact.fullRuntimeProven !== true && artifact.full_runtime_proven !== true) {
      failures.push('runtime_full_proof_not_proven');
    }
    if (!gpuHmrSuccess) failures.push('runtime_proof_artifact_gpu_hmr_success_false');
    if (!proofLedger) {
      failures.push('proof_ledger_missing');
    } else {
      const recomputedProofLedgerQuery = queryGpuHmrLedgerInvariants(proofLedger);
      if (recomputedProofLedgerQuery.gpuHmrSuccess !== true) {
        failures.push('proof_ledger_recomputed_query_rejected');
      }
      if (
        proofLedgerQuery
        && (
          proofLedgerQuery.gpuHmrSuccess !== recomputedProofLedgerQuery.gpuHmrSuccess
          || !sameCodes(proofLedgerQuery.failedInvariants, recomputedProofLedgerQuery.failedInvariants)
        )
      ) {
        failures.push('proof_ledger_query_mismatch');
      }
    }
    if (!proofLedgerQuery) {
      failures.push('proof_ledger_query_missing');
    } else if (proofLedgerQuery.gpuHmrSuccess !== true) {
      failures.push('proof_ledger_query_rejected');
    }
    if (!acceptanceContract) {
      failures.push('acceptance_contract_missing');
    } else {
      const recomputedAcceptance = evaluateGpuHmrAcceptanceContract(acceptanceContract);
      if (recomputedAcceptance.accepted !== true) {
        failures.push('acceptance_contract_recomputed_rejected');
      }
      if (
        acceptanceContractEvaluation
        && (
          acceptanceContractEvaluation.accepted !== recomputedAcceptance.accepted
          || !sameCodes(acceptanceContractEvaluation.failedGates, recomputedAcceptance.failedGates)
        )
      ) {
        failures.push('acceptance_contract_evaluation_mismatch');
      }
    }
    if (!acceptanceContractEvaluation) {
      failures.push('acceptance_contract_evaluation_missing');
    } else if (acceptanceContractEvaluation.accepted !== true) {
      failures.push('acceptance_contract_rejected');
    }
    if (!acceptanceContractConsistency) {
      failures.push('acceptance_contract_consistency_missing');
    } else if (acceptanceContractConsistency.accepted !== true) {
      failures.push('acceptance_contract_consistency_rejected');
    }
  }
  return gateRow(
    options.name ?? 'strict runtime proof artifact acceptance',
    failures,
    `proof_id=${artifact?.proofId ?? artifact?.proof_id ?? 'unknown'}`,
  );
}

export function runtimeProofArtifactStrictGates(records, options = {}) {
  const list = Array.isArray(records) ? records.filter(Boolean) : [];
  if (list.length === 0 && options.requireAtLeastOne !== false) {
    return [
      gateRow(
        options.missingName ?? 'strict runtime proof artifact presence',
        ['runtime_proof_artifact_missing'],
        'runtime proof artifact present',
      ),
    ];
  }
  return list.map((record, index) => runtimeProofArtifactStrictGate(record, {
    name: `${options.namePrefix ?? 'strict runtime proof artifact acceptance'} ${proofArtifactLabel(record, index)}`,
  }));
}

export function strictProofGateFailures(rows) {
  return (Array.isArray(rows) ? rows : []).filter((row) => row?.status === 'fail');
}
