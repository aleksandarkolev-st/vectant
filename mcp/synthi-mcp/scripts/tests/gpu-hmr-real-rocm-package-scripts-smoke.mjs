#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageJsonPath = path.resolve(__dirname, '..', '..', 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

const largeRocmScripts = [
  'proof:real-rocm:large-ml-miopen',
  'proof:real-rocm:large-ml-composable-kernel',
  'proof:real-rocm:large-ml-hipblaslt',
];

const failures = [];
for (const scriptName of largeRocmScripts) {
  const command = packageJson.scripts?.[scriptName];
  if (typeof command !== 'string') {
    failures.push(`${scriptName}:missing_script`);
    continue;
  }
  if (!command.includes("process.env.SYNTHI_REAL_ROCM_UPSTREAM_TIMEOUT_MS ??= '7200000'")) {
    failures.push(`${scriptName}:upstream_timeout_default_not_overridable`);
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
  upstreamTimeoutDefault: '7200000',
  callerOverridePreserved: true,
}, null, 2));
