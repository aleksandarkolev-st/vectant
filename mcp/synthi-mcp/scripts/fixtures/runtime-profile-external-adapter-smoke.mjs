#!/usr/bin/env node

const profile = JSON.parse(process.env.SYNTHI_GPU_HMR_RUNTIME_PROFILE_JSON ?? '{}');

if (!profile.id || !profile.adapter?.family) {
  throw new Error('missing SYNTHI_GPU_HMR_RUNTIME_PROFILE_JSON');
}

console.log(JSON.stringify({
  schemaVersion: 'synthi.gpu.hmr.runtime_profile.adapter_smoke.v1',
  ok: true,
  profileId: profile.id,
  adapterFamily: profile.adapter.family,
}, null, 2));
