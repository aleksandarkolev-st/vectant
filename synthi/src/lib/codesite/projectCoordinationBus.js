export const PROJECT_COORDINATION_PIPELINE = Object.freeze([
  'normalize',
  'redact',
  'classify',
  'correlate',
  'authorize',
  'persist',
  'route',
]);

const SENSITIVE_KEYS = new Set([
  'prompt',
  'rawprompt',
  'systemprompt',
  'developerprompt',
  'chainofthought',
  'hiddenreasoning',
  'reasoningtrace',
  'transcript',
  'terminaltranscript',
  'terminalhistory',
  'shellhistory',
  'conversationhistory',
  'provideraccount',
  'provideraccountstate',
  'providerbilling',
  'billingcontext',
  'providersessionmemory',
  'providersessionref',
  'secret',
  'secrets',
  'credential',
  'credentials',
  'password',
  'passwd',
  'apikey',
  'accesstoken',
  'authtoken',
  'bearertoken',
  'refreshtoken',
  'sessiontoken',
  'privatekey',
  'cookie',
  'cookies',
  'environmentvalues',
  'environmentvariables',
  'localenvironmentvariables',
]);

const SECRET_VALUE_PATTERNS = Object.freeze([
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i,
  /\b(?:authorization|proxy-authorization|x-api-key)\s*[:=]\s*(?:bearer\s+)?\S+/i,
  /\b(?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|client[-_ ]?secret|password|passwd)\s*[:=]\s*["']?\S+/i,
  /(?:https?|ssh|postgres(?:ql)?|mysql|redis):\/\/[^\s/@:]+:[^\s/@]+@/i,
]);

const MAX_SCAN_DEPTH = 32;
const MAX_SCAN_NODES = 10_000;

export class ProjectCoordinationBusError extends Error {
  constructor(code, { stage = null, status = 422, details = null, cause = null } = {}) {
    super(code, cause ? { cause } : undefined);
    this.name = 'ProjectCoordinationBusError';
    this.code = code;
    this.stage = stage;
    this.status = status;
    this.details = details;
  }
}

function coordinationError(code, options) {
  return new ProjectCoordinationBusError(code, options);
}

function normalizedKey(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function keyContainsPrivateMaterial(key) {
  const normalized = normalizedKey(key);
  if (SENSITIVE_KEYS.has(normalized)) return true;
  return /(?:^|raw)(?:prompt|transcript)$/.test(normalized)
    || /(?:secret|credential|password|privatekey)$/.test(normalized)
    || /(?:access|auth|bearer|refresh|session|api)token$/.test(normalized)
    || /^provideraccount/.test(normalized)
    || /^providersession(?:memory|ref)/.test(normalized);
}

function stringContainsSecretMaterial(value) {
  return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

function scanShareableValue(value, { stage, path = '$', seen = new WeakSet(), state = { nodes: 0 }, depth = 0 } = {}) {
  state.nodes += 1;
  if (state.nodes > MAX_SCAN_NODES || depth > MAX_SCAN_DEPTH) {
    throw coordinationError('coordination_payload_too_complex', {
      stage,
      details: { path, maxDepth: MAX_SCAN_DEPTH, maxNodes: MAX_SCAN_NODES },
    });
  }

  if (typeof value === 'string') {
    if (stringContainsSecretMaterial(value)) {
      throw coordinationError('coordination_private_material_rejected', {
        stage,
        details: { path, reason: 'secret_value' },
      });
    }
    return;
  }
  if (value == null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw coordinationError('coordination_payload_not_serializable', {
        stage,
        details: { path, reason: 'non_finite_number' },
      });
    }
    return;
  }
  if (typeof value !== 'object') {
    throw coordinationError('coordination_payload_not_serializable', {
      stage,
      details: { path, reason: typeof value },
    });
  }
  if (seen.has(value)) {
    throw coordinationError('coordination_payload_not_serializable', {
      stage,
      details: { path, reason: 'cycle' },
    });
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && !Array.isArray(value)) {
    throw coordinationError('coordination_payload_not_serializable', {
      stage,
      details: { path, reason: 'non_plain_object' },
    });
  }

  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanShareableValue(item, {
      stage,
      path: `${path}[${index}]`,
      seen,
      state,
      depth: depth + 1,
    }));
  } else {
    for (const [key, item] of Object.entries(value)) {
      const itemPath = `${path}.${key}`;
      if (keyContainsPrivateMaterial(key)) {
        throw coordinationError('coordination_private_material_rejected', {
          stage,
          details: { path: itemPath, reason: 'private_field' },
        });
      }
      scanShareableValue(item, {
        stage,
        path: itemPath,
        seen,
        state,
        depth: depth + 1,
      });
    }
  }
  seen.delete(value);
}

function requireObject(value, stage) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw coordinationError('coordination_stage_result_invalid', {
      stage,
      details: { expected: 'object' },
    });
  }
  return value;
}

function requireIdentity(event, stage) {
  requireObject(event, stage);
  for (const field of ['id', 'projectId', 'eventType']) {
    if (typeof event[field] !== 'string' || !event[field].trim()) {
      throw coordinationError('coordination_event_identity_invalid', {
        stage,
        details: { field },
      });
    }
  }
  if (!event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) {
    throw coordinationError('coordination_event_payload_invalid', {
      stage,
      details: { field: 'payload' },
    });
  }
  return event;
}

function requirePinnedIdentity(event, identity, stage) {
  requireIdentity(event, stage);
  for (const field of ['id', 'projectId', 'eventType']) {
    if (event[field] !== identity[field]) {
      throw coordinationError('coordination_event_identity_changed', {
        stage,
        details: { field },
      });
    }
  }
  return event;
}

function normalizeAuthorization(value) {
  if (value === true) return Object.freeze({ allowed: true, recipients: [] });
  requireObject(value, 'authorize');
  if (value.allowed !== true) {
    throw coordinationError('coordination_event_not_authorized', {
      stage: 'authorize',
      status: 403,
      details: {
        reason: typeof value.reason === 'string' ? value.reason : 'denied',
      },
    });
  }
  if (value.recipients != null && !Array.isArray(value.recipients)) {
    throw coordinationError('coordination_authorization_invalid', {
      stage: 'authorize',
      details: { field: 'recipients' },
    });
  }
  return {
    ...value,
    recipients: value.recipients ? [...value.recipients] : [],
  };
}

async function invokeStage(stage, adapter, value, metadata) {
  try {
    return await adapter(value, Object.freeze({ ...metadata, stage }));
  } catch (error) {
    if (error instanceof ProjectCoordinationBusError) throw error;
    throw coordinationError('coordination_stage_failed', {
      stage,
      status: 500,
      details: { message: error instanceof Error ? error.message : String(error) },
      cause: error instanceof Error ? error : null,
    });
  }
}

export function createProjectCoordinationBus(adapters) {
  requireObject(adapters, 'configure');
  for (const stage of PROJECT_COORDINATION_PIPELINE) {
    if (typeof adapters[stage] !== 'function') {
      throw coordinationError('coordination_adapter_required', {
        stage: 'configure',
        details: { adapter: stage },
      });
    }
  }

  return Object.freeze({
    async publish(input, context = {}) {
      const metadata = { context };
      const normalized = requireIdentity(
        await invokeStage('normalize', adapters.normalize, input, metadata),
        'normalize',
      );
      const identity = Object.freeze({
        id: normalized.id,
        projectId: normalized.projectId,
        eventType: normalized.eventType,
      });

      // The redaction boundary is fail-closed. Inspect both the source and the
      // normalized event so a normalizer cannot silently launder private input.
      scanShareableValue(input, { stage: 'redact' });
      scanShareableValue(normalized, { stage: 'redact' });
      const redacted = requirePinnedIdentity(
        await invokeStage('redact', adapters.redact, normalized, metadata),
        identity,
        'redact',
      );
      scanShareableValue(redacted, { stage: 'redact' });

      const classified = requirePinnedIdentity(
        await invokeStage('classify', adapters.classify, redacted, metadata),
        identity,
        'classify',
      );
      scanShareableValue(classified, { stage: 'classify' });

      const correlated = requirePinnedIdentity(
        await invokeStage('correlate', adapters.correlate, classified, metadata),
        identity,
        'correlate',
      );
      scanShareableValue(correlated, { stage: 'correlate' });

      const authorization = normalizeAuthorization(
        await invokeStage('authorize', adapters.authorize, correlated, metadata),
      );
      scanShareableValue(authorization, { stage: 'authorize' });

      const deliveryMetadata = { context, authorization };
      const persisted = requirePinnedIdentity(
        await invokeStage('persist', adapters.persist, correlated, deliveryMetadata),
        identity,
        'persist',
      );
      scanShareableValue(persisted, { stage: 'persist' });

      const delivery = await invokeStage('route', adapters.route, persisted, deliveryMetadata);
      scanShareableValue(delivery, { stage: 'route' });
      return Object.freeze({
        event: persisted,
        authorization,
        delivery,
      });
    },
  });
}
