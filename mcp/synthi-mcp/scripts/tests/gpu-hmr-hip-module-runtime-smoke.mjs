#!/usr/bin/env node

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MCP_ROOT = path.resolve(__dirname, '../..');

async function readJson(relPath) {
  return JSON.parse(await fs.readFile(path.join(MCP_ROOT, relPath), 'utf8'));
}

function fail(message) {
  throw new Error(message);
}

const packageJson = await readJson('package.json');
const profile = await readJson('scripts/profiles/hip-module-runtime-readback.json');
const hot2Profile = await readJson('scripts/profiles/hip-module-runtime-readback-hot2.json');

if (!packageJson.scripts['proof:hip-module:runtime']) {
  fail('proof:hip-module:runtime script missing');
}
if (!packageJson.scripts['proof:hip-module:runtime:hot2']) {
  fail('proof:hip-module:runtime:hot2 script missing');
}
if (!packageJson.files.includes('scripts/gpu-hmr-hip-module-runtime-proof.mjs')) {
  fail('HIP module runtime proof runner missing from package files');
}
if (!packageJson.files.includes('scripts/probes/hip_module_runtime_probe.cpp')) {
  fail('HIP module probe missing from package files');
}
if (profile.validationScope !== 'explicit-hip-module-float32-readback') {
  fail('default HIP module profile scope is not explicit');
}
if (hot2Profile.validationScope !== 'explicit-hip-module-float32-readback') {
  fail('hot2 HIP module profile scope is not explicit');
}
if (profile.kernel?.launchApi !== 'hipModuleLaunchKernel') {
  fail('default HIP module profile must use hipModuleLaunchKernel');
}
if (hot2Profile.runMode?.metricScope !== 'hot_delta_2') {
  fail('hot2 profile must declare hot_delta_2');
}
if (!Array.isArray(profile.outputOracle?.expectedAfterValues) || profile.outputOracle.expectedAfterValues.length === 0) {
  fail('default HIP module profile must declare expected output');
}
if (!Array.isArray(hot2Profile.outputOracle?.expectedAfterValues) || hot2Profile.outputOracle.expectedAfterValues.length === 0) {
  fail('hot2 HIP module profile must declare expected output');
}

console.log(JSON.stringify({
  schema: 'synthi.gpu_hmr.hip_module_runtime_smoke.v1',
  passed: true,
  profiles: [profile.id, hot2Profile.id],
}, null, 2));
