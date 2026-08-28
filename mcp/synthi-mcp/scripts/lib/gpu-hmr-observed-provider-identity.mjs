export const OBSERVED_PROVIDER_IDENTITY_LABEL_MAX_BYTES = 1024;

export function observedProviderIdentityLabelAccepted(value) {
  return typeof value === 'string'
    && value.length > 0
    && Buffer.byteLength(value, 'utf8')
      <= OBSERVED_PROVIDER_IDENTITY_LABEL_MAX_BYTES
    && !/[\0\r\n]/.test(value);
}
