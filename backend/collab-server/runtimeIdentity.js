'use strict';

const crypto = require('crypto');

const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

function runtimeIdSecret() {
  return (
    process.env.SYNTHI_RUNTIME_ID_SECRET ||
    process.env.NEXTAUTH_SECRET ||
    process.env.AI_BACKEND_AUTH_TOKEN ||
    'synthi-local-runtime-id-secret'
  );
}

function base32NoPadding(buffer) {
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }

  return output;
}

function hmacBase32(value, length = 20) {
  const digest = crypto
    .createHmac('sha256', runtimeIdSecret())
    .update(String(value || 'unknown'))
    .digest();
  return base32NoPadding(digest).slice(0, length);
}

function runtimeResourceId(runtimeScope) {
  return `rt-${hmacBase32(runtimeScope, 20)}`;
}

function metadataHash(value, length = 20) {
  if (!value) return '';
  return hmacBase32(value, length);
}

function dnsLabelValue(value, fallback = 'unknown') {
  const cleaned = String(value || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .slice(0, 63);
  return cleaned || fallback;
}

module.exports = {
  runtimeResourceId,
  metadataHash,
  dnsLabelValue,
};
