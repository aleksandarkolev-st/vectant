/**
 * @fileoverview Advisory vectant.programs.json validator. Mirrors the rules of
 * the backend parser (synthi/src/lib/programs/manifest.js) but is ADVISORY only:
 * it collects ALL problems (rather than throwing on the first) so an authoring
 * agent can fix a draft in one pass. The authoritative, fail-closed validation
 * still happens server-side at save/publish time — a manifest that passes here is
 * not thereby approved. Pure, no deps beyond the local host-escape ruleset.
 */

import { findCommandHostEscape } from './hostEscape.js';
import { KNOWN_SCOPES, SUPPORTED_RUNTIME_TYPES } from './manifestSpec.js';

const PACKAGE_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * @param {object|string} input - manifest object or JSON text
 * @returns {{ valid: boolean, errors: Array<{code:string,message:string,field?:string}>, manifest?: object }}
 */
export function validateManifest(input) {
  let obj = input;
  if (typeof input === 'string') {
    try {
      obj = JSON.parse(input);
    } catch {
      return { valid: false, errors: [{ code: 'invalid_manifest', message: 'Manifest is not valid JSON' }] };
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { valid: false, errors: [{ code: 'invalid_manifest', message: 'Manifest must be a JSON object' }] };
  }

  const errors = [];
  const err = (code, message, field) => errors.push({ code, message, field });

  if (typeof obj.packageId !== 'string' || obj.packageId.includes('..') || !PACKAGE_ID_RE.test(obj.packageId)) {
    err('invalid_field', 'Invalid packageId (lowercase, starts alphanumeric, ≤64 chars, no "..")', 'packageId');
  }
  if (typeof obj.version !== 'string' || !obj.version.trim()) {
    err('missing_field', 'Missing version', 'version');
  }
  const launch = typeof obj.launch === 'string' ? obj.launch.trim() : '';
  if (!launch) err('missing_field', 'Missing launch command', 'launch');

  if (obj.runtimeType != null && !SUPPORTED_RUNTIME_TYPES.includes(obj.runtimeType)) {
    err('invalid_field', `Invalid runtimeType '${obj.runtimeType}'`, 'runtimeType');
  }

  if (obj.workingDir != null && obj.workingDir !== '') {
    if (typeof obj.workingDir !== 'string') {
      err('invalid_field', 'Invalid workingDir', 'workingDir');
    } else {
      const d = obj.workingDir.trim();
      const isAbsolute = d.startsWith('/') || d.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(d);
      const hasTraversal = d.split(/[\\/]+/).some((seg) => seg === '..');
      if (isAbsolute || hasTraversal) err('path_escape', 'workingDir escapes the workspace', 'workingDir');
    }
  }

  if (obj.install != null && typeof obj.install !== 'string' && !Array.isArray(obj.install)) {
    err('invalid_field', 'Invalid install (string or string[])', 'install');
  }
  if (obj.env != null && (typeof obj.env !== 'object' || Array.isArray(obj.env))) {
    err('invalid_field', 'Invalid env (object of string values)', 'env');
  }
  if (obj.ports != null) {
    if (!Array.isArray(obj.ports)) {
      err('invalid_field', 'Invalid ports (number[])', 'ports');
    } else {
      for (const p of obj.ports) {
        if (!Number.isInteger(p) || p < 1 || p > 65535) err('invalid_port', `Invalid port ${p}`, 'ports');
      }
    }
  }
  if (obj.permissions != null) {
    if (!Array.isArray(obj.permissions)) {
      err('invalid_field', 'Invalid permissions (string[])', 'permissions');
    } else {
      for (const p of obj.permissions) {
        if (!KNOWN_SCOPES.includes(p)) err('unknown_scope', `Unknown scope '${p}'`, 'permissions');
      }
    }
  }
  if (obj.health != null && (typeof obj.health !== 'object' || Array.isArray(obj.health))) {
    err('invalid_field', 'Invalid health (object)', 'health');
  }

  // Host-escape across every command string (install[] + launch).
  const cmds = [];
  if (typeof obj.install === 'string') cmds.push(obj.install);
  else if (Array.isArray(obj.install)) for (const c of obj.install) if (typeof c === 'string') cmds.push(c);
  if (launch) cmds.push(launch);
  for (const c of cmds) {
    const hit = findCommandHostEscape(c);
    if (hit) err('host_escape', `host escape in command: ${hit}`, 'launch');
  }

  return { valid: errors.length === 0, errors, manifest: obj };
}
