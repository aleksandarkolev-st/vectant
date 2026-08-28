import { createHash } from 'node:crypto';
import path from 'node:path';

import {
  COLD_BUILD_LAUNCHER_INPUT_ROOT,
  COLD_BUILD_LAUNCHER_SOURCE_ROOT,
} from './gpu-hmr-cold-build-container-contract.mjs';

const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function contentHash(value) {
  return `sha256:${createHash('sha256').update(String(value)).digest('hex')}`;
}

function normalizeMountPath(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 1024 || /[\\\0\r\n]/.test(value)) {
    throw new Error('cold_build_input_set_mount_path_invalid');
  }
  const normalized = path.posix.normalize(value);
  if (
    normalized !== value
    || normalized === '.'
    || normalized.startsWith('../')
    || path.posix.isAbsolute(normalized)
    || path.win32.isAbsolute(normalized)
  ) {
    throw new Error('cold_build_input_set_mount_path_invalid');
  }
  return normalized;
}

function normalizeBindingHash(value) {
  if (!HASH_PATTERN.test(value ?? '')) {
    throw new Error('cold_build_input_set_binding_hash_invalid');
  }
  return value;
}

function pathsOverlap(left, right) {
  const relative = path.posix.relative(left, right);
  return relative === '' || (relative !== '..' && !relative.startsWith('../'));
}

export function createColdBuildInputSet({ sourceBindingHash, readOnlyInputs = [] } = {}) {
  if (!Array.isArray(readOnlyInputs) || readOnlyInputs.length > 128) {
    throw new Error('cold_build_input_set_read_only_inputs_invalid');
  }
  const entries = [{
    containerPath: COLD_BUILD_LAUNCHER_SOURCE_ROOT,
    sourceBindingHash: normalizeBindingHash(sourceBindingHash),
  }, ...readOnlyInputs.map((input) => {
    if (
      !input
      || typeof input !== 'object'
      || Array.isArray(input)
      || stableJson(Object.keys(input).sort())
        !== stableJson(['mountPath', 'sourceBindingHash'].sort())
    ) {
      throw new Error('cold_build_input_set_read_only_input_shape_invalid');
    }
    return {
      containerPath: path.posix.join(
        COLD_BUILD_LAUNCHER_INPUT_ROOT,
        normalizeMountPath(input.mountPath),
      ),
      sourceBindingHash: normalizeBindingHash(input.sourceBindingHash),
    };
  })].sort((left, right) => Buffer.compare(
    Buffer.from(left.containerPath, 'utf8'),
    Buffer.from(right.containerPath, 'utf8'),
  ));
  if (entries.some((entry, index) => entries.slice(index + 1).some((candidate) => (
    pathsOverlap(entry.containerPath, candidate.containerPath)
    || pathsOverlap(candidate.containerPath, entry.containerPath)
  )))) {
    throw new Error('cold_build_input_set_container_path_overlap');
  }
  const inputSetHash = contentHash(stableJson(entries));
  return Object.freeze({
    entries: Object.freeze(entries.map((entry) => Object.freeze(entry))),
    inputSetHash,
  });
}

export function verifyColdBuildInputSet(inputSet, expected = {}) {
  const recomputed = createColdBuildInputSet(expected);
  if (
    stableJson(inputSet?.entries) !== stableJson(recomputed.entries)
    || inputSet?.inputSetHash !== recomputed.inputSetHash
  ) {
    throw new Error('cold_build_input_set_invalid');
  }
  return inputSet;
}
