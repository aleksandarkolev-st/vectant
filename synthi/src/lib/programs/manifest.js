/**
 * @fileoverview Pure parser/validator for the `vectant.programs.json` recipe manifest.
 *
 * Produces a normalized, fail-closed `NormalizedProgramConfig` consumed by the
 * program store, the collab-server runtime manager, the Next.js program routes,
 * and the Programs sidebar. No IO — callers read the file/bytes and pass them in.
 *
 * The individual normalizers are exported so the devcontainer import mapper
 * (`devcontainer.js`) reuses the exact same traversal/scope/port rules.
 */

/** Permission scopes a program may declare. `program.launch` is always implied. */
export const KNOWN_SCOPES = [
  'program.launch',
  'workspace.files.read',
  'workspace.files.write',
  'network.outbound',
  'ports.expose',
];

/** Runtime types the program runtime can manage. */
export const SUPPORTED_RUNTIME_TYPES = ['web', 'cli', 'tui', 'background', 'gui'];

/** Sub-tabs a program session can surface. */
export const ALLOWED_SURFACES = ['app', 'logs', 'terminal', 'ports', 'health', 'settings'];

const PACKAGE_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Structured manifest error carrying a machine code + offending field. */
export class ProgramManifestError extends Error {
  constructor(code, message, field) {
    super(message);
    this.name = 'ProgramManifestError';
    this.code = code;
    this.field = field;
  }
}

/** Coerce a JSON string or object into a plain manifest object (fail-closed). */
export function coerceManifestObject(input) {
  let obj = input;
  if (typeof input === 'string') {
    try {
      obj = JSON.parse(input);
    } catch {
      throw new ProgramManifestError('invalid_manifest', 'Manifest is not valid JSON');
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new ProgramManifestError('invalid_manifest', 'Manifest must be a JSON object');
  }
  return obj;
}

export function validatePackageId(id, field = 'packageId') {
  if (typeof id !== 'string' || id.includes('..') || !PACKAGE_ID_RE.test(id)) {
    throw new ProgramManifestError('invalid_field', `Invalid ${field}`, field);
  }
  return id;
}

export function validateVersion(version, field = 'version') {
  if (typeof version !== 'string' || !version.trim()) {
    throw new ProgramManifestError('missing_field', `Missing ${field}`, field);
  }
  return version.trim();
}

export function validateLaunch(cmd, field = 'launch') {
  if (typeof cmd !== 'string' || !cmd.trim()) {
    throw new ProgramManifestError('missing_field', `Missing ${field} command`, field);
  }
  return cmd.trim();
}

export function normalizeRuntimeType(rt, field = 'runtimeType') {
  if (rt == null) return 'cli';
  if (!SUPPORTED_RUNTIME_TYPES.includes(rt)) {
    throw new ProgramManifestError('invalid_field', `Invalid ${field} '${rt}'`, field);
  }
  return rt;
}

/** Reject absolute paths and any `..` traversal; '' means workspace root. */
export function normalizeWorkingDir(dir, field = 'workingDir') {
  if (dir == null || dir === '') return '';
  if (typeof dir !== 'string') {
    throw new ProgramManifestError('invalid_field', `Invalid ${field}`, field);
  }
  const d = dir.trim();
  if (d === '') return '';
  const isAbsolute = d.startsWith('/') || d.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(d);
  const hasTraversal = d.split(/[\\/]+/).some((seg) => seg === '..');
  if (isAbsolute || hasTraversal) {
    throw new ProgramManifestError('path_escape', `${field} escapes the workspace`, field);
  }
  return d;
}

export function normalizePorts(ports, field = 'ports') {
  if (ports == null) return [];
  if (!Array.isArray(ports)) {
    throw new ProgramManifestError('invalid_field', `Invalid ${field}`, field);
  }
  const out = [];
  for (const p of ports) {
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      throw new ProgramManifestError('invalid_port', `Invalid port ${p}`, field);
    }
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

/** Always implies `program.launch`; rejects unknown scopes (fail-closed). */
export function normalizePermissions(perms, field = 'permissions') {
  const out = ['program.launch'];
  if (perms == null) return out;
  if (!Array.isArray(perms)) {
    throw new ProgramManifestError('invalid_field', `Invalid ${field}`, field);
  }
  for (const p of perms) {
    if (!KNOWN_SCOPES.includes(p)) {
      throw new ProgramManifestError('unknown_scope', `Unknown scope '${p}'`, field);
    }
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

/** Keep string env values (coerce number/boolean); drop everything else. */
export function normalizeEnv(env, field = 'env') {
  if (env == null) return {};
  if (typeof env !== 'object' || Array.isArray(env)) {
    throw new ProgramManifestError('invalid_field', `Invalid ${field}`, field);
  }
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof k !== 'string' || !k) continue;
    if (typeof v === 'string') out[k] = v;
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = String(v);
  }
  return out;
}

export function normalizeCommands(cmds, field = 'install') {
  if (cmds == null) return [];
  if (typeof cmds === 'string') {
    return cmds.trim() ? [cmds.trim()] : [];
  }
  if (!Array.isArray(cmds)) {
    throw new ProgramManifestError('invalid_field', `Invalid ${field}`, field);
  }
  return cmds.filter((c) => typeof c === 'string' && c.trim()).map((c) => c.trim());
}

function deriveSurfaces(runtimeType, ports) {
  const out = [];
  if (ports.length > 0 || runtimeType === 'gui') out.push('app');
  out.push('logs');
  if (runtimeType !== 'background') out.push('terminal');
  if (ports.length > 0) out.push('ports');
  out.push('health', 'settings');
  return out;
}

export function normalizeSurfaces(surfaces, runtimeType, ports) {
  if (Array.isArray(surfaces) && surfaces.length) {
    const out = [];
    for (const s of surfaces) {
      if (ALLOWED_SURFACES.includes(s) && !out.includes(s)) out.push(s);
    }
    if (out.length) return out;
  }
  return deriveSurfaces(runtimeType, ports);
}

export function normalizeHealth(health, field = 'health') {
  if (health == null) return null;
  if (typeof health !== 'object' || Array.isArray(health)) {
    throw new ProgramManifestError('invalid_field', `Invalid ${field}`, field);
  }
  const { type, target, intervalMs } = health;
  return {
    type: typeof type === 'string' ? type : 'none',
    target: typeof target === 'string' ? target : '',
    intervalMs: Number.isFinite(intervalMs) ? intervalMs : 0,
  };
}

function normalizeDisplayName(displayName, packageId) {
  if (typeof displayName === 'string' && displayName.trim()) return displayName.trim();
  return packageId;
}

/**
 * Parse + validate a `vectant.programs.json` manifest into a NormalizedProgramConfig.
 *
 * @param {object|string} input - manifest object or JSON text
 * @returns {import('./manifest').NormalizedProgramConfig}
 * @throws {ProgramManifestError}
 */
export function parseProgramManifest(input) {
  const obj = coerceManifestObject(input);

  const packageId = validatePackageId(obj.packageId);
  const version = validateVersion(obj.version);
  const launch = validateLaunch(obj.launch);
  const runtimeType = normalizeRuntimeType(obj.runtimeType);
  const workingDir = normalizeWorkingDir(obj.workingDir);
  const install = normalizeCommands(obj.install, 'install');
  const env = normalizeEnv(obj.env);
  const ports = normalizePorts(obj.ports);
  const permissions = normalizePermissions(obj.permissions);
  const surfaces = normalizeSurfaces(obj.surfaces, runtimeType, ports);
  const health = normalizeHealth(obj.health);
  const displayName = normalizeDisplayName(obj.displayName, packageId);

  return {
    packageId,
    version,
    displayName,
    runtimeType,
    workingDir,
    install,
    launch,
    env,
    ports,
    surfaces,
    health,
    permissions,
    source: 'vectant.programs.json',
    sourceHints: {},
  };
}
