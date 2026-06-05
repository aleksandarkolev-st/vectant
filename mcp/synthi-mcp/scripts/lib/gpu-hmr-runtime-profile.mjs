import { readFileSync } from 'node:fs';
import path from 'node:path';

export const GPU_HMR_RUNTIME_PROFILE_SCHEMA_VERSION = 'synthi.gpu.hmr.runtime_profile.v1';

export const DEFAULT_HIPRT_RUNTIME_PROFILE = {
  schemaVersion: GPU_HMR_RUNTIME_PROFILE_SCHEMA_VERSION,
  id: 'hiprt-megakernel-direct-light-zero',
  adapter: {
    family: 'hiprt-path-tracer',
    proofRunner: 'hiprt-warm-visual',
  },
  runtime: {
    targetName: 'HIPRTPathTracer',
    requiredKernels: ['CameraRays', 'MegaKernel'],
    reload: {
      kernelName: 'Megakernel (1 SPP)',
      kernelSymbol: 'MegaKernel',
    },
  },
  source: {
    file: 'src/Device/kernels/Megakernel.h',
    before: 'ray_payload.ray_color += estimate_direct_lighting(render_data, ray_payload, closest_hit_info, -ray.direction, x, y, random_number_generator);',
    after: 'ray_payload.ray_color += estimate_direct_lighting(render_data, ray_payload, closest_hit_info, -ray.direction, x, y, random_number_generator) * 0.0f;',
  },
  visualProof: {
    claim: 'A HIPRT MegaKernel direct-lighting math delta materially changes the ray-traced framebuffer.',
    width: 640,
    height: 360,
    minChangedPixelRatio: 0.05,
    minMeanAbsDelta8bit: 1.0,
  },
};

function nonEmptyString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`runtime profile ${field} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value, field) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  return nonEmptyString(value, field);
}

function stringList(value, field) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`runtime profile ${field} must be a non-empty string array`);
  }
  return value.map((item, index) => nonEmptyString(item, `${field}[${index}]`));
}

function positiveInteger(value, field, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`runtime profile ${field} must be a positive integer`);
  }
  return parsed;
}

function nonNegativeNumber(value, field, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`runtime profile ${field} must be a non-negative number`);
  }
  return parsed;
}

function pick(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== '') return value;
  }
  return undefined;
}

export function normalizeRuntimeProofProfile(rawProfile, opts = {}) {
  const raw = rawProfile && typeof rawProfile === 'object' && !Array.isArray(rawProfile)
    ? rawProfile
    : {};
  const source = raw.source && typeof raw.source === 'object' ? raw.source : {};
  const runtime = raw.runtime && typeof raw.runtime === 'object' ? raw.runtime : {};
  const reload = runtime.reload && typeof runtime.reload === 'object' ? runtime.reload : {};
  const adapter = raw.adapter && typeof raw.adapter === 'object' ? raw.adapter : {};
  const visual = raw.visualProof && typeof raw.visualProof === 'object' ? raw.visualProof : {};

  const id = nonEmptyString(pick(raw.id, opts.defaultId, 'custom-runtime-profile'), 'id');
  const adapterFamily = nonEmptyString(
    pick(adapter.family, raw.adapterFamily, opts.defaultAdapterFamily, 'hiprt-path-tracer'),
    'adapter.family',
  ).toLowerCase();
  const proofRunner = nonEmptyString(
    pick(adapter.proofRunner, raw.proofRunner, opts.defaultProofRunner, 'hiprt-warm-visual'),
    'adapter.proofRunner',
  ).toLowerCase();
  const targetName = nonEmptyString(
    pick(runtime.targetName, raw.targetName, opts.defaultTargetName),
    'runtime.targetName',
  );
  const sourceFile = nonEmptyString(
    pick(source.file, source.path, raw.sourceRel, raw.sourceFile),
    'source.file',
  ).replace(/\\/g, '/');
  const before = nonEmptyString(pick(source.before, raw.before), 'source.before');
  const after = nonEmptyString(pick(source.after, raw.after), 'source.after');
  if (before === after) {
    throw new Error('runtime profile source.before and source.after must differ');
  }

  const requiredKernels = stringList(
    pick(runtime.requiredKernels, raw.requiredKernels, opts.defaultRequiredKernels),
    'runtime.requiredKernels',
  );
  const reloadKernelName = nonEmptyString(
    pick(reload.kernelName, reload.kernel, raw.reloadKernelName),
    'runtime.reload.kernelName',
  );
  const reloadKernelSymbol = nonEmptyString(
    pick(reload.kernelSymbol, reload.symbol, raw.reloadKernelSymbol),
    'runtime.reload.kernelSymbol',
  );

  const normalized = {
    schemaVersion: raw.schemaVersion ?? GPU_HMR_RUNTIME_PROFILE_SCHEMA_VERSION,
    id,
    adapter: {
      family: adapterFamily,
      proofRunner,
      capabilities: Array.isArray(adapter.capabilities)
        ? adapter.capabilities.map((item, index) => nonEmptyString(item, `adapter.capabilities[${index}]`))
        : [],
    },
    runtime: {
      targetName,
      workerRepoPath: optionalString(runtime.workerRepoPath ?? raw.workerRepoPath, 'runtime.workerRepoPath'),
      mode: optionalString(runtime.mode ?? raw.mode, 'runtime.mode'),
      requiredKernels,
      reload: {
        kernelName: reloadKernelName,
        kernelSymbol: reloadKernelSymbol,
      },
      args: Array.isArray(runtime.args)
        ? runtime.args.map((item, index) => nonEmptyString(item, `runtime.args[${index}]`))
        : [],
    },
    source: {
      file: sourceFile,
      before,
      after,
    },
    visualProof: {
      claim: nonEmptyString(
        pick(visual.claim, raw.claim, 'A runtime source delta materially changes the visual output.'),
        'visualProof.claim',
      ),
      width: positiveInteger(visual.width ?? raw.width, 'visualProof.width', 640),
      height: positiveInteger(visual.height ?? raw.height, 'visualProof.height', 360),
      minChangedPixelRatio: nonNegativeNumber(
        visual.minChangedPixelRatio ?? raw.minChangedPixelRatio,
        'visualProof.minChangedPixelRatio',
        0.05,
      ),
      minMeanAbsDelta8bit: nonNegativeNumber(
        visual.minMeanAbsDelta8bit ?? raw.minMeanAbsDelta8bit,
        'visualProof.minMeanAbsDelta8bit',
        1.0,
      ),
    },
    proof: {
      requireStrictProvenance: raw.proof && typeof raw.proof === 'object'
        ? raw.proof.requireStrictProvenance !== false
        : true,
    },
  };

  return normalized;
}

export function runtimeProfileToLegacyHiprtWarmProfile(profile) {
  const normalized = normalizeRuntimeProofProfile(profile);
  return {
    id: normalized.id,
    targetName: normalized.runtime.targetName,
    sourceRel: normalized.source.file,
    before: normalized.source.before,
    after: normalized.source.after,
    requiredKernels: normalized.runtime.requiredKernels,
    reloadKernelName: normalized.runtime.reload.kernelName,
    reloadKernelSymbol: normalized.runtime.reload.kernelSymbol,
    mode: normalized.runtime.mode ?? undefined,
    claim: normalized.visualProof.claim,
    width: normalized.visualProof.width,
    height: normalized.visualProof.height,
    minChangedPixelRatio: normalized.visualProof.minChangedPixelRatio,
    minMeanAbsDelta8bit: normalized.visualProof.minMeanAbsDelta8bit,
    workerRepoPath: normalized.runtime.workerRepoPath ?? undefined,
  };
}

export function runtimeProfileToHiprtWarmEnv(profile) {
  const normalized = normalizeRuntimeProofProfile(profile);
  const env = {
    SYNTHI_HIPRT_WARM_PROFILE_ID: normalized.id,
    SYNTHI_HIPRT_WARM_TARGET: normalized.runtime.targetName,
    SYNTHI_HIPRT_WARM_SOURCE_REL: normalized.source.file,
    SYNTHI_HIPRT_WARM_DELTA_BEFORE: normalized.source.before,
    SYNTHI_HIPRT_WARM_DELTA_AFTER: normalized.source.after,
    SYNTHI_HIPRT_WARM_REQUIRED_KERNELS: normalized.runtime.requiredKernels.join(','),
    SYNTHI_HIPRT_WARM_RELOAD_KERNEL_NAME: normalized.runtime.reload.kernelName,
    SYNTHI_HIPRT_WARM_RELOAD_KERNEL_SYMBOL: normalized.runtime.reload.kernelSymbol,
    SYNTHI_HIPRT_WARM_CLAIM: normalized.visualProof.claim,
    SYNTHI_HIPRT_WARM_WIDTH: String(normalized.visualProof.width),
    SYNTHI_HIPRT_WARM_HEIGHT: String(normalized.visualProof.height),
    SYNTHI_HIPRT_WARM_MIN_CHANGED_RATIO: String(normalized.visualProof.minChangedPixelRatio),
    SYNTHI_HIPRT_WARM_MIN_MEAN_ABS_DELTA_8BIT: String(normalized.visualProof.minMeanAbsDelta8bit),
    SYNTHI_HIPRT_WARM_REQUIRE_STRICT_PROVENANCE: normalized.proof.requireStrictProvenance ? '1' : '0',
  };
  if (normalized.runtime.mode) env.SYNTHI_HIPRT_WARM_MODE = normalized.runtime.mode;
  if (normalized.runtime.workerRepoPath) env.SYNTHI_HIPRT_WARM_WORKER_REPO = normalized.runtime.workerRepoPath;
  return env;
}

export function loadRuntimeProofProfileFromEnv(env, repoRoot, defaultProfile = DEFAULT_HIPRT_RUNTIME_PROFILE) {
  const inline = env.SYNTHI_GPU_HMR_RUNTIME_PROFILE_JSON ?? env.SYNTHI_HIPRT_WARM_PROFILE_JSON;
  const profilePath = env.SYNTHI_GPU_HMR_RUNTIME_PROFILE_PATH ?? env.SYNTHI_HIPRT_WARM_PROFILE_PATH;
  let raw;
  if (inline && inline.trim()) {
    raw = JSON.parse(inline);
  } else if (profilePath && profilePath.trim()) {
    raw = JSON.parse(readFileSync(path.resolve(repoRoot, profilePath), 'utf8'));
  } else {
    raw = defaultProfile;
  }
  return normalizeRuntimeProofProfile(raw);
}
