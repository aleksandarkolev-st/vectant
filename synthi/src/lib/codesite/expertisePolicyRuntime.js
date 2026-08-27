import { EXPERTISE_POLICY, resolveExpertisePolicy } from './expertisePolicy';

export const EXPERTISE_POLICY_CONFIG_ENV = 'SYNTHI_CODESITE_EXPERTISE_POLICY_JSON';

function policyConfigError() {
  return Object.assign(new Error('codesite_expertise_policy_invalid'), {
    code: 'codesite_expertise_policy_invalid',
    status: 500,
  });
}

/**
 * Load a deployment-owned, versioned expertise policy at server startup.
 * Agent/request data is never consulted here. The default policy remains
 * available to browser-safe modules and to deployments without an override.
 */
export function loadExpertisePolicy(env = typeof process === 'undefined' ? {} : process.env) {
  const raw = env?.[EXPERTISE_POLICY_CONFIG_ENV];
  if (raw == null || !String(raw).trim()) return EXPERTISE_POLICY;

  let input;
  try {
    input = JSON.parse(String(raw));
  } catch (_) {
    throw policyConfigError();
  }
  if (!input || typeof input !== 'object' || Array.isArray(input) || !String(input.version || '').trim()) {
    throw policyConfigError();
  }
  return resolveExpertisePolicy(input);
}
