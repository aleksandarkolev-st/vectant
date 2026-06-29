import crypto from 'crypto';
import { asArray, stableJson } from './json';

export const AIRSPACE_CLASSES = {
  A: {
    label: 'Critical controlled airspace',
    risk: 'critical',
    rules: [
      'explicit_tower_clearance_required',
      'licensed_pilot_required',
      'inspector_signoff_required',
      'black_box_required',
    ],
    paths: [
      'api/auth/**',
      'billing/**',
      'db/migrations/**',
      'infra/prod/**',
      'infra/production/**',
      '**/.env',
      '**/.env.*',
    ],
  },
  B: {
    label: 'Shared contract airspace',
    risk: 'high',
    rules: [
      'flight_plan_required',
      'downstream_notification_required',
      'change_order_for_mutation',
    ],
    paths: [
      'packages/schemas/**',
      'openapi/**',
      'packages/*/src/index.ts',
      'synthi/prisma/**',
      'backend/collab-server/permissionMiddleware.js',
    ],
  },
  C: {
    label: 'Feature implementation airspace',
    risk: 'medium',
    rules: [
      'auto_clearance_allowed',
      'landing_inspection_required',
    ],
    paths: [
      'apps/web/**',
      'components/**',
      'synthi/src/app/**',
      'synthi/src/components/**',
      'backend/collab-server/**',
    ],
  },
  D: {
    label: 'Low-risk support airspace',
    risk: 'low',
    rules: [
      'micro_clearance_allowed',
      'sample_inspection',
    ],
    paths: [
      'docs/**',
      'tests/**',
      '**/__tests__/**',
      '**/*.test.js',
      '**/*.test.jsx',
      '**/*.test.ts',
      '**/*.test.tsx',
      '**/*.md',
    ],
  },
};

export const CODE_SITE_EVENT_TYPES = [
  'flight_plan_filed',
  'clearance_requested',
  'clearance_issued',
  'transaction_opened',
  'transaction_validated',
  'transaction_committed',
  'transaction_aborted',
  'assumption_recorded',
  'assumption_invalidated',
  'write_attempted',
  'write_allowed',
  'write_denied',
  'write_quarantined',
  'snapshot_taken',
  'transponder_update',
  'route_deviation',
  'holding_pattern',
  'tower_instruction',
  'rfi',
  'change_order',
  'mayday',
  'ground_stop',
  'landing_requested',
  'radar_result',
  'inspection_result',
  'shadow_run',
  'arbiter_verdict',
  'near_miss',
  'policy_delta_proposed',
  'black_box_closed',
];

export function normalizePath(input) {
  if (typeof input !== 'string') return null;
  const cleaned = input.replace(/\\/g, '/').replace(/^\/+/, '').trim();
  if (!cleaned || cleaned.includes('\u0000')) return null;
  const parts = cleaned.split('/').filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.some((part) => part === '.' || part === '..')) return null;
  return parts.join('/');
}

export function normalizePathList(paths) {
  return asArray(paths).map(normalizePath).filter(Boolean);
}

export function compileZonePolicy(overrides = {}) {
  const extraZones = Array.isArray(overrides?.zones) ? overrides.zones : [];
  const defaults = Object.entries(AIRSPACE_CLASSES).map(([klass, value]) => ({
    zoneKey: `class_${klass.toLowerCase()}`,
    label: value.label,
    class: klass,
    paths: value.paths,
    rules: value.rules,
    risk: value.risk,
    source: 'compiled_default',
  }));

  const zones = [...defaults, ...extraZones.map((zone, index) => ({
    zoneKey: String(zone.zoneKey || zone.key || `custom_${index + 1}`),
    label: String(zone.label || zone.zoneKey || zone.key || `Custom zone ${index + 1}`),
    class: String(zone.class || zone.zoneClass || 'C').toUpperCase(),
    paths: normalizePatternList(zone.paths || zone.pathsJson || []),
    rules: asArray(zone.rules || zone.rulesJson),
    risk: String(zone.risk || 'medium'),
    source: zone.source || 'custom',
  }))];

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    zones,
    noFlyZones: normalizePatternList(overrides?.noFlyZones || overrides?.no_fly_zones || []),
    classRules: Object.fromEntries(Object.entries(AIRSPACE_CLASSES).map(([klass, value]) => [klass, value.rules])),
  };
}

function normalizePatternList(patterns) {
  return asArray(patterns)
    .map((pattern) => String(pattern || '').replace(/\\/g, '/').replace(/^\/+/, '').trim())
    .filter(Boolean);
}

export function digest(value) {
  return `sha256:${crypto.createHash('sha256').update(stableJson(value)).digest('hex')}`;
}

export function classifyPath(pathValue, zonePolicy) {
  const rel = normalizePath(pathValue);
  if (!rel) return null;
  const zones = asArray(zonePolicy?.zones);
  const matches = zones.filter((zone) => asArray(zone.paths).some((pattern) => matchPathPattern(rel, pattern)));
  if (matches.length === 0) {
    return {
      zoneKey: 'unclassified',
      label: 'Unclassified repo airspace',
      class: 'C',
      risk: 'medium',
      rules: ['auto_clearance_allowed', 'landing_inspection_required'],
      path: rel,
    };
  }
  matches.sort((a, b) => classRank(a.class) - classRank(b.class));
  return { ...matches[0], path: rel };
}

export function pathsForRoute(route) {
  return asArray(route)
    .map((item) => {
      if (typeof item === 'string') return item;
      return item?.path || item?.pattern || '';
    })
    .map((item) => String(item || '').replace(/\\/g, '/').replace(/^\/+/, '').trim())
    .filter(Boolean);
}

export function matchPathPattern(pathValue, patternValue) {
  const rel = normalizePath(pathValue);
  if (!rel) return false;
  const pattern = String(patternValue || '').replace(/\\/g, '/').replace(/^\/+/, '').trim();
  if (!pattern) return false;
  if (pattern === '**' || pattern === '*') return true;
  const regex = globToRegex(pattern);
  return regex.test(rel);
}

function globToRegex(pattern) {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];
    if (char === '*' && next === '*') {
      source += '.*';
      index += 1;
      continue;
    }
    if (char === '*') {
      source += '[^/]*';
      continue;
    }
    source += escapeRegex(char);
  }
  return new RegExp(`^${source}$`);
}

function escapeRegex(char) {
  return /[\\^$+?.()|[\]{}]/.test(char) ? `\\${char}` : char;
}

function classRank(value) {
  const klass = String(value || 'C').toUpperCase();
  return { A: 1, B: 2, C: 3, D: 4 }[klass] || 3;
}

export function evaluateLeaseRequest({ executionPlan, zonePolicy, requestedLease = {} }) {
  const route = pathsForRoute(requestedLease.allowedPaths || requestedLease.route || executionPlan?.route);
  const blockedPaths = pathsForRoute(requestedLease.blockedPaths || executionPlan?.blockedZones || []);
  const noFlyZones = pathsForRoute(zonePolicy?.noFlyZones || []);
  const inspected = route.map((path) => classifyPath(path, zonePolicy)).filter(Boolean);
  const criticalZones = inspected.filter((zone) => ['A', 'B'].includes(String(zone.class || '').toUpperCase()));
  const enteredNoFly = route.filter((path) =>
    [...blockedPaths, ...noFlyZones].some((pattern) => matchPathPattern(path, pattern)));

  if (enteredNoFly.length > 0) {
    return {
      decision: 'block',
      status: 'blocked',
      reasonCodes: ['entered_no_fly_zone'],
      towerInstruction: `Hold position and file a change order before mutating ${enteredNoFly.join(', ')}.`,
      inspectedZones: inspected,
    };
  }

  if (criticalZones.length > 0) {
    return {
      decision: 'inspect',
      status: 'active',
      reasonCodes: ['restricted_airspace_requires_inspection'],
      towerInstruction: `Cleared with radar: ${criticalZones.map((zone) => zone.zoneKey).join(', ')} requires landing inspection.`,
      inspectedZones: inspected,
    };
  }

  return {
    decision: 'allow',
    status: 'active',
    reasonCodes: ['route_inside_clearance'],
    towerInstruction: 'Cleared as filed. Maintain transponder updates until landing.',
    inspectedZones: inspected,
  };
}

export function evaluatePathMutation({ lease, path, tool = 'file_write', zonePolicy }) {
  const rel = normalizePath(path);
  const leaseJson = typeof lease?.leaseJson === 'string' ? JSON.parse(lease.leaseJson) : (lease?.leaseJson || {});
  const allowedPaths = pathsForRoute(leaseJson.allowedPaths || leaseJson.route || []);
  const blockedPaths = pathsForRoute(leaseJson.blockedPaths || leaseJson.noFlyZones || []);
  const allowedTools = asArray(leaseJson.allowedTools || leaseJson.tools || []);
  const zone = classifyPath(rel, zonePolicy);

  if (!rel) {
    return { ok: false, reasonCodes: ['invalid_path'], zone, path: rel };
  }
  if (lease?.status !== 'active') {
    return { ok: false, reasonCodes: ['clearance_not_active'], zone, path: rel };
  }
  if (lease?.expiresAt && new Date(lease.expiresAt).getTime() < Date.now()) {
    return { ok: false, reasonCodes: ['clearance_expired'], zone, path: rel };
  }
  if (blockedPaths.some((pattern) => matchPathPattern(rel, pattern))) {
    return { ok: false, reasonCodes: ['entered_no_fly_zone'], zone, path: rel };
  }
  if (allowedPaths.length > 0 && !allowedPaths.some((pattern) => matchPathPattern(rel, pattern))) {
    return { ok: false, reasonCodes: ['outside_clearance_route'], zone, path: rel };
  }
  if (allowedTools.length > 0 && !allowedTools.includes(tool)) {
    return { ok: false, reasonCodes: ['tool_not_in_clearance'], zone, path: rel };
  }
  return { ok: true, reasonCodes: ['inside_clearance_route'], zone, path: rel };
}

export function predictCollisions({ executionPlans, leases, zonePolicy }) {
  const plans = asArray(executionPlans);
  const activeLeases = asArray(leases).filter((lease) => lease.status === 'active');
  const risks = [];

  for (let i = 0; i < plans.length; i += 1) {
    for (let j = i + 1; j < plans.length; j += 1) {
      const left = plans[i];
      const right = plans[j];
      const leftRoutes = pathsForRoute(left.route);
      const rightRoutes = pathsForRoute(right.route);
      const overlaps = [];
      for (const leftPath of leftRoutes) {
        for (const rightPath of rightRoutes) {
          if (patternsOverlap(leftPath, rightPath)) overlaps.push([leftPath, rightPath]);
        }
      }
      if (overlaps.length > 0) {
        const restricted = overlaps.some(([path]) => {
          const zone = classifyPath(path.replace(/\*\*?$/, 'index.ts'), zonePolicy);
          return ['A', 'B'].includes(String(zone?.class || '').toUpperCase());
        });
        risks.push({
          risk: restricted ? 'contract_collision' : 'file_collision',
          severity: restricted ? 'high' : 'medium',
          aircraft: [left.displayCallsign, right.displayCallsign].filter(Boolean),
          conflictZone: overlaps[0][0],
          overlaps,
          recommendedResolution: restricted
            ? schemaFirstResolution(left, right)
            : sequenceResolution(left, right),
        });
      }
    }
  }

  for (const lease of activeLeases) {
    const leaseJson = typeof lease.leaseJson === 'string' ? JSON.parse(lease.leaseJson) : lease.leaseJson;
    const route = pathsForRoute(leaseJson?.allowedPaths || []);
    const restrictedPaths = route.filter((path) => {
      const zone = classifyPath(path.replace(/\*\*?$/, 'index.ts'), zonePolicy);
      return ['A', 'B'].includes(String(zone?.class || '').toUpperCase());
    });
    if (restrictedPaths.length > 0) {
      risks.push({
        risk: 'restricted_airspace_occupancy',
        severity: 'medium',
        aircraft: [lease.displayCallsign],
        conflictZone: restrictedPaths[0],
        recommendedResolution: {
          action: 'inspect_before_landing',
          steps: ['Keep route locked', 'Run required radar before commit', 'Attach proof bundle at landing'],
        },
      });
    }
  }

  return {
    riskLevel: risks.some((risk) => risk.severity === 'high') ? 'high' : (risks.length ? 'medium' : 'low'),
    risks,
  };
}

function patternsOverlap(left, right) {
  if (left === right) return true;
  const leftRoot = left.split('*')[0].replace(/\/+$/, '');
  const rightRoot = right.split('*')[0].replace(/\/+$/, '');
  if (!leftRoot || !rightRoot) return true;
  return leftRoot.startsWith(rightRoot) || rightRoot.startsWith(leftRoot);
}

function schemaFirstResolution(left, right) {
  return {
    action: 'schema_first',
    steps: [
      `Put ${left.displayCallsign || 'left flight'} in holding`,
      `Put ${right.displayCallsign || 'right flight'} in holding`,
      'Issue schema clearance first',
      'Reissue downstream clearances after contract landing',
    ],
  };
}

function sequenceResolution(left, right) {
  return {
    action: 'sequence_flights',
    steps: [
      `Sequence ${left.displayCallsign || 'left flight'} before ${right.displayCallsign || 'right flight'}`,
      'Refresh read sets after first landing',
      'Run landing radar before second flight mutates overlapping files',
    ],
  };
}
