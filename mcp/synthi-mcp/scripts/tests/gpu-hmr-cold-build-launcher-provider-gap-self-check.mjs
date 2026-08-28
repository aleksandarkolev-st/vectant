import assert from 'node:assert/strict';

import {
  coldBuildLauncherPublicationDescriptor,
} from '../lib/gpu-hmr-cold-build-container-contract.mjs';

const novelProviderIdentity = 'provider-defined-machine/future-v11';

const descriptor = await coldBuildLauncherPublicationDescriptor({
  architecture: novelProviderIdentity,
});
assert.equal(descriptor.normalizedArchitecture, novelProviderIdentity);
assert.equal(descriptor.builderRecipe.providerIdentity, novelProviderIdentity);
assert.equal(
  descriptor.builderRecipe.environment.some(
    (entry) => entry.startsWith('GOARCH=') || entry.startsWith('GOOS='),
  ),
  false,
);
assert.doesNotMatch(descriptor.relativeBinaryPath, /provider-defined-machine/);
assert.match(descriptor.publicationKeyHash, /^sha256:[0-9a-f]{64}$/);
assert.match(descriptor.relativeBinaryPath, /^cold-build-launcher\/publications\//);
await assert.rejects(
  coldBuildLauncherPublicationDescriptor({
    architecture: 'invalid\nprovider',
  }),
  /cold_build_launcher_target_provider_identity_invalid/,
);

console.log(JSON.stringify({
  status: 'self_check_passed',
  unknownProviderResult: 'admitted_to_reproducible_capability_observation',
  architectureUnsupportedResultEmitted: false,
  acceptedForGpuHmr: false,
  gpuHmrSuccess: false,
}, null, 2));
