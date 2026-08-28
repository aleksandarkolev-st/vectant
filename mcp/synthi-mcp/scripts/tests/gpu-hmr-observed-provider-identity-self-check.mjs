import assert from 'node:assert/strict';

import {
  OBSERVED_PROVIDER_IDENTITY_LABEL_MAX_BYTES,
  observedProviderIdentityLabelAccepted,
} from '../lib/gpu-hmr-observed-provider-identity.mjs';

assert.equal(
  observedProviderIdentityLabelAccepted('provider-defined/identity:future-v7'),
  true,
);
assert.equal(
  observedProviderIdentityLabelAccepted('x'.repeat(
    OBSERVED_PROVIDER_IDENTITY_LABEL_MAX_BYTES,
  )),
  true,
);
assert.equal(observedProviderIdentityLabelAccepted(''), false);
assert.equal(observedProviderIdentityLabelAccepted('line\nbreak'), false);
assert.equal(observedProviderIdentityLabelAccepted('nul\0byte'), false);
assert.equal(
  observedProviderIdentityLabelAccepted('x'.repeat(
    OBSERVED_PROVIDER_IDENTITY_LABEL_MAX_BYTES + 1,
  )),
  false,
);
assert.equal(observedProviderIdentityLabelAccepted(null), false);

console.log(JSON.stringify({
  status: 'self_check_passed',
  openVocabularyIdentityAccepted: true,
  invalidIdentityRejected: true,
}, null, 2));
