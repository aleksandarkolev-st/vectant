export const GPU_HMR_GENERATED_SPLIT_GRANULARITY_SCHEMA_VERSION =
  'synthi.gpu_hmr.generated_split_granularity.v1';

const DEFAULT_DEVICE_BY_VENDOR = {
  cuda: 'device.cu',
  rocm: 'device.hip',
};

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function cleanRel(value) {
  return String(value ?? '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/^\.\//, '')
    .replace(/\/+/g, '/')
    .trim();
}

function compactStrings(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value ?? '').trim())
    .filter(Boolean))];
}

function sourceForPath(files, filePath) {
  const normalizedPath = cleanRel(filePath);
  const normalizedFiles = new Map(Object.entries(asObject(files)).map(([path, content]) => [
    cleanRel(path),
    String(content ?? ''),
  ]));
  return normalizedFiles.get(normalizedPath) ?? '';
}

function stripBlockAndLineComments(source) {
  return String(source ?? '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1 ');
}

export function deviceKernelSymbolsFromSource(source) {
  const text = stripBlockAndLineComments(source);
  const symbols = [];
  const patterns = [
    /\b__global__\s+(?:__launch_bounds__\s*\([^)]*\)\s*)?(?:[\w:<>,~*&\s]+\s+)?([A-Za-z_]\w*)\s*\(/g,
    /\b__kernel\s+(?:[\w:<>,~*&\s]+\s+)?([A-Za-z_]\w*)\s*\(/g,
    /\bkernel\s+void\s+([A-Za-z_]\w*)\s*\(/g,
    /@compute[\s\S]{0,160}?\bfn\s+([A-Za-z_]\w*)\s*\(/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      symbols.push(match[1]);
    }
  }
  return compactStrings(symbols);
}

export function manifestDeviceRoles(manifest, vendorHint = 'rocm') {
  const manifestObject = asObject(manifest);
  const gpu = asObject(manifestObject.gpu);
  const roles = Array.isArray(gpu.device_roles) ? gpu.device_roles : [];
  const normalizedRoles = roles
    .filter((role) => role && typeof role === 'object')
    .map((role, index) => ({
      id: String(role.id ?? `device.role.${index}`).trim() || `device.role.${index}`,
      path: cleanRel(role.path),
      sourceFiles: compactStrings(role.source_files ?? role.sourceFiles),
      compiler: String(role.compiler ?? gpu.device_compiler ?? '').trim() || null,
      arch: compactStrings(role.arch ?? gpu.arch),
      requiresRdc: role.requires_rdc === true || role.requiresRdc === true,
    }))
    .filter((role) => role.path);
  if (normalizedRoles.length > 0) return normalizedRoles;

  const vendor = String(gpu.vendor ?? vendorHint ?? '').trim().toLowerCase();
  const moduleFiles = asObject(manifestObject.module_files ?? manifestObject.moduleFiles);
  const fallbackPath = cleanRel(moduleFiles.device ?? DEFAULT_DEVICE_BY_VENDOR[vendor] ?? 'device.hip');
  return fallbackPath
    ? [{
        id: 'device.device',
        path: fallbackPath,
        sourceFiles: [],
        compiler: String(gpu.device_compiler ?? (vendor === 'cuda' ? 'nvcc' : 'hipcc')).trim(),
        arch: compactStrings(gpu.arch),
        requiresRdc: false,
      }]
    : [];
}

export function assessGeneratedGpuSplitGranularity({ manifest, files, vendor } = {}) {
  const deviceRoles = manifestDeviceRoles(manifest, vendor);
  const paths = compactStrings(deviceRoles.map((role) => role.path));
  const roleReports = paths.map((filePath) => {
    const source = sourceForPath(files, filePath);
    const kernelSymbols = deviceKernelSymbolsFromSource(source);
    return {
      path: filePath,
      present: source.length > 0,
      kernelSymbols,
      kernelCount: kernelSymbols.length,
      roleIds: deviceRoles
        .filter((role) => role.path === filePath)
        .map((role) => role.id),
    };
  });
  const kernelSymbols = compactStrings(roleReports.flatMap((role) => role.kernelSymbols));
  const missingDeviceRolePaths = roleReports
    .filter((role) => !role.present)
    .map((role) => role.path);
  const deviceTranslationUnitCount = paths.length;
  const multipleKernelsShareDeviceTranslationUnit =
    roleReports.some((role) => role.kernelCount > 1);
  const hmrReloadScope = deviceTranslationUnitCount > 1
    ? 'device_translation_unit_set'
    : 'device_translation_unit';
  const rejectedClaims = [
    'smallest_safe_fission_island',
    ...(multipleKernelsShareDeviceTranslationUnit ? ['per_kernel_hmr'] : []),
  ];

  return {
    schemaVersion: GPU_HMR_GENERATED_SPLIT_GRANULARITY_SCHEMA_VERSION,
    acceptedClaim: `${hmrReloadScope}_hmr`,
    hmrReloadScope,
    fissionGranularity: hmrReloadScope,
    proofBoundary: 'generated_manifest_device_role_topology',
    smallestSafeFissionIslandProven: false,
    requiresDeterministicFissionVerifierForSmallestSafeIsland: true,
    deviceRoleCount: deviceRoles.length,
    deviceTranslationUnitCount,
    deviceRolePaths: paths,
    deviceRoles,
    roleReports,
    kernelSymbols,
    kernelCount: kernelSymbols.length,
    missingDeviceRolePaths,
    multipleKernelsShareDeviceTranslationUnit,
    rejectedClaims,
    reasonCodes: compactStrings([
      missingDeviceRolePaths.length ? 'generated_split.device_role_source_missing' : null,
      'generated_split.smallest_safe_fission_not_proven_without_verifier',
      multipleKernelsShareDeviceTranslationUnit
        ? 'generated_split.single_translation_unit_contains_multiple_kernels'
        : null,
    ]),
  };
}

export function assertNoGeneratedSplitFissionOverclaim(assessment) {
  const report = asObject(assessment);
  if (
    report.smallestSafeFissionIslandProven === true
    && report.proofBoundary !== 'deterministic_fission_verifier'
  ) {
    throw new Error(
      'generated split cannot claim smallest-safe fission without deterministic verifier proof',
    );
  }
  if (
    Array.isArray(report.rejectedClaims)
    && report.rejectedClaims.includes('per_kernel_hmr')
    && report.acceptedClaim === 'per_kernel_hmr'
  ) {
    throw new Error('generated split cannot accept per-kernel HMR when kernels share a device translation unit');
  }
}
