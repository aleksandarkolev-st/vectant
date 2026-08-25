function resolveCorsPolicy({ origin, allowedOrigins, devBypass }) {
  if (!origin) {
    return { allowOrigin: '*', credentials: false };
  }

  const isAllowlisted = Boolean(allowedOrigins && allowedOrigins.includes(origin));
  const isLegacyOpen = allowedOrigins.length === 0 && devBypass === true;

  if (isAllowlisted || isLegacyOpen) {
    return { allowOrigin: origin, credentials: true };
  }

  return { allowOrigin: null, credentials: false };
}

module.exports = { resolveCorsPolicy };
