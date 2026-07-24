import assert from 'node:assert/strict';

import {
  coldBuildLauncherExpectedHash,
  coldBuildLauncherPublicationDescriptor,
} from '../lib/gpu-hmr-cold-build-container-contract.mjs';

const novelProviderIdentity = 'provider-defined-machine/future-v11';

assert.equal(coldBuildLauncherExpectedHash(novelProviderIdentity), null);
await assert.rejects(
  coldBuildLauncherPublicationDescriptor({
    architecture: novelProviderIdentity,
  }),
  /cold_build_launcher_reproducible_identity_capability_missing/,
);
await assert.rejects(
  coldBuildLauncherPublicationDescriptor({
    architecture: 'invalid\nprovider',
  }),
  /cold_build_launcher_target_provider_identity_invalid/,
);

console.log(JSON.stringify({
  status: 'self_check_passed',
  unknownProviderResult: 'reproducible_identity_capability_missing',
  architectureUnsupportedResultEmitted: false,
  acceptedForGpuHmr: false,
  gpuHmrSuccess: false,
}, null, 2));
