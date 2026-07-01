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
  'policy_delta_promoted',
  'policy_delta_rejected',
  'black_box_closed',
];

const CODE_SITE_EVENT_TYPE_SET = new Set(CODE_SITE_EVENT_TYPES);

export function validateCodeSiteEventType(input) {
  const eventType = String(input || '').trim();
  if (!CODE_SITE_EVENT_TYPE_SET.has(eventType)) {
    const error = new Error(`codesite_event_type_invalid:${eventType || 'missing'}`);
    error.code = 'CODESITE_EVENT_TYPE_INVALID';
    error.status = 422;
    error.eventType = eventType || null;
    error.allowedEventTypes = CODE_SITE_EVENT_TYPES;
    throw error;
  }
  return eventType;
}

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
  const repoSignals = normalizeRepoSignals(overrides?.repoSignals || overrides?.repo_signals || {});
  const semanticGraph = buildSemanticGraph(repoSignals);
  const repoZones = compileRepoSignalZones(repoSignals);
  const defaults = Object.entries(AIRSPACE_CLASSES).map(([klass, value]) => ({
    zoneKey: `class_${klass.toLowerCase()}`,
    label: value.label,
    class: klass,
    paths: value.paths,
    rules: value.rules,
    risk: value.risk,
    source: 'compiled_default',
  }));

  const customZones = extraZones.map((zone, index) => ({
    zoneKey: String(zone.zoneKey || zone.key || `custom_${index + 1}`),
    label: String(zone.label || zone.zoneKey || zone.key || `Custom zone ${index + 1}`),
    class: String(zone.class || zone.zoneClass || 'C').toUpperCase(),
    paths: normalizePatternList(zone.paths || zone.pathsJson || []),
    rules: asArray(zone.rules || zone.rulesJson),
    risk: String(zone.risk || 'medium'),
    source: zone.source || 'custom',
  }));
  const zones = dedupeZones([...defaults, ...repoZones, ...customZones]);
  const noFlyZones = uniqueStrings([
    ...normalizePatternList(repoSignals.secretPatterns),
    ...normalizePatternList(overrides?.noFlyZones || overrides?.no_fly_zones || []),
  ]);

  const compiled = {
    version: 1,
    generatedAt: new Date().toISOString(),
    zones,
    noFlyZones,
    classRules: Object.fromEntries(Object.entries(AIRSPACE_CLASSES).map(([klass, value]) => [klass, value.rules])),
    semanticGraph,
    policySources: {
      defaults: defaults.length,
      repoSignals: repoZones.length,
      custom: customZones.length,
      codeowners: repoSignals.codeowners.length,
      openapi: repoSignals.openapi.length,
      prismaSchemas: repoSignals.prisma.schemas.length,
      prismaMigrations: repoSignals.prisma.migrations.length,
      packageExports: repoSignals.packageExports.length,
      importEdges: semanticGraph.importEdges.length,
      testOwnership: semanticGraph.testOwnership.length,
      deployment: repoSignals.deployment.length,
      pastIncidents: repoSignals.pastIncidents.length,
      secretPatterns: noFlyZones.length,
    },
  };
  return {
    ...compiled,
    policyDigest: digest(policyDigestPayload(compiled)),
  };
}

export function normalizeRepoSignals(input = {}) {
  const files = normalizePathList(input.files || input.fileList || input.file_list || []);
  const codeowners = normalizeCodeowners(input.codeowners || input.CODEOWNERS || []);
  const openapi = normalizeSignalPaths(input.openapi || input.openApi || input.openapiDocuments || input.openapi_documents || []);
  const prismaInput = input.prisma || {};
  const prisma = {
    schemas: normalizeSignalPaths(prismaInput.schemas || prismaInput.schemaFiles || input.prismaSchemas || input.prisma_schema_files || []),
    migrations: normalizeSignalPaths(prismaInput.migrations || prismaInput.migrationDirs || input.prismaMigrations || input.prisma_migrations || []),
  };
  const packageExports = normalizePackageExports(input.packageExports || input.package_exports || []);
  const importEdges = normalizeImportEdges(input.importGraph || input.importEdges || input.import_graph || []);
  const testOwnership = normalizeTestOwnership(input.testGraph || input.testOwnership || input.test_graph || []);
  const deployment = normalizeSignalPaths(input.deployment || input.deploymentConfig || input.deployment_config || []);
  const generatedClients = normalizeSignalPaths(input.generatedClients || input.generated_clients || []);
  const secretPatterns = normalizePatternList([
    '**/.env',
    '**/.env.*',
    'secrets/**',
    '**/*secret*',
    '**/*.pem',
    '**/*.key',
    ...(input.secretPatterns || input.secret_patterns || []),
  ]);
  const pastIncidents = normalizePastIncidents(input.pastIncidents || input.past_incidents || []);

  return {
    files,
    codeowners,
    openapi,
    prisma,
    packageExports,
    importEdges,
    testOwnership,
    deployment,
    generatedClients,
    secretPatterns,
    pastIncidents,
    repoRoot: input.repoRoot || input.repo_root || null,
    source: input.source || 'repo_policy_signals',
    compilerVersion: input.compilerVersion || input.compiler_version || null,
    maxFiles: input.maxFiles ?? input.max_files ?? null,
    fileCount: input.fileCount ?? input.file_count ?? files.length,
    truncated: Boolean(input.truncated),
    digest: input.digest || digest({
      files,
      codeowners,
      openapi,
      prisma,
      packageExports,
      importEdges,
      testOwnership,
      deployment,
      generatedClients,
      secretPatterns,
      pastIncidents,
    }),
  };
}

function policyDigestPayload(policy) {
  return {
    version: policy.version,
    zones: policy.zones,
    noFlyZones: policy.noFlyZones,
    classRules: policy.classRules,
    semanticGraph: policy.semanticGraph,
    policySources: policy.policySources,
  };
}

function buildSemanticGraph(repoSignals) {
  const files = uniqueStrings(repoSignals.files);
  const importEdges = repoSignals.importEdges.map((edge) => ({
    from: edge.from,
    imports: uniqueStrings(edge.imports),
  }));
  const testOwnership = repoSignals.testOwnership.map((item) => ({
    testPath: item.testPath,
    covers: uniqueStrings(item.covers),
  }));
  const packageExports = repoSignals.packageExports.map((entry) => ({
    packageName: entry.packageName,
    root: entry.root,
    exports: uniqueStrings(entry.exports),
    exportMap: normalizePackageExportMap(entry.exportMap),
  }));
  return {
    files,
    importEdges,
    testOwnership,
    packageExports,
    generatedClients: uniqueStrings(repoSignals.generatedClients.map((item) => item.path)),
    migrationLocks: uniqueStrings(repoSignals.prisma.migrations.map((item) => item.path)),
    deploymentConfig: uniqueStrings(repoSignals.deployment.map((item) => item.path)),
    sourceDigest: repoSignals.digest,
  };
}

function compileRepoSignalZones(repoSignals) {
  const zones = [];

  for (const [index, entry] of repoSignals.codeowners.entries()) {
    const klass = classForPattern(entry.pattern);
    zones.push({
      zoneKey: `codeowners_${zoneKeySegment(entry.pattern, index)}`,
      label: `Owned airspace: ${entry.pattern}`,
      class: klass,
      paths: [entry.pattern],
      rules: uniqueStrings([...(AIRSPACE_CLASSES[klass]?.rules || []), 'owner_review_required']),
      risk: riskForClass(klass),
      source: 'repo_codeowners',
      owners: entry.owners,
    });
  }

  for (const [index, entry] of repoSignals.openapi.entries()) {
    const paths = uniqueStrings([
      entry.path,
      ...normalizePatternList(entry.routePatterns || entry.route_patterns || entry.contractRoutePatterns || []),
    ]);
    zones.push({
      zoneKey: `openapi_contract_${zoneKeySegment(entry.path, index)}`,
      label: `API contract: ${entry.path}`,
      class: 'B',
      paths,
      rules: uniqueStrings([...AIRSPACE_CLASSES.B.rules, 'api_contract_radar_required']),
      risk: 'high',
      source: 'repo_openapi',
      contractPaths: asArray(entry.contractPaths || entry.contract_paths || [])
        .map((contractPath) => String(contractPath || '').trim())
        .filter(Boolean),
      operations: asArray(entry.operations).map((operation) => ({
        path: operation.path,
        method: operation.method,
        operationId: operation.operationId || null,
      })),
    });
  }

  for (const [index, entry] of repoSignals.prisma.schemas.entries()) {
    zones.push({
      zoneKey: `prisma_schema_${zoneKeySegment(entry.path, index)}`,
      label: `Prisma schema: ${entry.path}`,
      class: 'B',
      paths: [entry.path],
      rules: uniqueStrings([...AIRSPACE_CLASSES.B.rules, 'migration_radar_required']),
      risk: 'high',
      source: 'repo_prisma_schema',
    });
  }

  for (const [index, entry] of repoSignals.prisma.migrations.entries()) {
    zones.push({
      zoneKey: `migration_runway_${zoneKeySegment(entry.path, index)}`,
      label: `Migration runway: ${entry.path}`,
      class: 'A',
      paths: [entry.path.endsWith('/**') ? entry.path : `${entry.path.replace(/\/+$/, '')}/**`],
      rules: uniqueStrings([...AIRSPACE_CLASSES.A.rules, 'single_migration_runway_lock']),
      risk: 'critical',
      source: 'repo_prisma_migration',
    });
  }

  for (const [index, entry] of repoSignals.packageExports.entries()) {
    const paths = uniqueStrings([entry.root && `${entry.root.replace(/\/+$/, '')}/**`, ...entry.exports].filter(Boolean));
    zones.push({
      zoneKey: `package_exports_${zoneKeySegment(entry.root || entry.packageName, index)}`,
      label: `Public package exports: ${entry.packageName || entry.root}`,
      class: 'B',
      paths,
      rules: uniqueStrings([...AIRSPACE_CLASSES.B.rules, 'downstream_package_radar_required']),
      risk: 'high',
      source: 'repo_package_exports',
    });
  }

  for (const [index, entry] of repoSignals.deployment.entries()) {
    zones.push({
      zoneKey: `deployment_${zoneKeySegment(entry.path, index)}`,
      label: `Deployment config: ${entry.path}`,
      class: 'A',
      paths: [entry.path],
      rules: uniqueStrings([...AIRSPACE_CLASSES.A.rules, 'runtime_radar_required']),
      risk: 'critical',
      source: 'repo_deployment_config',
    });
  }

  for (const [index, incident] of repoSignals.pastIncidents.entries()) {
    const affectedPaths = normalizePatternList(incident.affectedPaths || incident.paths || incident.affectedZones || []);
    if (affectedPaths.length === 0) continue;
    const klass = ['critical', 'high'].includes(incident.severity) ? 'A' : 'B';
    zones.push({
      zoneKey: `incident_hot_zone_${zoneKeySegment(affectedPaths[0], index)}`,
      label: `Incident hot zone: ${incident.category || affectedPaths[0]}`,
      class: klass,
      paths: affectedPaths,
      rules: uniqueStrings([...AIRSPACE_CLASSES[klass].rules, 'recurrent_incident_radar_required']),
      risk: riskForClass(klass),
      source: 'repo_past_incident',
      incidentRefs: incident.refs,
    });
  }

  return zones;
}

function normalizePatternList(patterns) {
  return asArray(patterns)
    .map((pattern) => String(pattern || '').replace(/\\/g, '/').replace(/^\/+/, '').trim())
    .filter(Boolean);
}

function normalizeSignalPaths(value) {
  return asArray(value)
    .map((item) => {
      if (typeof item === 'string') return { path: normalizePath(item) || normalizePatternList([item])[0] };
      const path = normalizePath(item?.path || item?.file || item?.pattern || item?.dir)
        || normalizePatternList([item?.path || item?.file || item?.pattern || item?.dir])[0];
      return path ? { ...item, path } : null;
    })
    .filter(Boolean);
}

function normalizeCodeowners(value) {
  return asArray(value)
    .map((entry, index) => {
      if (typeof entry === 'string') {
        const [pattern, ...owners] = entry.trim().split(/\s+/).filter(Boolean);
        return pattern ? { pattern: normalizePatternList([pattern])[0], owners } : null;
      }
      const pattern = normalizePatternList([entry?.pattern || entry?.path || entry?.glob || `owned_${index}`])[0];
      return pattern ? { pattern, owners: asArray(entry?.owners || entry?.owner).map(String).filter(Boolean) } : null;
    })
    .filter(Boolean);
}

function normalizePackageExports(value) {
  return asArray(value)
    .map((entry) => {
      const root = normalizePath(entry?.root || entry?.packageRoot || entry?.dir || '') || '';
      const packageName = String(entry?.packageName || entry?.name || root || 'package');
      const exports = normalizePathList(entry?.exports || entry?.exportedFiles || entry?.files || []);
      const exportMap = normalizePackageExportMap(entry?.exportMap || entry?.exportsMap || entry?.packageExportMap);
      return root || exports.length ? { packageName, root, exports, exportMap } : null;
    })
    .filter(Boolean);
}

function normalizePackageExportMap(value) {
  if (!value || Array.isArray(value) || typeof value !== 'object') return {};
  return Object.fromEntries(Object.entries(value)
    .map(([key, paths]) => {
      const exportKey = String(key || '.').trim() || '.';
      const exports = normalizePathList(paths);
      return exports.length ? [exportKey, exports] : null;
    })
    .filter(Boolean)
    .sort(([left], [right]) => left.localeCompare(right)));
}

function normalizeImportEdges(value) {
  if (value && !Array.isArray(value) && typeof value === 'object') {
    return Object.entries(value)
      .map(([from, imports]) => normalizeImportEdge({ from, imports }))
      .filter(Boolean);
  }
  return asArray(value).map(normalizeImportEdge).filter(Boolean);
}

function normalizeImportEdge(edge) {
  const from = normalizePath(edge?.from || edge?.source || edge?.file || '');
  const imports = normalizePathList(edge?.imports || edge?.to || edge?.dependencies || []);
  return from && imports.length ? { from, imports } : null;
}

function normalizeTestOwnership(value) {
  if (value && !Array.isArray(value) && typeof value === 'object') {
    return Object.entries(value)
      .map(([testPath, covers]) => normalizeTestOwner({ testPath, covers }))
      .filter(Boolean);
  }
  return asArray(value).map(normalizeTestOwner).filter(Boolean);
}

function normalizeTestOwner(entry) {
  const testPath = normalizePath(entry?.testPath || entry?.test || entry?.file || '');
  const covers = normalizePathList(entry?.covers || entry?.coveredPaths || entry?.imports || []);
  return testPath && covers.length ? { testPath, covers } : null;
}

function normalizePastIncidents(value) {
  return asArray(value).map((incident) => ({
    category: String(incident?.category || incident?.type || 'incident'),
    severity: String(incident?.severity || incident?.risk || 'medium').toLowerCase(),
    affectedPaths: normalizePatternList(incident?.affectedPaths || incident?.paths || incident?.affectedZones || []),
    refs: asArray(incident?.refs || incident?.evidenceRefs || incident?.incidentRefs).map(String).filter(Boolean),
  }));
}

function dedupeZones(zones) {
  const byKey = new Map();
  for (const zone of zones) {
    if (!zone?.zoneKey) continue;
    const previous = byKey.get(zone.zoneKey);
    byKey.set(zone.zoneKey, previous
      ? {
          ...previous,
          ...zone,
          paths: uniqueStrings([...asArray(previous.paths), ...asArray(zone.paths)]),
          rules: uniqueStrings([...asArray(previous.rules), ...asArray(zone.rules)]),
        }
      : zone);
  }
  return [...byKey.values()];
}

function uniqueStrings(values) {
  return [...new Set(asArray(values).map((value) => String(value || '').trim()).filter(Boolean))];
}

function zoneKeySegment(value, index = 0) {
  const segment = String(value || `zone_${index + 1}`)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  return segment || `zone_${index + 1}`;
}

function classForPattern(pattern) {
  const value = String(pattern || '').toLowerCase();
  if (/(^|\/)(infra|deploy|deployment|k8s|helm|terraform|billing|auth|permissions|secrets?|\.env)/.test(value)) return 'A';
  if (/(schema|openapi|api|prisma|package|exports?|generated|client)/.test(value)) return 'B';
  if (/(docs?|tests?|fixtures?|examples?|\*.md|__tests__)/.test(value)) return 'D';
  return 'C';
}

function riskForClass(klass) {
  return { A: 'critical', B: 'high', C: 'medium', D: 'low' }[String(klass || 'C').toUpperCase()] || 'medium';
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

export function predictCollisions({ executionPlans, leases, transactions = [], inspectionRuns = [], zonePolicy }) {
  const plans = asArray(executionPlans);
  const activeLeases = asArray(leases).filter((lease) => lease.status === 'active');
  const activeTransactions = asArray(transactions).filter((txn) => ['open', 'validated', 'blocked'].includes(String(txn.status || '').toLowerCase()));
  const inspections = asArray(inspectionRuns);
  const risks = [];
  const riskKeys = new Set();
  const semanticGraph = zonePolicy?.semanticGraph || {};
  const footprints = new Map(plans.map((plan) => [plan, semanticFootprint(plan, semanticGraph)]));
  const runwayOccupancy = buildRunwayOccupancy(activeLeases, plans, zonePolicy, activeTransactions, inspections);

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
        pushRisk(risks, riskKeys, {
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

      const semanticRisk = semanticCollisionRisk(left, right, footprints.get(left), footprints.get(right), zonePolicy);
      if (semanticRisk) pushRisk(risks, riskKeys, semanticRisk);
    }
  }

  for (const lease of activeLeases) {
    const leaseJson = typeof lease.leaseJson === 'string' ? JSON.parse(lease.leaseJson) : (lease.leaseJson || lease.lease || {});
    const route = pathsForRoute(leaseJson?.allowedPaths || leaseJson?.route || []);
    const restrictedPaths = route.filter((path) => {
      const zone = classifyPath(path.replace(/\*\*?$/, 'index.ts'), zonePolicy);
      return ['A', 'B'].includes(String(zone?.class || '').toUpperCase());
    });
    if (restrictedPaths.length > 0) {
      pushRisk(risks, riskKeys, {
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

  const wakeTurbulence = [];
  for (const risk of wakeTurbulenceRisks({ activeLeases, plans, zonePolicy, semanticGraph })) {
    pushRisk(risks, riskKeys, risk);
    wakeTurbulence.push(risk);
  }
  const riskLevel = risks.some((risk) => ['critical', 'high'].includes(risk.severity))
    ? 'high'
    : (risks.length ? 'medium' : 'low');

  return {
    riskLevel,
    risks,
    runwayOccupancy,
    wakeTurbulence,
  };
}

function buildRunwayOccupancy(activeLeases, plans, zonePolicy, activeTransactions = [], inspectionRuns = []) {
  return activeLeases.map((lease) => {
    const leaseJson = typeof lease.leaseJson === 'string' ? JSON.parse(lease.leaseJson) : (lease.leaseJson || lease.lease || {});
    const route = pathsForRoute(leaseJson?.allowedPaths || leaseJson?.route || []);
    const transactionDiffPaths = asArray(activeTransactions)
      .filter((txn) => txn.mutationLeaseId === lease.id)
      .flatMap(transactionWritePaths);
    const runway = route[0] || null;
    const classes = uniqueStrings(route.map((path) =>
      classifyPath(path.replace(/\*\*?$/, 'index.ts'), zonePolicy)?.class || 'C'));
    const pendingInspections = uniqueStrings([
      ...route.flatMap((path) => defaultRadarForWakePath(path, zonePolicy)),
      ...pendingInspectionLabelsForRoute(route, inspectionRuns),
    ]);
    const eligibleFlights = plans
      .filter((plan) => {
        const planRoutes = pathsForRoute(plan.route);
        return planRoutes.length === 0 || !planRoutes.some((planRoute) =>
          route.some((occupiedPath) => patternsOverlap(planRoute, occupiedPath)));
      })
      .map((plan) => plan.displayCallsign || plan.id)
      .filter(Boolean);
    return {
      runway,
      route,
      occupiedBy: lease.displayCallsign || lease.agentSessionId || lease.id || null,
      mutationLeaseId: lease.id || null,
      runwayClass: classes.includes('A') ? 'A' : (classes.includes('B') ? 'B' : classes[0] || 'C'),
      diffPaths: uniqueStrings([
        ...transactionDiffPaths,
        ...pathsForRoute(leaseJson?.writeSet || leaseJson?.observedWriteSet || []),
        ...(transactionDiffPaths.length || leaseJson?.writeSet || leaseJson?.observedWriteSet ? [] : pathsForRoute(leaseJson?.allowedPaths || [])),
      ]),
      pendingInspections,
      eligibleFlights,
    };
  });
}

function pendingInspectionLabelsForRoute(route, inspectionRuns = []) {
  return asArray(inspectionRuns)
    .filter((run) => ['requested', 'running', 'pending'].includes(String(run?.status || '').toLowerCase()))
    .filter((run) => {
      const changedPaths = pathsForRoute(run?.changedPaths || run?.changed_paths || parseJsonArray(run?.changedPathsJson));
      return changedPaths.some((changedPath) =>
        route.some((routePath) => patternsOverlap(changedPath, routePath) || patternsOverlap(routePath, changedPath)));
    })
    .map((run) => `inspection:${run.displayCallsign || run.id}`)
    .filter(Boolean);
}

function transactionWritePaths(transaction) {
  const writeSet = transaction?.writeSet || transaction?.write_set || parseJsonArray(transaction?.writeSetJson);
  const observedWriteSet = transaction?.observedWriteSet || transaction?.observed_write_set || parseJsonArray(transaction?.observedWriteSetJson);
  return pathsForRoute([...asArray(writeSet), ...asArray(observedWriteSet)]);
}

function parseJsonArray(value) {
  if (!value || typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function wakeTurbulenceRisks({ activeLeases, plans, zonePolicy, semanticGraph }) {
  const risks = [];
  for (const lease of activeLeases) {
    const leaseJson = typeof lease.leaseJson === 'string' ? JSON.parse(lease.leaseJson) : (lease.leaseJson || lease.lease || {});
    const route = pathsForRoute(leaseJson?.allowedPaths || leaseJson?.route || []);
    if (route.length === 0) continue;
    const profiles = wakeProfilesForRoute(route, zonePolicy, semanticGraph);
    for (const profile of profiles) {
      const affectedFlights = affectedFlightsForWake({ lease, route, plans, semanticGraph, profile });
      risks.push({
        risk: 'wake_turbulence',
        severity: profile.severity,
        aircraft: uniqueStrings([lease.displayCallsign, ...affectedFlights].filter(Boolean)),
        conflictZone: profile.conflictZone || route[0],
        wake: {
          kind: profile.kind,
          runway: route[0],
          occupiedBy: lease.displayCallsign || lease.agentSessionId || lease.id || null,
          affectedFlights,
          requiredWaits: profile.requiredWaits,
          downstreamSignals: profile.downstreamSignals,
        },
        recommendedResolution: {
          action: 'hold_for_wake_turbulence',
          steps: profile.steps,
        },
      });
    }
  }
  return risks;
}

function wakeProfilesForRoute(route, zonePolicy, semanticGraph) {
  const profiles = [];
  const zones = route.map((path) => classifyPath(path.replace(/\*\*?$/, 'index.ts'), zonePolicy)).filter(Boolean);
  const rules = uniqueStrings(zones.flatMap((zone) => zone.rules || []));
  const migrationLocks = asArray(semanticGraph.migrationLocks).filter((lock) =>
    route.some((path) => patternsOverlap(path, lock) || matchPathPattern(path.replace(/\*\*?$/, 'index.ts'), lock)));
  const schemaSignals = route.filter((path) => {
    const normalized = normalizePath(path.replace(/\*\*?$/, 'index.ts')) || path;
    return /(schema|prisma|openapi|packages\/schemas)/i.test(normalized);
  });
  const packageSignals = asArray(semanticGraph.packageExports)
    .filter((entry) => {
      const candidates = uniqueStrings([entry.root && `${entry.root.replace(/\/+$/, '')}/**`, ...asArray(entry.exports)].filter(Boolean));
      return candidates.some((candidate) => route.some((path) => patternsOverlap(path, candidate)));
    })
    .map((entry) => entry.packageName || entry.root)
    .filter(Boolean);
  const generatedClients = asArray(semanticGraph.generatedClients)
    .filter((client) => route.some((path) => patternsOverlap(path, client)) || schemaSignals.length > 0);

  if (rules.includes('single_migration_runway_lock') || migrationLocks.length > 0) {
    profiles.push({
      kind: 'migration',
      severity: 'high',
      conflictZone: migrationLocks[0] || route[0],
      requiredWaits: ['backend_test_wait', 'migration_rollback_radar', 'schema_client_refresh'],
      downstreamSignals: { migrationLocks },
      steps: [
        'Hold backend and test flights until the migration runway lands',
        'Run rollback and migration-order radar before dependent flights resume',
        'Refresh generated clients and schema snapshots after landing',
      ],
    });
  }

  if (rules.includes('migration_radar_required') || rules.includes('api_contract_radar_required') || schemaSignals.length > 0) {
    profiles.push({
      kind: 'schema_or_contract',
      severity: 'high',
      conflictZone: schemaSignals[0] || route[0],
      requiredWaits: ['generated_client_refresh', 'contract_radar', 'downstream_test_rerun'],
      downstreamSignals: { schemaSignals, generatedClients },
      steps: [
        'Hold downstream feature flights until schema or contract radar completes',
        'Refresh generated clients before dependent code lands',
        'Rerun tests covering the changed contract surface',
      ],
    });
  }

  if (rules.includes('downstream_package_radar_required') || packageSignals.length > 0) {
    profiles.push({
      kind: 'package_export',
      severity: 'medium',
      conflictZone: route[0],
      requiredWaits: ['downstream_package_radar', 'importer_refresh'],
      downstreamSignals: { packageExports: packageSignals },
      steps: [
        'Hold importers until package export radar finishes',
        'Refresh downstream route plans that import the changed public surface',
        'Require dependent flights to refresh read sets before landing',
      ],
    });
  }

  if (rules.includes('runtime_radar_required')) {
    profiles.push({
      kind: 'runtime',
      severity: 'medium',
      conflictZone: route[0],
      requiredWaits: ['runtime_inspector_wait', 'preview_restart_radar'],
      downstreamSignals: {},
      steps: [
        'Hold preview/runtime flights until the runtime inspector lands',
        'Restart affected previews before dependent tests run',
      ],
    });
  }

  return profiles;
}

function affectedFlightsForWake({ lease, route, plans, semanticGraph, profile }) {
  const sourceCallsign = lease.displayCallsign || lease.agentSessionId || lease.id || '';
  const downstreamFiles = downstreamFilesForRoute(route, semanticGraph, profile);
  return uniqueStrings(plans
    .filter((plan) => {
      const callsign = plan.displayCallsign || plan.id || '';
      if (callsign && callsign === sourceCallsign) return false;
      const planRoutes = pathsForRoute(plan.route);
      if (planRoutes.length === 0) return false;
      return planRoutes.some((planRoute) =>
        route.some((sourcePath) => patternsOverlap(planRoute, sourcePath))
        || downstreamFiles.some((file) => matchPathPattern(file, planRoute) || patternsOverlap(file, planRoute)));
    })
    .map((plan) => plan.displayCallsign || plan.id)
    .filter(Boolean));
}

function downstreamFilesForRoute(route, semanticGraph, profile) {
  const downstream = [];
  for (const edge of asArray(semanticGraph.importEdges)) {
    if (asArray(edge.imports).some((imported) =>
      route.some((path) => patternsOverlap(imported, path) || matchPathPattern(imported, path)))) {
      downstream.push(edge.from);
    }
  }
  for (const owner of asArray(semanticGraph.testOwnership)) {
    if (asArray(owner.covers).some((covered) =>
      route.some((path) => patternsOverlap(covered, path) || matchPathPattern(covered, path)))) {
      downstream.push(owner.testPath);
    }
  }
  downstream.push(...asArray(semanticGraph.generatedClients));
  if (profile.kind === 'package_export') {
    for (const entry of asArray(semanticGraph.packageExports)) {
      downstream.push(...asArray(entry.exports), entry.root);
    }
  }
  return uniqueStrings(downstream.filter(Boolean));
}

function defaultRadarForWakePath(path, zonePolicy) {
  const zone = classifyPath(path.replace(/\*\*?$/, 'index.ts'), zonePolicy);
  const rules = asArray(zone?.rules);
  return uniqueStrings([
    ...(rules.includes('single_migration_runway_lock') ? ['migration_runway_lock'] : []),
    ...(rules.includes('migration_radar_required') ? ['migration_radar'] : []),
    ...(rules.includes('api_contract_radar_required') ? ['api_contract_radar'] : []),
    ...(rules.includes('downstream_package_radar_required') ? ['downstream_package_radar'] : []),
    ...(rules.includes('runtime_radar_required') ? ['runtime_radar'] : []),
    ...(['A', 'B'].includes(String(zone?.class || '').toUpperCase()) ? ['landing_inspection'] : []),
  ]);
}

function semanticFootprint(plan, semanticGraph) {
  const routes = pathsForRoute(plan?.route);
  const files = asArray(semanticGraph.files).map(normalizePath).filter(Boolean);
  const routeFiles = files.filter((file) => routes.some((route) => matchPathPattern(file, route) || patternsOverlap(file, route)));
  const routePatterns = routeFiles.length ? routeFiles : routes;
  const imports = [];
  const importedBy = [];
  for (const edge of asArray(semanticGraph.importEdges)) {
    const from = normalizePath(edge.from);
    const imported = normalizePathList(edge.imports);
    if (!from) continue;
    if (routePatterns.some((route) => matchPathPattern(from, route) || patternsOverlap(from, route))) {
      imports.push(...imported);
    }
    if (imported.some((target) => routePatterns.some((route) => matchPathPattern(target, route) || patternsOverlap(target, route)))) {
      importedBy.push(from);
    }
  }
  const tests = asArray(semanticGraph.testOwnership)
    .filter((item) => asArray(item.covers).some((covered) =>
      [...routePatterns, ...imports, ...importedBy].some((route) => matchPathPattern(covered, route) || patternsOverlap(covered, route))))
    .map((item) => item.testPath)
    .filter(Boolean);
  const migrationLocks = asArray(semanticGraph.migrationLocks)
    .filter((lock) => routes.some((route) => matchPathPattern(lock, route) || patternsOverlap(lock, route)));

  return {
    routes,
    routeFiles: uniqueStrings(routeFiles),
    imports: uniqueStrings(imports),
    importedBy: uniqueStrings(importedBy),
    tests: uniqueStrings(tests),
    migrationLocks: uniqueStrings(migrationLocks),
  };
}

function semanticCollisionRisk(left, right, leftFootprint, rightFootprint, zonePolicy) {
  const leftContracts = intersections(leftFootprint.imports, [...rightFootprint.routes, ...rightFootprint.routeFiles]);
  const rightContracts = intersections(rightFootprint.imports, [...leftFootprint.routes, ...leftFootprint.routeFiles]);
  const sharedImports = intersections(leftFootprint.imports, rightFootprint.imports);
  const sharedTests = intersections(leftFootprint.tests, rightFootprint.tests);
  const migrationLocks = intersections(leftFootprint.migrationLocks, rightFootprint.migrationLocks);

  if (migrationLocks.length > 0) {
    return {
      risk: 'migration_collision',
      severity: 'high',
      aircraft: [left.displayCallsign, right.displayCallsign].filter(Boolean),
      conflictZone: migrationLocks[0],
      semanticSignals: { migrationLocks },
      recommendedResolution: {
        action: 'single_migration_runway_lock',
        steps: [
          'Ground one migration flight',
          'Issue a single Class A migration clearance',
          'Run migration rollback radar before any dependent flight lands',
        ],
      },
    };
  }

  const contractSignals = uniqueStrings([...leftContracts, ...rightContracts, ...sharedImports])
    .filter((path) => {
      const zone = classifyPath(path, zonePolicy);
      return ['A', 'B'].includes(String(zone?.class || '').toUpperCase());
    });
  if (contractSignals.length > 0) {
    return {
      risk: 'semantic_collision',
      severity: 'high',
      aircraft: [left.displayCallsign, right.displayCallsign].filter(Boolean),
      conflictZone: contractSignals[0],
      semanticSignals: {
        leftImports: leftContracts,
        rightImports: rightContracts,
        sharedImports,
      },
      recommendedResolution: schemaFirstResolution(left, right),
    };
  }

  if (sharedTests.length > 0) {
    return {
      risk: 'test_collision',
      severity: 'medium',
      aircraft: [left.displayCallsign, right.displayCallsign].filter(Boolean),
      conflictZone: sharedTests[0],
      semanticSignals: { sharedTests },
      recommendedResolution: {
        action: 'sequence_test_radar',
        steps: [
          'Sequence landings through the shared test owner',
          'Refresh affected tests after first landing',
          'Require second flight to rerun shared radar before commit',
        ],
      },
    };
  }

  return null;
}

function intersections(leftValues, rightValues) {
  const right = uniqueStrings(rightValues);
  return uniqueStrings(leftValues).filter((left) =>
    right.some((candidate) => left === candidate || patternsOverlap(left, candidate)));
}

function pushRisk(risks, riskKeys, risk) {
  const key = [
    risk.risk,
    risk.severity,
    risk.conflictZone,
    ...asArray(risk.aircraft).sort(),
  ].join('|');
  if (riskKeys.has(key)) return;
  riskKeys.add(key);
  risks.push(risk);
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
