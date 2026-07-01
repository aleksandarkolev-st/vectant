#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, '..', '..');
const packageJsonPath = path.resolve(packageRoot, 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

const packageFiles = new Set(packageJson.files ?? []);
const largeRocmScripts = [
  'proof:real-rocm:large-ml-miopen',
  'proof:real-rocm:large-ml-composable-kernel',
  'proof:real-rocm:large-ml-hipblaslt',
];
const largeRocmProfiles = [
  {
    id: 'real-rocm-miopen-activation-large-ml',
    path: 'scripts/profiles/real-rocm-miopen-activation-large-ml.json',
  },
  {
    id: 'real-rocm-composable-kernel-gemm-large-ml',
    path: 'scripts/profiles/real-rocm-composable-kernel-gemm-large-ml.json',
  },
  {
    id: 'real-rocm-hipblaslt-gelu-aux-bias-large-ml',
    path: 'scripts/profiles/real-rocm-hipblaslt-gelu-aux-bias-large-ml.json',
  },
];
const runtimeAdapterSuccessAuthorityKeys = new Set([
  'acceptedForGpuHmr',
  'accepted_for_gpu_hmr',
  'gpuHmrSuccess',
  'gpu_hmr_success',
  'canSatisfyRuntimeProof',
  'can_satisfy_runtime_proof',
  'strictRuntimeProofAccepted',
  'strict_runtime_proof_accepted',
  'proofAuthority',
  'proof_authority',
  'runtimeAuthority',
  'runtime_authority',
  'dispatchAuthority',
  'dispatch_authority',
]);

function hasUnsafeRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0) return true;
  const normalized = value.replace(/\\/g, '/');
  return (
    normalized.startsWith('/')
    || /^[A-Za-z]:\//.test(normalized)
    || normalized.split('/').some((part) => !part || part === '.' || part === '..')
  );
}

function normalizePackagePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function proofRunnerPathsFromCommand(command) {
  const normalized = normalizePackagePath(command);
  const paths = new Set();
  for (const match of normalized.matchAll(/\bnode\s+(scripts\/[^\s"'`]+\.mjs)\b/g)) {
    paths.add(match[1]);
  }
  for (const match of normalized.matchAll(/import\(['"]\.\/(scripts\/[^'"]+\.mjs)['"]\)/g)) {
    paths.add(match[1]);
  }
  return [...paths].filter((scriptPath) => !scriptPath.startsWith('scripts/tests/')).sort();
}

function packageFilesContains(filePath) {
  const normalized = normalizePackagePath(filePath);
  if (packageFiles.has(normalized)) return true;
  for (const entry of packageFiles) {
    const normalizedEntry = normalizePackagePath(entry);
    if (normalizedEntry.endsWith('/**') && normalized.startsWith(normalizedEntry.slice(0, -3))) {
      return true;
    }
    if (!normalizedEntry.includes('*') && normalized.startsWith(`${normalizedEntry.replace(/\/+$/, '')}/`)) {
      return true;
    }
  }
  return false;
}

const failures = [];
const packageProofRunnerFiles = new Map();
for (const [scriptName, command] of Object.entries(packageJson.scripts ?? {})) {
  if (!scriptName.startsWith('proof:') || scriptName.endsWith(':self-check')) continue;
  for (const runnerPath of proofRunnerPathsFromCommand(command)) {
    const previous = packageProofRunnerFiles.get(runnerPath) ?? [];
    packageProofRunnerFiles.set(runnerPath, [...previous, scriptName]);
  }
}
for (const [runnerPath, scriptNames] of [...packageProofRunnerFiles.entries()].sort()) {
  if (!packageFilesContains(runnerPath)) {
    failures.push(`${runnerPath}:proof_runner_not_packaged:${scriptNames.join(',')}`);
  }
}

for (const scriptName of largeRocmScripts) {
  const command = packageJson.scripts?.[scriptName];
  if (typeof command !== 'string') {
    failures.push(`${scriptName}:missing_script`);
    continue;
  }
  if (!command.includes("process.env.SYNTHI_REAL_ROCM_UPSTREAM_TIMEOUT_MS ??= '7200000'")) {
    failures.push(`${scriptName}:upstream_timeout_default_not_overridable`);
  }
  if (!command.includes('process.env.SYNTHI_REAL_ROCM_UPSTREAM_TIMEOUT_SOURCE ??=')) {
    failures.push(`${scriptName}:upstream_timeout_source_missing`);
  }
  if (!command.includes("? 'package_default' : 'caller_env'")) {
    failures.push(`${scriptName}:upstream_timeout_source_default_not_classified`);
  }
  if (command.includes("process.env.SYNTHI_REAL_ROCM_UPSTREAM_TIMEOUT_MS='7200000'")) {
    failures.push(`${scriptName}:upstream_timeout_forced`);
  }
  if (!command.includes('SYNTHI_REAL_ROCM_PROFILE_PATH=')) {
    failures.push(`${scriptName}:profile_path_missing`);
  }
  if (!command.includes("process.env.SYNTHI_REAL_ROCM_REQUIRE_FULL_RUNTIME_PROOF='1'")) {
    failures.push(`${scriptName}:strict_runtime_gate_missing`);
  }
  if (!command.includes("process.env.SYNTHI_REAL_ROCM_NATIVE_LAUNCH_OBSERVER='1'")) {
    failures.push(`${scriptName}:native_observer_missing`);
  }
}
for (const profile of largeRocmProfiles) {
  const profilePath = path.resolve(packageRoot, profile.path);
  let profileJson;
  try {
    profileJson = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
  } catch (error) {
    failures.push(`${profile.id}:profile_json_unreadable:${error.message}`);
    continue;
  }
  if (profileJson.id !== profile.id) {
    failures.push(`${profile.id}:profile_id_mismatch`);
  }
  const adapter = profileJson.runtimeAdapter;
  if (!adapter || typeof adapter !== 'object' || Array.isArray(adapter)) {
    failures.push(`${profile.id}:runtime_adapter_missing`);
    continue;
  }
  if (adapter.enabled !== true) {
    failures.push(`${profile.id}:runtime_adapter_not_enabled`);
  }
  if (adapter.template !== 'runtime_boundary_log_harvest_v1') {
    failures.push(`${profile.id}:runtime_adapter_template_not_generic`);
  }
  if (
    Object.hasOwn(adapter, 'command')
    || Object.hasOwn(adapter, 'shellCommand')
    || Object.hasOwn(adapter, 'shell_command')
  ) {
    failures.push(`${profile.id}:runtime_adapter_profile_command_must_use_template`);
  }
  if (adapter.workingDirectory !== '.') {
    failures.push(`${profile.id}:runtime_adapter_working_directory_not_repo_root`);
  }
  if (adapter.runWhen !== 'after_lifecycle_attempt') {
    failures.push(`${profile.id}:runtime_adapter_run_when_not_lifecycle_attempt`);
  }
  if (adapter.requiresSuccessfulBuild !== false || adapter.requiresSuccessfulRun !== false) {
    failures.push(`${profile.id}:runtime_adapter_should_not_require_successful_upstream_lifecycle`);
  }
  if (hasUnsafeRelativePath(adapter.resultPath)) {
    failures.push(`${profile.id}:runtime_adapter_result_path_unsafe`);
  } else if (
    !adapter.resultPath.startsWith('.gpu-hmr-test-logs/real-rocm-runtime-adapter-results/')
    || !adapter.resultPath.endsWith(`${profile.id}-runtime-adapter.json`)
  ) {
    failures.push(`${profile.id}:runtime_adapter_result_path_not_profile_bound`);
  }
  const adapterKeys = Object.keys(adapter);
  for (const key of adapterKeys) {
    if (runtimeAdapterSuccessAuthorityKeys.has(key)) {
      failures.push(`${profile.id}:runtime_adapter_declares_success_authority:${key}`);
    }
  }
  if (!Array.isArray(adapter.evidenceRefs) || !adapter.evidenceRefs.includes(
    'real-rocm-runtime-adapter-template:runtime_boundary_log_harvest_v1',
  )) {
    failures.push(`${profile.id}:runtime_adapter_template_evidence_ref_missing`);
  }
  if (profileJson.proofObligations?.acceptanceMode !== 'refusal_only') {
    failures.push(`${profile.id}:large_rocm_profile_not_refusal_only`);
  }
}

if (failures.length > 0) {
  console.error(JSON.stringify({
    ok: false,
    schemaVersion: 'synthi.gpu_hmr.real_rocm_package_scripts_smoke.v1',
    failures,
  }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  schemaVersion: 'synthi.gpu_hmr.real_rocm_package_scripts_smoke.v1',
  largeRocmScripts,
  largeRocmProfiles: largeRocmProfiles.map((profile) => profile.id),
  packagedProofRunnerFiles: [...packageProofRunnerFiles.keys()].sort(),
  runtimeAdapterTemplate: 'runtime_boundary_log_harvest_v1',
  upstreamTimeoutDefault: '7200000',
  upstreamTimeoutSourceRecorded: true,
  callerOverridePreserved: true,
}, null, 2));
