#!/usr/bin/env node
// Generic source-first visual GPU-HMR proof launcher.
//
// This file selects runner inputs only. It does not authorize GPU-HMR success:
// acceptance still comes from the source-first runner, strict runtime ledger,
// epoch/dispatch proof, output oracle bytes, and validation-matrix recompute.

function readOption(args, name) {
  const prefix = `${name}=`;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === name) return args[index + 1] ?? '';
    if (typeof value === 'string' && value.startsWith(prefix)) {
      return value.slice(prefix.length);
    }
  }
  return '';
}

function setDefaultEnv(name, value) {
  if (process.env[name] == null || process.env[name] === '') {
    process.env[name] = value;
  }
}

const args = process.argv.slice(2);
const fixture = readOption(args, '--fixture') || process.env.SYNTHI_GPU_AGENT_FIXTURE || '';
const profile = readOption(args, '--profile') || process.env.SYNTHI_GPU_AGENT_PROFILE_PATH || '';
const sourceManifest =
  readOption(args, '--source-manifest')
  || process.env.SYNTHI_GPU_AGENT_SOURCE_MANIFEST_PATH
  || process.env.SYNTHI_GPU_AGENT_DIRECT_SOURCE_MANIFEST_PATH
  || '';
const sourceRoot =
  readOption(args, '--source-root')
  || process.env.SYNTHI_GPU_AGENT_SOURCE_ROOT
  || process.env.SYNTHI_GPU_AGENT_DIRECT_SOURCE_ROOT
  || '';
const sourceAuthority =
  readOption(args, '--source-authority')
  || process.env.SYNTHI_GPU_AGENT_SOURCE_AUTHORITY
  || process.env.SYNTHI_GPU_AGENT_DIRECT_SOURCE_AUTHORITY
  || '';
const vendor = readOption(args, '--vendor') || process.env.SYNTHI_GPU_VENDOR || 'rocm';

if (fixture && profile) {
  throw new Error('choose either --fixture or --profile, not both');
}

if (fixture) process.env.SYNTHI_GPU_AGENT_FIXTURE = fixture;
if (profile) process.env.SYNTHI_GPU_AGENT_PROFILE_PATH = profile;
if (sourceManifest) {
  process.env.SYNTHI_GPU_AGENT_SOURCE_MANIFEST_PATH = sourceManifest;
  process.env.SYNTHI_GPU_AGENT_DIRECT_SOURCE_MANIFEST_PATH = sourceManifest;
}
if (sourceRoot) {
  process.env.SYNTHI_GPU_AGENT_SOURCE_ROOT = sourceRoot;
  process.env.SYNTHI_GPU_AGENT_DIRECT_SOURCE_ROOT = sourceRoot;
}
if (sourceAuthority) {
  process.env.SYNTHI_GPU_AGENT_SOURCE_AUTHORITY = sourceAuthority;
  process.env.SYNTHI_GPU_AGENT_DIRECT_SOURCE_AUTHORITY = sourceAuthority;
}

setDefaultEnv('SYNTHI_GPU_AGENT_CAPTURE_ARTIFACTS', '1');
setDefaultEnv('SYNTHI_SYNC_TO_GCS', '0');
setDefaultEnv('SYNTHI_VALIDATION_AUTHLESS_WORKSPACE', '1');
setDefaultEnv('SYNTHI_GPU_VENDOR', vendor);

await import('./gpu-hmr-agent-split-workspace-test.mjs');
