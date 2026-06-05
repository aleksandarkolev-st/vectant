#!/usr/bin/env node
import { execFile as execFileCb, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import sharp from 'sharp';
import {
  DEFAULT_HIPRT_RUNTIME_PROFILE,
  loadRuntimeProofProfileFromEnv,
  runtimeProfileToLegacyHiprtWarmProfile,
} from './lib/gpu-hmr-runtime-profile.mjs';

const execFile = promisify(execFileCb);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../..');
const ARTIFACT_ROOT = path.resolve(__dirname, '../.gpu-hmr-test-artifacts');

const DEFAULT_BEFORE =
  'ray_payload.ray_color += estimate_direct_lighting(render_data, ray_payload, closest_hit_info, -ray.direction, x, y, random_number_generator);';
const DEFAULT_AFTER =
  'ray_payload.ray_color += estimate_direct_lighting(render_data, ray_payload, closest_hit_info, -ray.direction, x, y, random_number_generator) * 0.0f;';

function loadProfile() {
  const normalized = loadRuntimeProofProfileFromEnv(process.env, REPO_ROOT, DEFAULT_HIPRT_RUNTIME_PROFILE);
  return {
    ...runtimeProfileToLegacyHiprtWarmProfile(normalized),
    runtimeProfile: normalized,
  };
}

const PROFILE = loadProfile();

const CFG = {
  slug: process.env.SLUG
    ?? `hiprt-warm-light-math-${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}`,
  workerContainer: process.env.WORKER_CONTAINER ?? 'vectant-ade-worker-1',
  workerRepoPath: process.env.SYNTHI_GPU_HMR_RUNTIME_WORKER_REPO
    ?? process.env.SYNTHI_HIPRT_WARM_WORKER_REPO
    ?? PROFILE.workerRepoPath
    ?? process.env.SYNTHI_REAL_ROCM_WORKER_PATH
    ?? '/tmp/synthi-real-rocm/HIPRT-Path-Tracer',
  mode: (
    process.env.SYNTHI_GPU_HMR_RUNTIME_MODE
    ?? process.env.SYNTHI_HIPRT_WARM_MODE
    ?? PROFILE.mode
    ?? 'fresh-process'
  ).toLowerCase(),
  targetName:
    process.env.SYNTHI_GPU_HMR_RUNTIME_TARGET
    ?? process.env.SYNTHI_HIPRT_WARM_TARGET
    ?? PROFILE.targetName
    ?? 'HIPRTPathTracer',
  sourceRel:
    process.env.SYNTHI_GPU_HMR_RUNTIME_SOURCE_REL
    ?? process.env.SYNTHI_HIPRT_WARM_SOURCE_REL
    ?? PROFILE.sourceRel
    ?? 'src/Device/kernels/Megakernel.h',
  before:
    process.env.SYNTHI_GPU_HMR_RUNTIME_DELTA_BEFORE
    ?? process.env.SYNTHI_HIPRT_WARM_DELTA_BEFORE
    ?? PROFILE.before
    ?? DEFAULT_BEFORE,
  after:
    process.env.SYNTHI_GPU_HMR_RUNTIME_DELTA_AFTER
    ?? process.env.SYNTHI_HIPRT_WARM_DELTA_AFTER
    ?? PROFILE.after
    ?? DEFAULT_AFTER,
  requiredKernels: parseStringListEnv(
    process.env.SYNTHI_GPU_HMR_RUNTIME_REQUIRED_KERNELS
      ?? process.env.SYNTHI_HIPRT_WARM_REQUIRED_KERNELS,
    PROFILE.requiredKernels ?? ['CameraRays', 'MegaKernel'],
  ),
  reloadKernelName:
    process.env.SYNTHI_GPU_HMR_RUNTIME_RELOAD_KERNEL_NAME
    ?? process.env.SYNTHI_HIPRT_WARM_RELOAD_KERNEL_NAME
    ?? PROFILE.reloadKernelName
    ?? 'Megakernel (1 SPP)',
  reloadKernelSymbol:
    process.env.SYNTHI_GPU_HMR_RUNTIME_RELOAD_KERNEL_SYMBOL
    ?? process.env.SYNTHI_HIPRT_WARM_RELOAD_KERNEL_SYMBOL
    ?? PROFILE.reloadKernelSymbol
    ?? 'MegaKernel',
  profileId:
    process.env.SYNTHI_GPU_HMR_RUNTIME_PROFILE_ID
    ?? process.env.SYNTHI_HIPRT_WARM_PROFILE_ID
    ?? PROFILE.id
    ?? 'custom',
  claim:
    process.env.SYNTHI_GPU_HMR_RUNTIME_CLAIM
    ?? process.env.SYNTHI_HIPRT_WARM_CLAIM
    ?? PROFILE.claim
    ?? 'A HIPRT source delta materially changes the ray-traced framebuffer.',
  runtimeArgs: parseJsonStringListEnv(
    process.env.SYNTHI_GPU_HMR_RUNTIME_ARGS_JSON
      ?? process.env.SYNTHI_HIPRT_WARM_RUN_ARGS_JSON,
    PROFILE.runtimeArgs ?? [],
    'runtime arguments',
  ),
  requiredFiles: parseJsonStringListEnv(
    process.env.SYNTHI_GPU_HMR_RUNTIME_REQUIRED_FILES_JSON
      ?? process.env.SYNTHI_HIPRT_WARM_REQUIRED_FILES_JSON,
    PROFILE.requiredFiles ?? [],
    'required runtime files',
  ),
  width: positiveIntegerFromEnv('SYNTHI_HIPRT_WARM_WIDTH', PROFILE.width ?? 640, 'SYNTHI_GPU_HMR_RUNTIME_WIDTH'),
  height: positiveIntegerFromEnv('SYNTHI_HIPRT_WARM_HEIGHT', PROFILE.height ?? 360, 'SYNTHI_GPU_HMR_RUNTIME_HEIGHT'),
  runTimeoutMs: nonNegativeIntegerFromEnv('SYNTHI_HIPRT_WARM_RUN_TIMEOUT_MS', 0, 'SYNTHI_GPU_HMR_RUNTIME_RUN_TIMEOUT_MS'),
  buildTimeoutMs: positiveIntegerFromEnv('SYNTHI_HIPRT_WARM_BUILD_TIMEOUT_MS', 600000, 'SYNTHI_GPU_HMR_RUNTIME_BUILD_TIMEOUT_MS'),
  reloadTimeoutMs: nonNegativeIntegerFromEnv('SYNTHI_HIPRT_WARM_RELOAD_TIMEOUT_MS', 0, 'SYNTHI_GPU_HMR_RUNTIME_RELOAD_TIMEOUT_MS'),
  cmakeConfigName: process.env.SYNTHI_HIPRT_WARM_CMAKE_CONFIG
    ?? process.env.SYNTHI_REAL_ROCM_CMAKE_CONFIG
    ?? 'Release',
  gpuArch:
    process.env.SYNTHI_HIPRT_WARM_GPU_ARCH
    ?? process.env.SYNTHI_GPU_ARCH
    ?? process.env.SYNTHI_REAL_ROCM_GPU_ARCH
    ?? 'gfx1201',
  nativeLaunchObserverPath: process.env.SYNTHI_HIPRT_WARM_NATIVE_OBSERVER_PATH
    ?? process.env.SYNTHI_REAL_ROCM_NATIVE_LAUNCH_OBSERVER_PATH
    ?? '/usr/local/lib/synthi-gpu-native-launch-observer.so',
  outputDir: path.resolve(
    REPO_ROOT,
    process.env.SYNTHI_GPU_HMR_RUNTIME_OUTPUT_DIR
      ?? process.env.SYNTHI_HIPRT_WARM_OUTPUT_DIR
      ?? 'mcp/synthi-mcp/.gpu-hmr-test-artifacts/hiprt-light-math-warm-proof',
  ),
  strictProofJson:
    process.env.SYNTHI_GPU_HMR_RUNTIME_STRICT_PROOF_JSON
    ?? process.env.SYNTHI_HIPRT_WARM_STRICT_PROOF_JSON
    ?? '',
  reuseBaseline: (process.env.SYNTHI_GPU_HMR_RUNTIME_REUSE_BASELINE ?? process.env.SYNTHI_HIPRT_WARM_REUSE_BASELINE) !== '0',
  minChangedPixelRatio: Number(
    process.env.SYNTHI_GPU_HMR_RUNTIME_MIN_CHANGED_RATIO
      ?? process.env.SYNTHI_HIPRT_WARM_MIN_CHANGED_RATIO
      ?? PROFILE.minChangedPixelRatio
      ?? 0.05,
  ),
  minMeanAbsDelta8bit: Number(
    process.env.SYNTHI_GPU_HMR_RUNTIME_MIN_MEAN_ABS_DELTA_8BIT
      ?? process.env.SYNTHI_HIPRT_WARM_MIN_MEAN_ABS_DELTA_8BIT
      ?? PROFILE.minMeanAbsDelta8bit
      ?? 1.0,
  ),
  requireStrictProvenance:
    (process.env.SYNTHI_GPU_HMR_RUNTIME_REQUIRE_STRICT_PROVENANCE ?? process.env.SYNTHI_HIPRT_WARM_REQUIRE_STRICT_PROVENANCE) !== '0',
  allowRejected: (process.env.SYNTHI_GPU_HMR_RUNTIME_ALLOW_REJECTED ?? process.env.SYNTHI_HIPRT_WARM_ALLOW_REJECTED) === '1',
  runtimeProfile: PROFILE.runtimeProfile,
};

if (!['fresh-process', 'same-process'].includes(CFG.mode)) {
  throw new Error(`SYNTHI_HIPRT_WARM_MODE must be fresh-process or same-process, got ${CFG.mode}`);
}

function positiveIntegerFromEnv(name, fallback, aliasName = null) {
  const raw = aliasName && process.env[aliasName] !== undefined
    ? process.env[aliasName]
    : process.env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${aliasName ?? name} must be a positive integer`);
  }
  return value;
}

function nonNegativeIntegerFromEnv(name, fallback, aliasName = null) {
  const raw = aliasName && process.env[aliasName] !== undefined
    ? process.env[aliasName]
    : process.env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${aliasName ?? name} must be a non-negative integer`);
  }
  return value;
}

function parseStringListEnv(raw, fallback) {
  if (raw === undefined || String(raw).trim() === '') return Array.from(fallback);
  return String(raw).split(',').map((item) => item.trim()).filter(Boolean);
}

function parseJsonStringListEnv(raw, fallback, label) {
  const source = raw === undefined || String(raw).trim() === '' ? fallback : JSON.parse(raw);
  if (!Array.isArray(source)) throw new Error(`${label} must be a JSON string array`);
  return source.map((item, index) => {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new Error(`${label}[${index}] must be a non-empty string`);
    }
    return item.trim();
  });
}

function shQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function hiprtWarmXdgRuntimeDir() {
  return `/tmp/synthi-hiprt-warm-xdg-${cleanIdentifier(CFG.slug)}`;
}

function hiprtRuntimeDisplaySetup() {
  const xdgRuntimeDir = hiprtWarmXdgRuntimeDir();
  return [
    `mkdir -p ${shQuote(xdgRuntimeDir)}`,
    `chmod 700 ${shQuote(xdgRuntimeDir)} || true`,
    `export XDG_RUNTIME_DIR=${shQuote(xdgRuntimeDir)}`,
  ].join('\n');
}

function hiprtRuntimeRunInvocation(runCommand) {
  const quoted = shQuote(runCommand);
  return [
    'if command -v xvfb-run >/dev/null 2>&1; then',
    `  xvfb-run -a sh -lc ${quoted}`,
    'else',
    `  sh -lc ${quoted}`,
    'fi',
  ].join('\n');
}

function cleanIdentifier(value) {
  const cleaned = String(value).replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || 'artifact';
}

function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex');
}

async function execText(file, args, options = {}) {
  try {
    const result = await execFile(file, args, {
      timeout: options.timeout ?? 30000,
      maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
      encoding: options.encoding ?? 'utf8',
    });
    return `${result.stdout ?? ''}${result.stderr ?? ''}`;
  } catch (err) {
    const output = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    err.output = output;
    throw err;
  }
}

async function dockerText(args, options = {}) {
  return execText('docker', args, options);
}

async function dockerShell(script, options = {}) {
  return dockerText(['exec', CFG.workerContainer, 'sh', '-lc', script], options);
}

async function dockerCpFromWorker(workerPath, hostPath) {
  await fs.mkdir(path.dirname(hostPath), { recursive: true });
  await dockerText(['cp', `${CFG.workerContainer}:${workerPath}`, hostPath], {
    timeout: 120000,
    maxBuffer: 16 * 1024 * 1024,
  });
}

async function dockerCpToWorker(hostPath, workerPath) {
  await dockerText(['cp', hostPath, `${CFG.workerContainer}:${workerPath}`], {
    timeout: 120000,
    maxBuffer: 16 * 1024 * 1024,
  });
}

function countOccurrences(haystack, needle) {
  if (needle === '') return 0;
  let count = 0;
  let offset = 0;
  for (;;) {
    const next = haystack.indexOf(needle, offset);
    if (next === -1) return count;
    count++;
    offset = next + needle.length;
  }
}

function workerRuntimeRequiredFilePath(file) {
  const normalized = String(file).replace(/\\/g, '/');
  if (normalized.startsWith('/')) return normalized;
  return `${CFG.workerRepoPath}/${normalized}`;
}

async function preflight() {
  const requiredFileChecks = CFG.requiredFiles
    .map((file) => `test -f ${shQuote(workerRuntimeRequiredFilePath(file))}`)
    .join('\n');
  const script = `
set -e
test -d ${shQuote(CFG.workerRepoPath)}
test -d ${shQuote(`${CFG.workerRepoPath}/.git`)}
test -f ${shQuote(CFG.nativeLaunchObserverPath)}
${requiredFileChecks}
repo_commit=$(git -C ${shQuote(CFG.workerRepoPath)} rev-parse HEAD)
if [ -x ${shQuote(`${CFG.workerRepoPath}/build/${CFG.targetName}`)} ]; then
  build_executable=present
else
  build_executable=missing
fi
if [ -f ${shQuote(`${CFG.workerRepoPath}/build/CMakeCache.txt`)} ]; then
  build_config=present
else
  build_config=missing
fi
printf 'repo_commit=%s\\nbuild_executable=%s\\nbuild_config=%s\\n' "$repo_commit" "$build_executable" "$build_config"
`;
  const output = await dockerShell(script, { timeout: 30000 });
  const repoCommit = /^repo_commit=(.+)$/m.exec(output)?.[1]?.trim();
  const buildExecutable = /^build_executable=(.+)$/m.exec(output)?.[1]?.trim();
  const buildConfig = /^build_config=(.+)$/m.exec(output)?.[1]?.trim();
  const bootstrap = {};
  if (buildConfig !== 'present' || buildExecutable !== 'present') {
    bootstrap.configure = await configureHiprtBuild('preflight-bootstrap');
  }
  if (buildExecutable !== 'present') {
    bootstrap.build = await buildHiprtTarget('preflight-bootstrap');
  }
  await dockerShell(
    `test -x ${shQuote(`${CFG.workerRepoPath}/build/${CFG.targetName}`)}`,
    { timeout: 30000 },
  );
  return {
    repoCommit,
    buildExecutable,
    buildConfig,
    bootstrap: Object.keys(bootstrap).length ? bootstrap : null,
  };
}

async function readBaselineSourceFromGit() {
  return dockerText([
    'exec',
    CFG.workerContainer,
    'git',
    '-C',
    CFG.workerRepoPath,
    'show',
    `HEAD:${CFG.sourceRel}`,
  ], { timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
}

async function writeVariantSource({ variant, text }) {
  const localPath = path.join(CFG.outputDir, `${cleanIdentifier(CFG.slug)}-${variant}-${path.basename(CFG.sourceRel)}`);
  await fs.mkdir(path.dirname(localPath), { recursive: true });
  await fs.writeFile(localPath, text);
  await dockerCpToWorker(localPath, `${CFG.workerRepoPath}/${CFG.sourceRel}`);
  const workerHashLine = await dockerShell(
    `sha256sum ${shQuote(`${CFG.workerRepoPath}/${CFG.sourceRel}`)}`,
    { timeout: 30000 },
  );
  return {
    localPath,
    contentHash: `sha256:${sha256Hex(text)}`,
    workerSha256: `sha256:${workerHashLine.trim().split(/\s+/)[0]}`,
  };
}

async function refreshWorkerSourceIndex() {
  await dockerShell(
    `git -C ${shQuote(CFG.workerRepoPath)} update-index --refresh ${shQuote(CFG.sourceRel)} >/dev/null 2>&1 || true`,
    { timeout: 30000 },
  );
}

function parseKernelSymbols(log) {
  const kernels = new Set();
  for (const match of log.matchAll(/\bkernel_symbol=([A-Za-z0-9_.$-]+)/g)) {
    kernels.add(match[1]);
  }
  for (const match of log.matchAll(/Kernel "([^"]+)" compiled/g)) {
    kernels.add(match[1]);
  }
  return Array.from(kernels).sort();
}

function parseCaptureLine(log) {
  return log.split(/\r?\n/).find((line) =>
    line.includes('[synthi-hiprt-runtime-probe]')
    && line.includes('capture_path=')
    && line.includes('wrote=1')
  ) ?? '';
}

const SAME_PROCESS_ADAPTER_HELPERS = String.raw`
// SYNTHI_SAME_PROCESS_HIPRT_HOT_SWAP_ADAPTER_BEGIN
bool synthi_probe_file_exists(const char* path)
{
	if (path == nullptr || path[0] == '\0')
		return false;
	std::ifstream file(path);
	return file.good();
}

int synthi_probe_env_int(const char* name, int fallback_value)
{
	const char* raw = std::getenv(name);
	if (raw == nullptr || raw[0] == '\0')
		return fallback_value;
	return std::max(1, std::atoi(raw));
}

int synthi_probe_env_timeout_ms(const char* name, int fallback_value)
{
	const char* raw = std::getenv(name);
	if (raw == nullptr || raw[0] == '\0')
		return fallback_value;
	return std::max(0, std::atoi(raw));
}

const char* synthi_probe_required_env(const char* name)
{
	const char* value = std::getenv(name);
	if (value == nullptr || value[0] == '\0')
	{
		std::fprintf(stderr, "[synthi-hiprt-runtime-probe] same_process_missing_env name=%s\n", name);
		return nullptr;
	}
	return value;
}

bool synthi_wait_for_reload_trigger()
{
	const char* trigger_path = synthi_probe_required_env("SYNTHI_HIPRT_RUNTIME_PROBE_RELOAD_TRIGGER_PATH");
	if (trigger_path == nullptr)
		return false;

	const int timeout_ms = synthi_probe_env_timeout_ms("SYNTHI_HIPRT_RUNTIME_PROBE_RELOAD_TIMEOUT_MS", 0);
	const bool timeout_enabled = timeout_ms > 0;
	const auto start = std::chrono::steady_clock::now();
	if (timeout_enabled)
		std::fprintf(stderr, "[synthi-hiprt-runtime-probe] same_process_wait trigger=%s timeout_ms=%d\n", trigger_path, timeout_ms);
	else
		std::fprintf(stderr, "[synthi-hiprt-runtime-probe] same_process_wait trigger=%s timeout_ms=unbounded\n", trigger_path);
	while (!synthi_probe_file_exists(trigger_path))
	{
		std::this_thread::sleep_for(std::chrono::milliseconds(10));
		const auto now = std::chrono::steady_clock::now();
		const auto elapsed_ms = std::chrono::duration_cast<std::chrono::milliseconds>(now - start).count();
		if (timeout_enabled && elapsed_ms > timeout_ms)
		{
			std::fprintf(stderr, "[synthi-hiprt-runtime-probe] same_process_timeout trigger=%s elapsed_ms=%lld\n", trigger_path, static_cast<long long>(elapsed_ms));
			return false;
		}
	}

	const auto end = std::chrono::steady_clock::now();
	const auto elapsed_ms = std::chrono::duration_cast<std::chrono::milliseconds>(end - start).count();
	std::fprintf(stderr, "[synthi-hiprt-runtime-probe] same_process_trigger_observed trigger=%s wait_ms=%lld\n", trigger_path, static_cast<long long>(elapsed_ms));
	return true;
}

bool synthi_write_runtime_framebuffer_to_path(const std::shared_ptr<OpenGLInteropBuffer<ColorRGB32F>>& framebuffer, int width, int height, oroStream_t stream, const char* capture_path, const char* label)
{
	if (capture_path == nullptr || capture_path[0] == '\0')
		return false;

	if (framebuffer == nullptr)
		return false;

	OROCHI_CHECK_ERROR(oroStreamSynchronize(stream));

	std::vector<ColorRGB32F> framebuffer_pixels = framebuffer->download_data();
	const size_t expected_pixels = static_cast<size_t>(width) * static_cast<size_t>(height);
	if (framebuffer_pixels.size() < expected_pixels || expected_pixels == 0)
	{
		std::fprintf(stderr, "[synthi-hiprt-runtime-probe] same_process_capture_failed label=%s path=%s width=%d height=%d pixels=%zu expected_pixels=%zu reason=framebuffer_readback_unavailable\n", label, capture_path, width, height, framebuffer_pixels.size(), expected_pixels);
		return false;
	}

	std::vector<float> pixels(expected_pixels * 3);
	double luma_sum = 0.0;
	double luma_sq_sum = 0.0;
	size_t non_black_pixels = 0;
	float min_luma = 1.0e30f;
	float max_luma = -1.0e30f;
	for (size_t i = 0; i < expected_pixels; i++)
	{
		const ColorRGB32F pixel = framebuffer_pixels[i];
		const float r = std::max(0.0f, pixel.r);
		const float g = std::max(0.0f, pixel.g);
		const float b = std::max(0.0f, pixel.b);
		pixels[i * 3 + 0] = r;
		pixels[i * 3 + 1] = g;
		pixels[i * 3 + 2] = b;

		const float luma = 0.3086f * r + 0.6094f * g + 0.0820f * b;
		luma_sum += luma;
		luma_sq_sum += static_cast<double>(luma) * static_cast<double>(luma);
		min_luma = std::min(min_luma, luma);
		max_luma = std::max(max_luma, luma);
		if (r > 0.0001f || g > 0.0001f || b > 0.0001f)
			non_black_pixels++;
	}

	Image32Bit image(pixels, width, height, 3);
	const bool wrote = image.write_image_png(capture_path, true);
	const double mean_luma = luma_sum / static_cast<double>(expected_pixels);
	const double variance = std::max(0.0, luma_sq_sum / static_cast<double>(expected_pixels) - mean_luma * mean_luma);
	std::fprintf(stderr, "[synthi-hiprt-runtime-probe] same_process_capture label=%s capture_path=%s wrote=%d width=%d height=%d pixels=%zu non_black_pixels=%zu mean_luma=%.9f luma_stddev=%.9f min_luma=%.9f max_luma=%.9f framebuffer_fallback=%d\n",
		label,
		capture_path,
		wrote ? 1 : 0,
		width,
		height,
		expected_pixels,
		non_black_pixels,
		mean_luma,
		std::sqrt(variance),
		min_luma,
		max_luma,
		framebuffer->uses_device_buffer_fallback() ? 1 : 0);
	return wrote;
}
// SYNTHI_SAME_PROCESS_HIPRT_HOT_SWAP_ADAPTER_END
`;

const SAME_PROCESS_RENDER_BLOCK = String.raw`
	if (std::getenv("SYNTHI_HIPRT_RUNTIME_PROBE_SAME_PROCESS") != nullptr)
	{
		static bool synthi_same_process_probe_completed = false;
		if (!synthi_same_process_probe_completed)
		{
			synthi_same_process_probe_completed = true;
			const char* second_capture_path = synthi_probe_required_env("SYNTHI_HIPRT_RUNTIME_PROBE_SECOND_CAPTURE_PATH");
			const int synthi_probe_width = synthi_probe_env_int("SYNTHI_HIPRT_RUNTIME_PROBE_PROOF_WIDTH", m_renderer->m_render_resolution.x);
			const int synthi_probe_height = synthi_probe_env_int("SYNTHI_HIPRT_RUNTIME_PROBE_PROOF_HEIGHT", m_renderer->m_render_resolution.y);
			if (second_capture_path != nullptr && synthi_wait_for_reload_trigger())
			{
				const char* synthi_reload_kernel_name = synthi_probe_required_env("SYNTHI_HIPRT_RUNTIME_PROBE_RELOAD_KERNEL_NAME");
				const char* synthi_reload_kernel_symbol = synthi_probe_required_env("SYNTHI_HIPRT_RUNTIME_PROBE_RELOAD_KERNEL_SYMBOL");
				if (synthi_reload_kernel_name == nullptr || synthi_reload_kernel_symbol == nullptr)
				{
					std::fflush(stderr);
					std::exit(88);
				}
				const auto recompile_start = std::chrono::steady_clock::now();
				auto synthi_live_kernels = m_render_graph.get_all_kernels();
				auto synthi_reload_kernel = synthi_live_kernels.find(synthi_reload_kernel_name);
				if (synthi_reload_kernel == synthi_live_kernels.end() || synthi_reload_kernel->second == nullptr)
				{
					std::fprintf(stderr, "[synthi-hiprt-runtime-probe] same_process_recompile result=failed reason=reload_kernel_not_found kernel_name=%s kernel_symbol=%s\n", synthi_reload_kernel_name, synthi_reload_kernel_symbol);
					std::fflush(stderr);
					std::exit(88);
				}
				synthi_reload_kernel->second->compile(m_renderer->m_hiprt_orochi_ctx, m_renderer->m_func_name_sets, true, false);
				const auto recompile_end = std::chrono::steady_clock::now();
				const auto recompile_ms = std::chrono::duration_cast<std::chrono::milliseconds>(recompile_end - recompile_start).count();
				std::fprintf(stderr, "[synthi-hiprt-runtime-probe] same_process_recompile result=success kernel=%s kernel_name=%s elapsed_ms=%lld\n", synthi_reload_kernel_symbol, synthi_reload_kernel_name, static_cast<long long>(recompile_ms));

				m_renderer->reset(false);
				m_render_graph.prepass();
				m_render_data_for_frame.render_settings.need_to_reset = true;
				m_render_data_for_frame.render_settings.sample_number = 0;
				m_render_data_for_frame.render_settings.do_update_status_buffers = true;
				m_render_data_for_frame.render_settings.render_resolution = make_int2(synthi_probe_width, synthi_probe_height);
				m_render_data_for_frame.current_camera = m_renderer->m_camera.to_hiprt(synthi_probe_width, synthi_probe_height);
				m_render_data_for_frame.prev_camera = m_renderer->m_previous_frame_camera.to_hiprt(synthi_probe_width, synthi_probe_height);
				m_render_data_for_frame.random_number = 42;
				m_compiler_options_for_frame = m_renderer->get_global_compiler_options()->deep_copy();
				std::fprintf(stderr, "[synthi-hiprt-runtime-probe] same_process_resolution proof_width=%d proof_height=%d renderer_width=%d renderer_height=%d render_data_width=%d render_data_height=%d\n",
					synthi_probe_width,
					synthi_probe_height,
					m_renderer->m_render_resolution.x,
					m_renderer->m_render_resolution.y,
					m_render_data_for_frame.render_settings.render_resolution.x,
					m_render_data_for_frame.render_settings.render_resolution.y);
				m_render_graph.launch_async(m_render_data_for_frame, m_compiler_options_for_frame);
				post_sample_update(m_render_data_for_frame, m_compiler_options_for_frame);

				const bool wrote_second = synthi_write_runtime_framebuffer_to_path(
					m_renderer->m_framebuffer,
					synthi_probe_width,
					synthi_probe_height,
					m_renderer->get_main_stream(),
					second_capture_path,
					"changed-after-in-process-recompile");
				if (wrote_second && std::getenv("SYNTHI_HIPRT_RUNTIME_PROBE_EXIT_AFTER_SECOND_CAPTURE") != nullptr)
				{
					std::fflush(stderr);
					std::exit(0);
				}
			}
		}
	}
`;

async function runHiprtVariant(variant) {
  const workerCapturePath = `${CFG.workerRepoPath}/${cleanIdentifier(CFG.slug)}-${variant}-framebuffer.png`;
  const localCapturePath = path.join(CFG.outputDir, `${cleanIdentifier(CFG.slug)}-${variant}-framebuffer.png`);
  const localLogPath = path.join(CFG.outputDir, `${cleanIdentifier(CFG.slug)}-${variant}-run.log`);
  const runCommand = [
    `./${shQuote(CFG.targetName)}`,
    ...CFG.runtimeArgs.map(shQuote),
    `--width=${CFG.width}`,
    `--height=${CFG.height}`,
  ].join(' ');
  const script = `
set -e
cd ${shQuote(CFG.workerRepoPath)}
rm -f ${shQuote(workerCapturePath)}
export SYNTHI_HIPRT_DISABLE_GPU_TEXTURE_OBJECTS=1
export SYNTHI_HIPRT_DISABLE_OPENGL_INTEROP=1
export SYNTHI_HIPRT_RUNTIME_PROBE_CAPTURE_PATH=${shQuote(workerCapturePath)}
export SYNTHI_HIPRT_RUNTIME_PROBE_EXIT_AFTER_CAPTURE=1
export LD_PRELOAD=${shQuote(CFG.nativeLaunchObserverPath)}\${LD_PRELOAD:+:\${LD_PRELOAD}}
export SYNTHI_GPU_NATIVE_LAUNCH_OBSERVER=observe_only
${hiprtRuntimeDisplaySetup()}
start=$(date +%s%3N)
cd build
set +e
${hiprtRuntimeRunInvocation(runCommand)}
status=$?
set -e
end=$(date +%s%3N)
printf 'SYNTHI_WARM_PROOF_TIMING variant=%s run_ms=%s exit_code=%s capture_path=%s\\n' ${shQuote(variant)} "$((end-start))" "$status" ${shQuote(workerCapturePath)}
exit "$status"
`;
  const startedAt = Date.now();
  const log = await dockerShell(script, {
    timeout: CFG.runTimeoutMs,
    maxBuffer: 96 * 1024 * 1024,
  });
  const endedAt = Date.now();
  await fs.mkdir(CFG.outputDir, { recursive: true });
  await fs.writeFile(localLogPath, log);
  await dockerShell(`test -s ${shQuote(workerCapturePath)}`, { timeout: 30000 });
  await dockerCpFromWorker(workerCapturePath, localCapturePath);
  const timingMatch = /SYNTHI_WARM_PROOF_TIMING\s+variant=\S+\s+run_ms=(\d+)\s+exit_code=(\d+)/.exec(log);
  return {
    variant,
    runMs: timingMatch ? Number(timingMatch[1]) : endedAt - startedAt,
    hostWallMs: endedAt - startedAt,
    exitCode: timingMatch ? Number(timingMatch[2]) : 0,
    workerCapturePath,
    localCapturePath,
    localLogPath,
    captureLine: parseCaptureLine(log),
    nativeLaunchKernels: parseKernelSymbols(log),
    logSha256: `sha256:${sha256Hex(log)}`,
  };
}

async function readWorkerText(workerPath) {
  return dockerShell(`cat ${shQuote(workerPath)}`, {
    timeout: 30000,
    maxBuffer: 16 * 1024 * 1024,
  });
}

async function writeWorkerText(workerPath, text, localName) {
  const localPath = path.join(CFG.outputDir, `${cleanIdentifier(CFG.slug)}-${localName}`);
  await fs.mkdir(path.dirname(localPath), { recursive: true });
  await fs.writeFile(localPath, text);
  await dockerCpToWorker(localPath, workerPath);
  return localPath;
}

async function applySameProcessAdapter() {
  const workerPath = `${CFG.workerRepoPath}/src/Renderer/GPURendererThread.cpp`;
  let text = await readWorkerText(workerPath);
  if (!text.includes('SYNTHI_HIPRT_RUNTIME_PROBE_CAPTURE_PATH')) {
    throw new Error('HIPRT runtime framebuffer probe adaptation is missing; run the strict HIPRT validator adaptation first');
  }

  const beforeHash = `sha256:${sha256Hex(text)}`;
  if (text.includes('SYNTHI_SAME_PROCESS_HIPRT_HOT_SWAP_ADAPTER_BEGIN')) {
    const wholeGraphRecompile = '\t\t\t\tm_renderer->recompile_kernels(true);';
    const targetedRecompile = String.raw`				auto synthi_live_kernels = m_render_graph.get_all_kernels();
				auto synthi_mega_kernel = synthi_live_kernels.find("Megakernel (1 SPP)");
				if (synthi_mega_kernel == synthi_live_kernels.end() || synthi_mega_kernel->second == nullptr)
				{
					std::fprintf(stderr, "[synthi-hiprt-runtime-probe] same_process_recompile result=failed reason=megakernel_not_found\n");
					std::fflush(stderr);
					std::exit(88);
				}
				m_renderer->synchronize_all_kernels();
				synthi_mega_kernel->second->compile(m_renderer->m_hiprt_orochi_ctx, m_renderer->m_func_name_sets, true, false);`;
    const currentTargetedRecompile = String.raw`				auto synthi_live_kernels = m_render_graph.get_all_kernels();
				auto synthi_mega_kernel = synthi_live_kernels.find("Megakernel (1 SPP)");
				if (synthi_mega_kernel == synthi_live_kernels.end() || synthi_mega_kernel->second == nullptr)
				{
					std::fprintf(stderr, "[synthi-hiprt-runtime-probe] same_process_recompile result=failed reason=megakernel_not_found\n");
					std::fflush(stderr);
					std::exit(88);
				}
				synthi_mega_kernel->second->compile(m_renderer->m_hiprt_orochi_ctx, m_renderer->m_func_name_sets, true, false);`;
    const profiledTargetRecompile = String.raw`				const char* synthi_reload_kernel_name = synthi_probe_required_env("SYNTHI_HIPRT_RUNTIME_PROBE_RELOAD_KERNEL_NAME");
				const char* synthi_reload_kernel_symbol = synthi_probe_required_env("SYNTHI_HIPRT_RUNTIME_PROBE_RELOAD_KERNEL_SYMBOL");
				if (synthi_reload_kernel_name == nullptr || synthi_reload_kernel_symbol == nullptr)
				{
					std::fflush(stderr);
					std::exit(88);
				}
				auto synthi_live_kernels = m_render_graph.get_all_kernels();
				auto synthi_reload_kernel = synthi_live_kernels.find(synthi_reload_kernel_name);
				if (synthi_reload_kernel == synthi_live_kernels.end() || synthi_reload_kernel->second == nullptr)
				{
					std::fprintf(stderr, "[synthi-hiprt-runtime-probe] same_process_recompile result=failed reason=reload_kernel_not_found kernel_name=%s kernel_symbol=%s\n", synthi_reload_kernel_name, synthi_reload_kernel_symbol);
					std::fflush(stderr);
					std::exit(88);
				}
				synthi_reload_kernel->second->compile(m_renderer->m_hiprt_orochi_ctx, m_renderer->m_func_name_sets, true, false);`;
    let upgraded = false;
    if (text.includes(wholeGraphRecompile)) {
      text = text.replace(wholeGraphRecompile, profiledTargetRecompile);
      upgraded = true;
    }
    if (text.includes(targetedRecompile)) {
      text = text.replace(targetedRecompile, profiledTargetRecompile);
      upgraded = true;
    }
    if (text.includes(currentTargetedRecompile)) {
      text = text.replace(currentTargetedRecompile, profiledTargetRecompile);
      upgraded = true;
    }
    if (!text.includes('same_process_recompile result=success kernel=') && text.includes('same_process_recompile result=success elapsed_ms=%lld')) {
      text = text.replace(
        'same_process_recompile result=success elapsed_ms=%lld',
        'same_process_recompile result=success kernel=MegaKernel elapsed_ms=%lld',
      );
      upgraded = true;
    }
    if (text.includes('same_process_recompile result=success kernel=MegaKernel elapsed_ms=%lld')) {
      text = text.replace(
        'same_process_recompile result=success kernel=MegaKernel elapsed_ms=%lld',
        'same_process_recompile result=success kernel=%s kernel_name=%s elapsed_ms=%lld',
      );
      text = text.replace(
        'static_cast<long long>(recompile_ms));',
        'synthi_reload_kernel_symbol, synthi_reload_kernel_name, static_cast<long long>(recompile_ms));',
      );
      upgraded = true;
    }
    if (text.includes('\n\t\t\t\tm_renderer->synchronize_all_kernels();\n\t\t\t\tsynthi_mega_kernel->second->compile')) {
      text = text.replace(
        '\n\t\t\t\tm_renderer->synchronize_all_kernels();\n\t\t\t\tsynthi_mega_kernel->second->compile',
        '\n\t\t\t\tsynthi_mega_kernel->second->compile',
      );
      upgraded = true;
    }
    if (!text.includes('const int synthi_probe_width =')) {
      text = text.replace(
        '\t\t\t\tconst char* second_capture_path = synthi_probe_required_env("SYNTHI_HIPRT_RUNTIME_PROBE_SECOND_CAPTURE_PATH");',
        '\t\t\t\tconst char* second_capture_path = synthi_probe_required_env("SYNTHI_HIPRT_RUNTIME_PROBE_SECOND_CAPTURE_PATH");\n\t\t\t\tconst int synthi_probe_width = synthi_probe_env_int("SYNTHI_HIPRT_RUNTIME_PROBE_PROOF_WIDTH", m_renderer->m_render_resolution.x);\n\t\t\t\tconst int synthi_probe_height = synthi_probe_env_int("SYNTHI_HIPRT_RUNTIME_PROBE_PROOF_HEIGHT", m_renderer->m_render_resolution.y);',
      );
      upgraded = true;
    }
    if (!text.includes('synthi_probe_env_timeout_ms(')) {
      text = text.replace(
        String.raw`int synthi_probe_env_int(const char* name, int fallback_value)
{
	const char* raw = std::getenv(name);
	if (raw == nullptr || raw[0] == '\0')
		return fallback_value;
	return std::max(1, std::atoi(raw));
}

`,
        String.raw`int synthi_probe_env_int(const char* name, int fallback_value)
{
	const char* raw = std::getenv(name);
	if (raw == nullptr || raw[0] == '\0')
		return fallback_value;
	return std::max(1, std::atoi(raw));
}

int synthi_probe_env_timeout_ms(const char* name, int fallback_value)
{
	const char* raw = std::getenv(name);
	if (raw == nullptr || raw[0] == '\0')
		return fallback_value;
	return std::max(0, std::atoi(raw));
}

`,
      );
      upgraded = true;
    }
    if (text.includes('const int timeout_ms = synthi_probe_env_int("SYNTHI_HIPRT_RUNTIME_PROBE_RELOAD_TIMEOUT_MS", 60000);')) {
      text = text.replace(
        'const int timeout_ms = synthi_probe_env_int("SYNTHI_HIPRT_RUNTIME_PROBE_RELOAD_TIMEOUT_MS", 60000);',
        'const int timeout_ms = synthi_probe_env_timeout_ms("SYNTHI_HIPRT_RUNTIME_PROBE_RELOAD_TIMEOUT_MS", 0);\n\tconst bool timeout_enabled = timeout_ms > 0;',
      );
      text = text.replace(
        'std::fprintf(stderr, "[synthi-hiprt-runtime-probe] same_process_wait trigger=%s timeout_ms=%d\\n", trigger_path, timeout_ms);',
        'if (timeout_enabled)\n\t\tstd::fprintf(stderr, "[synthi-hiprt-runtime-probe] same_process_wait trigger=%s timeout_ms=%d\\n", trigger_path, timeout_ms);\n\telse\n\t\tstd::fprintf(stderr, "[synthi-hiprt-runtime-probe] same_process_wait trigger=%s timeout_ms=unbounded\\n", trigger_path);',
      );
      text = text.replace(
        'if (elapsed_ms > timeout_ms)',
        'if (timeout_enabled && elapsed_ms > timeout_ms)',
      );
      upgraded = true;
    }
    if (text.includes('const int synthi_probe_width = m_renderer->m_render_resolution.x;')) {
      text = text.replaceAll(
        'const int synthi_probe_width = m_renderer->m_render_resolution.x;',
        'const int synthi_probe_width = synthi_probe_env_int("SYNTHI_HIPRT_RUNTIME_PROBE_PROOF_WIDTH", m_renderer->m_render_resolution.x);',
      );
      upgraded = true;
    }
    if (text.includes('const int synthi_probe_height = m_renderer->m_render_resolution.y;')) {
      text = text.replaceAll(
        'const int synthi_probe_height = m_renderer->m_render_resolution.y;',
        'const int synthi_probe_height = synthi_probe_env_int("SYNTHI_HIPRT_RUNTIME_PROBE_PROOF_HEIGHT", m_renderer->m_render_resolution.y);',
      );
      upgraded = true;
    }
    const movedDimensionText = text.replace(
      /([ \t]*const char\* second_capture_path = synthi_probe_required_env\("SYNTHI_HIPRT_RUNTIME_PROBE_SECOND_CAPTURE_PATH"\);\n)([ \t]*if \(second_capture_path != nullptr && synthi_wait_for_reload_trigger\(\)\)\n[ \t]*\{\n)[ \t]*const int synthi_probe_width = m_renderer->m_render_resolution\.x;\n[ \t]*const int synthi_probe_height = m_renderer->m_render_resolution\.y;\n/,
      (_, captureLine, waitLine) => {
        if (captureLine.includes('const int synthi_probe_width')) return `${captureLine}${waitLine}`;
        const indent = captureLine.match(/^[ \t]*/)?.[0] ?? '';
        return `${captureLine}${indent}const int synthi_probe_width = m_renderer->m_render_resolution.x;\n${indent}const int synthi_probe_height = m_renderer->m_render_resolution.y;\n${waitLine}`;
      },
    );
    if (movedDimensionText !== text) {
      text = movedDimensionText;
      upgraded = true;
    }
    if (!text.includes('same_process_resolution proof_width=')) {
      text = text.replace(
        '\t\t\t\tm_render_data_for_frame.render_settings.do_update_status_buffers = true;\n\t\t\t\tm_render_data_for_frame.random_number = 42;\n\t\t\t\tm_compiler_options_for_frame = m_renderer->get_global_compiler_options()->deep_copy();',
        '\t\t\t\tm_render_data_for_frame.render_settings.do_update_status_buffers = true;\n\t\t\t\tm_render_data_for_frame.render_settings.render_resolution = make_int2(synthi_probe_width, synthi_probe_height);\n\t\t\t\tm_render_data_for_frame.current_camera = m_renderer->m_camera.to_hiprt(synthi_probe_width, synthi_probe_height);\n\t\t\t\tm_render_data_for_frame.prev_camera = m_renderer->m_previous_frame_camera.to_hiprt(synthi_probe_width, synthi_probe_height);\n\t\t\t\tm_render_data_for_frame.random_number = 42;\n\t\t\t\tm_compiler_options_for_frame = m_renderer->get_global_compiler_options()->deep_copy();\n\t\t\t\tstd::fprintf(stderr, "[synthi-hiprt-runtime-probe] same_process_resolution proof_width=%d proof_height=%d renderer_width=%d renderer_height=%d render_data_width=%d render_data_height=%d\\n",\n\t\t\t\t\tsynthi_probe_width,\n\t\t\t\t\tsynthi_probe_height,\n\t\t\t\t\tm_renderer->m_render_resolution.x,\n\t\t\t\t\tm_renderer->m_render_resolution.y,\n\t\t\t\t\tm_render_data_for_frame.render_settings.render_resolution.x,\n\t\t\t\t\tm_render_data_for_frame.render_settings.render_resolution.y);',
      );
      text = text.replace(
        '\t\t\t\t\tm_renderer->m_framebuffer,\n\t\t\t\t\tm_renderer->m_render_resolution.x,\n\t\t\t\t\tm_renderer->m_render_resolution.y,\n\t\t\t\t\tm_renderer->get_main_stream(),',
        '\t\t\t\t\tm_renderer->m_framebuffer,\n\t\t\t\t\tsynthi_probe_width,\n\t\t\t\t\tsynthi_probe_height,\n\t\t\t\t\tm_renderer->get_main_stream(),',
      );
      upgraded = true;
    }
    if (upgraded) {
      const localPath = await writeWorkerText(workerPath, text, 'same-process-upgraded-GPURendererThread.cpp');
      return {
        applied: true,
        reason: 'upgraded-targeted-megakernel-recompile',
        workerPath,
        localPath,
        beforeHash,
        afterHash: `sha256:${sha256Hex(text)}`,
      };
    }
    return {
      applied: false,
      reason: 'already-adapted',
      workerPath,
      beforeHash,
      afterHash: beforeHash,
    };
  }

  if (!text.includes('#include <vector>\n')) {
    throw new Error('GPURendererThread.cpp include anchor not found');
  }
  text = text.replace(
    '#include <vector>\n',
    '#include <vector>\n#include <chrono>\n#include <fstream>\n#include <string>\n#include <thread>\n',
  );

  const namespaceEndAnchor = '\n}\n\nvoid GPURendererThread::init(GPURenderer* renderer)';
  if (!text.includes(namespaceEndAnchor)) {
    throw new Error('GPURendererThread.cpp namespace end anchor not found');
  }
  text = text.replace(
    namespaceEndAnchor,
    `\n${SAME_PROCESS_ADAPTER_HELPERS}\n}\n\nvoid GPURendererThread::init(GPURenderer* renderer)`,
  );

  const captureCall = `\tsynthi_capture_runtime_framebuffer_if_requested(
\t\tm_renderer->m_framebuffer,
\t\tm_renderer->m_render_resolution.x,
\t\tm_renderer->m_render_resolution.y,
\t\tm_renderer->get_main_stream());`;
  if (!text.includes(captureCall)) {
    throw new Error('GPURendererThread.cpp capture call anchor not found');
  }
  text = text.replace(captureCall, `${captureCall}\n${SAME_PROCESS_RENDER_BLOCK}`);

  const localPath = await writeWorkerText(workerPath, text, 'same-process-adapted-GPURendererThread.cpp');
  return {
    applied: true,
    workerPath,
    localPath,
    beforeHash,
    afterHash: `sha256:${sha256Hex(text)}`,
  };
}

async function buildHiprtTarget(reason) {
  const localLogPath = path.join(CFG.outputDir, `${cleanIdentifier(CFG.slug)}-${reason}-build.log`);
  const script = `
set -e
cd ${shQuote(CFG.workerRepoPath)}
start=$(date +%s%3N)
cmake --build build -j2 --target ${shQuote(CFG.targetName)}
status=$?
end=$(date +%s%3N)
printf 'SYNTHI_WARM_BUILD_TIMING reason=%s build_ms=%s exit_code=%s\\n' ${shQuote(reason)} "$((end-start))" "$status"
exit "$status"
`;
  const startedAt = Date.now();
  const log = await dockerShell(script, {
    timeout: CFG.buildTimeoutMs,
    maxBuffer: 96 * 1024 * 1024,
  });
  const endedAt = Date.now();
  await fs.mkdir(CFG.outputDir, { recursive: true });
  await fs.writeFile(localLogPath, log);
  const timingMatch = /SYNTHI_WARM_BUILD_TIMING\s+reason=\S+\s+build_ms=(\d+)\s+exit_code=(\d+)/.exec(log);
  return {
    reason,
    buildMs: timingMatch ? Number(timingMatch[1]) : endedAt - startedAt,
    hostWallMs: endedAt - startedAt,
    exitCode: timingMatch ? Number(timingMatch[2]) : 0,
    localLogPath,
    logSha256: `sha256:${sha256Hex(log)}`,
  };
}

async function configureHiprtBuild(reason) {
  const localLogPath = path.join(CFG.outputDir, `${cleanIdentifier(CFG.slug)}-${reason}-configure.log`);
  const script = `
set -e
cd ${shQuote(CFG.workerRepoPath)}
mkdir -p build/.cmake/api/v1/query
touch build/.cmake/api/v1/query/codemodel-v2
start=$(date +%s%3N)
cmake -S . -B build -DCMAKE_BUILD_TYPE=${shQuote(CFG.cmakeConfigName)} -DCMAKE_EXPORT_COMPILE_COMMANDS=ON -DCMAKE_PREFIX_PATH=/opt/rocm -DCMAKE_HIP_ARCHITECTURES=${shQuote(CFG.gpuArch)} -DASSIMP_WARNINGS_AS_ERRORS=OFF
status=$?
end=$(date +%s%3N)
printf 'SYNTHI_WARM_CONFIGURE_TIMING reason=%s configure_ms=%s exit_code=%s\\n' ${shQuote(reason)} "$((end-start))" "$status"
exit "$status"
`;
  const startedAt = Date.now();
  const log = await dockerShell(script, {
    timeout: CFG.buildTimeoutMs,
    maxBuffer: 96 * 1024 * 1024,
  });
  const endedAt = Date.now();
  await fs.mkdir(CFG.outputDir, { recursive: true });
  await fs.writeFile(localLogPath, log);
  const timingMatch = /SYNTHI_WARM_CONFIGURE_TIMING\s+reason=\S+\s+configure_ms=(\d+)\s+exit_code=(\d+)/.exec(log);
  return {
    reason,
    configureMs: timingMatch ? Number(timingMatch[1]) : endedAt - startedAt,
    hostWallMs: endedAt - startedAt,
    exitCode: timingMatch ? Number(timingMatch[2]) : 0,
    localLogPath,
    logSha256: `sha256:${sha256Hex(log)}`,
  };
}

function spawnDockerShell(script, { timeout, maxBuffer = 96 * 1024 * 1024 } = {}) {
  const child = spawn('docker', ['exec', CFG.workerContainer, 'sh', '-lc', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  const startedAt = Date.now();
  let timer = null;
  if (timeout) {
    timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, 2000).unref();
    }, timeout);
    timer.unref();
  }
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
    if (stdout.length + stderr.length > maxBuffer) {
      child.kill('SIGTERM');
    }
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
    if (stdout.length + stderr.length > maxBuffer) {
      child.kill('SIGTERM');
    }
  });
  const completion = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      const output = `${stdout}${stderr}`;
      const result = {
        code,
        signal,
        stdout,
        stderr,
        output,
        timedOut,
        hostWallMs: Date.now() - startedAt,
      };
      if (timedOut || code !== 0) {
        const err = new Error(timedOut ? 'docker shell timed out' : `docker shell exited ${code}`);
        err.output = output;
        err.result = result;
        reject(err);
      } else {
        resolve(result);
      }
    });
  });
  return { child, completion };
}

async function waitForWorkerFile(workerPath, timeoutMs, processCompletion = null) {
  const startedAt = Date.now();
  const processState = {
    settled: false,
    error: null,
  };
  if (processCompletion) {
    processCompletion.then(
      () => {
        processState.settled = true;
      },
      (err) => {
        processState.settled = true;
        processState.error = err;
      },
    );
  }
  for (;;) {
    const exists = (await dockerShell(
      `test -s ${shQuote(workerPath)} && printf 1 || printf 0`,
      { timeout: 30000 },
    )).trim() === '1';
    if (exists) return Date.now() - startedAt;
    if (processState.settled) {
      if (processState.error) throw processState.error;
      throw new Error(`runtime process exited before worker file was written: ${workerPath}`);
    }
    if (timeoutMs > 0 && Date.now() - startedAt > timeoutMs) {
      throw new Error(`timed out waiting for worker file ${workerPath}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function runHiprtSameProcess({ changedSource }) {
  const slug = cleanIdentifier(CFG.slug);
  const workerBaselinePath = `${CFG.workerRepoPath}/${slug}-same-process-baseline-framebuffer.png`;
  const workerChangedPath = `${CFG.workerRepoPath}/${slug}-same-process-changed-framebuffer.png`;
  const workerTriggerPath = `${CFG.workerRepoPath}/${slug}-same-process-reload.trigger`;
  const localBaselinePath = path.join(CFG.outputDir, `${slug}-same-process-baseline-framebuffer.png`);
  const localChangedPath = path.join(CFG.outputDir, `${slug}-same-process-changed-framebuffer.png`);
  const localLogPath = path.join(CFG.outputDir, `${slug}-same-process-run.log`);
  const runCommand = [
    `./${shQuote(CFG.targetName)}`,
    ...CFG.runtimeArgs.map(shQuote),
    `--width=${CFG.width}`,
    `--height=${CFG.height}`,
  ].join(' ');
  const script = `
set -e
cd ${shQuote(CFG.workerRepoPath)}
rm -f ${shQuote(workerBaselinePath)} ${shQuote(workerChangedPath)} ${shQuote(workerTriggerPath)}
export SYNTHI_HIPRT_DISABLE_GPU_TEXTURE_OBJECTS=1
export SYNTHI_HIPRT_DISABLE_OPENGL_INTEROP=1
export SYNTHI_HIPRT_RUNTIME_PROBE_CAPTURE_PATH=${shQuote(workerBaselinePath)}
export SYNTHI_HIPRT_RUNTIME_PROBE_SECOND_CAPTURE_PATH=${shQuote(workerChangedPath)}
export SYNTHI_HIPRT_RUNTIME_PROBE_RELOAD_TRIGGER_PATH=${shQuote(workerTriggerPath)}
export SYNTHI_HIPRT_RUNTIME_PROBE_RELOAD_TIMEOUT_MS=${CFG.reloadTimeoutMs}
export SYNTHI_HIPRT_RUNTIME_PROBE_PROOF_WIDTH=${CFG.width}
export SYNTHI_HIPRT_RUNTIME_PROBE_PROOF_HEIGHT=${CFG.height}
export SYNTHI_HIPRT_RUNTIME_PROBE_RELOAD_KERNEL_NAME=${shQuote(CFG.reloadKernelName)}
export SYNTHI_HIPRT_RUNTIME_PROBE_RELOAD_KERNEL_SYMBOL=${shQuote(CFG.reloadKernelSymbol)}
export SYNTHI_HIPRT_RUNTIME_PROBE_SAME_PROCESS=1
export SYNTHI_HIPRT_RUNTIME_PROBE_EXIT_AFTER_SECOND_CAPTURE=1
export LD_PRELOAD=${shQuote(CFG.nativeLaunchObserverPath)}\${LD_PRELOAD:+:\${LD_PRELOAD}}
export SYNTHI_GPU_NATIVE_LAUNCH_OBSERVER=observe_only
${hiprtRuntimeDisplaySetup()}
start=$(date +%s%3N)
cd build
set +e
${hiprtRuntimeRunInvocation(runCommand)}
status=$?
set -e
end=$(date +%s%3N)
printf 'SYNTHI_WARM_PROOF_TIMING variant=same-process run_ms=%s exit_code=%s baseline_capture_path=%s changed_capture_path=%s\\n' "$((end-start))" "$status" ${shQuote(workerBaselinePath)} ${shQuote(workerChangedPath)}
exit "$status"
`;
  const startedAt = Date.now();
  const run = spawnDockerShell(script, {
    timeout: CFG.runTimeoutMs,
    maxBuffer: 128 * 1024 * 1024,
  });
  let baselineReadyMs = null;
  let changedWrite = null;
  let triggerMs = null;
  try {
    baselineReadyMs = await waitForWorkerFile(workerBaselinePath, CFG.runTimeoutMs, run.completion);
    changedWrite = await writeVariantSource({ variant: 'same-process-changed', text: changedSource });
    const triggerStart = Date.now();
    await dockerShell(`date +%s%3N > ${shQuote(workerTriggerPath)}`, { timeout: 30000 });
    triggerMs = Date.now() - triggerStart;
    const result = await run.completion;
    await fs.mkdir(CFG.outputDir, { recursive: true });
    await fs.writeFile(localLogPath, result.output);
    await dockerShell(`test -s ${shQuote(workerChangedPath)}`, { timeout: 30000 });
    await dockerCpFromWorker(workerBaselinePath, localBaselinePath);
    await dockerCpFromWorker(workerChangedPath, localChangedPath);
    const timingMatch = /SYNTHI_WARM_PROOF_TIMING\s+variant=same-process\s+run_ms=(\d+)\s+exit_code=(\d+)/.exec(result.output);
    const recompileMatch = /same_process_recompile\s+result=success\b.*?\belapsed_ms=(\d+)/.exec(result.output);
    const waitMatch = /same_process_trigger_observed\s+trigger=\S+\s+wait_ms=(\d+)/.exec(result.output);
    const baselineRun = {
      variant: 'same-process-baseline',
      runMs: baselineReadyMs,
      hostWallMs: baselineReadyMs,
      exitCode: 0,
      workerCapturePath: workerBaselinePath,
      localCapturePath: localBaselinePath,
      localLogPath,
      captureLine: parseCaptureLine(result.output),
      nativeLaunchKernels: parseKernelSymbols(result.output),
      logSha256: `sha256:${sha256Hex(result.output)}`,
      sameProcess: true,
    };
    const changedRun = {
      variant: 'same-process-changed',
      runMs: timingMatch ? Number(timingMatch[1]) : result.hostWallMs,
      hostWallMs: result.hostWallMs,
      exitCode: timingMatch ? Number(timingMatch[2]) : 0,
      workerCapturePath: workerChangedPath,
      localCapturePath: localChangedPath,
      localLogPath,
      captureLine: result.output.split(/\r?\n/).find((line) =>
        line.includes('same_process_capture')
        && line.includes(`capture_path=${workerChangedPath}`)
        && line.includes('wrote=1')
      ) ?? '',
      nativeLaunchKernels: parseKernelSymbols(result.output),
      logSha256: `sha256:${sha256Hex(result.output)}`,
      sameProcess: true,
      liveRecompileMs: recompileMatch ? Number(recompileMatch[1]) : null,
      triggerWaitMs: waitMatch ? Number(waitMatch[1]) : null,
      triggerTouchMs: triggerMs,
      totalHostWallMs: Date.now() - startedAt,
    };
    return {
      baselineRun,
      changedRun,
      changedWrite,
      runLog: result.output,
    };
  } catch (err) {
    run.child.kill('SIGTERM');
    throw err;
  }
}

async function imageStats(filePath) {
  const image = sharp(filePath).ensureAlpha();
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
  let visiblePixels = 0;
  let lumaSum = 0;
  let lumaSqSum = 0;
  const colorSample = new Set();
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    if (r > 4 || g > 4 || b > 4) visiblePixels++;
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    lumaSum += luma;
    lumaSqSum += luma * luma;
    if (colorSample.size < 20000) {
      colorSample.add(`${r},${g},${b}`);
    }
  }
  const pixels = info.width * info.height;
  const meanLuma = pixels > 0 ? lumaSum / pixels : 0;
  const variance = pixels > 0 ? Math.max(0, (lumaSqSum / pixels) - meanLuma * meanLuma) : 0;
  const bytes = await fs.readFile(filePath);
  return {
    path: filePath,
    contentHash: `sha256:${sha256Hex(bytes)}`,
    width: info.width,
    height: info.height,
    visiblePixels,
    meanLuma8bit: meanLuma,
    lumaStddev8bit: Math.sqrt(variance),
    uniqueColorSampleCount: colorSample.size,
    acceptedAsVisualEvidence: pixels > 0 && visiblePixels > 1000 && colorSample.size >= 64,
  };
}

async function diffImages({ baselinePath, changedPath, diffPath }) {
  const baseline = await sharp(baselinePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const changed = await sharp(changedPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (baseline.info.width !== changed.info.width || baseline.info.height !== changed.info.height) {
    throw new Error(
      `image dimensions differ: baseline=${baseline.info.width}x${baseline.info.height} changed=${changed.info.width}x${changed.info.height}`,
    );
  }
  const pixels = baseline.info.width * baseline.info.height;
  const out = Buffer.alloc(pixels * 4);
  let changedPixelsThreshold4 = 0;
  let deltaSum = 0;
  let maxChannelDelta8bit = 0;
  for (let i = 0; i < pixels; i++) {
    const offset = i * 4;
    const dr = Math.abs(baseline.data[offset] - changed.data[offset]);
    const dg = Math.abs(baseline.data[offset + 1] - changed.data[offset + 1]);
    const db = Math.abs(baseline.data[offset + 2] - changed.data[offset + 2]);
    const maxDelta = Math.max(dr, dg, db);
    if (maxDelta > 4) changedPixelsThreshold4++;
    deltaSum += dr + dg + db;
    maxChannelDelta8bit = Math.max(maxChannelDelta8bit, maxDelta);
    out[offset] = Math.min(255, dr * 6);
    out[offset + 1] = Math.min(255, dg * 6);
    out[offset + 2] = Math.min(255, db * 6);
    out[offset + 3] = 255;
  }
  await sharp(out, {
    raw: {
      width: baseline.info.width,
      height: baseline.info.height,
      channels: 4,
    },
  }).png().toFile(diffPath);
  const diffBytes = await fs.readFile(diffPath);
  return {
    path: diffPath,
    contentHash: `sha256:${sha256Hex(diffBytes)}`,
    changedPixelsThreshold4,
    changedPixelRatioThreshold4: pixels > 0 ? changedPixelsThreshold4 / pixels : 0,
    meanAbsDelta8bit: pixels > 0 ? deltaSum / (pixels * 3) : 0,
    maxChannelDelta8bit,
  };
}

async function findStrictProofJson() {
  if (CFG.strictProofJson) {
    const filePath = path.resolve(REPO_ROOT, CFG.strictProofJson);
    return { path: filePath, proof: JSON.parse(await fs.readFile(filePath, 'utf8')) };
  }
  const legacyProofDir = path.join(ARTIFACT_ROOT, 'hiprt-light-math-proof');
  let entries = [];
  try {
    entries = await fs.readdir(legacyProofDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('-proof.json')) continue;
    const filePath = path.join(legacyProofDir, entry.name);
    try {
      const stat = await fs.stat(filePath);
      const proof = JSON.parse(await fs.readFile(filePath, 'utf8'));
      if (proof?.hmr?.strictFullRuntimePassed === true || proof?.hmr?.fullRuntimeProven === true) {
        candidates.push({ path: filePath, proof, mtimeMs: stat.mtimeMs });
      }
    } catch {
      // Ignore malformed old artifacts; the proof gate below will fail if no valid one remains.
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0] ?? null;
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function findReusableBaselineProof({ repoCommit, source }) {
  if (!CFG.reuseBaseline) return null;
  let entries = [];
  try {
    entries = await fs.readdir(CFG.outputDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('-proof.json')) continue;
    const filePath = path.join(CFG.outputDir, entry.name);
    try {
      const stat = await fs.stat(filePath);
      const proof = JSON.parse(await fs.readFile(filePath, 'utf8'));
      const baselinePath = proof?.baseline?.path;
      if (
        proof?.accepted === true
        && proof?.repo?.commit === repoCommit
        && proof?.repo?.target === CFG.targetName
        && proof?.dimensions?.width === CFG.width
        && proof?.dimensions?.height === CFG.height
        && proof?.source?.file === source.file
        && proof?.source?.baselineHash === source.baselineHash
        && typeof baselinePath === 'string'
        && await fileExists(baselinePath)
      ) {
        candidates.push({ path: filePath, proof, mtimeMs: stat.mtimeMs });
      }
    } catch {
      // Reuse is opportunistic; malformed cache entries are ignored.
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0] ?? null;
}

function requiredKernelsPresent(kernels) {
  return CFG.requiredKernels.every((kernel) => kernels.includes(kernel));
}

function summarizeStrictProof(strict) {
  if (!strict) return null;
  return {
    path: strict.path,
    schemaVersion: strict.proof?.schemaVersion ?? null,
    slug: strict.proof?.slug ?? null,
    fullRuntimeProven: strict.proof?.hmr?.fullRuntimeProven === true,
    strictFullRuntimePassed: strict.proof?.hmr?.strictFullRuntimePassed === true,
    runtimeProof: strict.proof?.hmr?.runtimeProof ?? null,
    hmrMathDelta: strict.proof?.hmr?.mathDelta ?? null,
  };
}

async function main() {
  const totalStartedAt = Date.now();
  await fs.mkdir(CFG.outputDir, { recursive: true });
  const strictProof = await findStrictProofJson();
  const strictSummary = summarizeStrictProof(strictProof);
  if (CFG.requireStrictProvenance && !strictSummary?.strictFullRuntimePassed) {
    throw new Error('strict full-runtime HMR provenance is required but no accepted prior proof JSON was found');
  }

  const preflightResult = await preflight();
  const baselineSource = await readBaselineSourceFromGit();
  const beforeCount = countOccurrences(baselineSource, CFG.before);
  const afterCountInBaseline = countOccurrences(baselineSource, CFG.after);
  if (beforeCount !== 1) {
    throw new Error(`source anchor must occur exactly once in git baseline; found ${beforeCount}`);
  }
  if (afterCountInBaseline !== 0) {
    throw new Error(`patched expression unexpectedly appears in git baseline; found ${afterCountInBaseline}`);
  }
  const changedSource = baselineSource.replace(CFG.before, CFG.after);
  const source = {
    file: CFG.sourceRel,
    before: CFG.before,
    after: CFG.after,
    baselineHash: `sha256:${sha256Hex(baselineSource)}`,
    changedHash: `sha256:${sha256Hex(changedSource)}`,
  };

  let sameProcessAdapter = null;
  let sameProcessBuild = null;
  let reusableBaseline = null;
  let baselineWrite;
  let baselineRun;
  let changedWrite;
  let changedRun;
  let restoreWrite;
  if (CFG.mode === 'same-process') {
    sameProcessAdapter = await applySameProcessAdapter();
    sameProcessBuild = await buildHiprtTarget('same-process-adapter');
    baselineWrite = await writeVariantSource({ variant: 'baseline', text: baselineSource });
    try {
      const sameProcessRun = await runHiprtSameProcess({ changedSource });
      baselineRun = sameProcessRun.baselineRun;
      changedWrite = sameProcessRun.changedWrite;
      changedRun = sameProcessRun.changedRun;
      restoreWrite = await writeVariantSource({ variant: 'restored-baseline', text: baselineSource });
    } catch (err) {
      restoreWrite = await writeVariantSource({ variant: 'restored-baseline-after-failure', text: baselineSource });
      await refreshWorkerSourceIndex();
      throw err;
    }
  } else {
    reusableBaseline = await findReusableBaselineProof({
      repoCommit: preflightResult.repoCommit,
      source,
    });
    if (reusableBaseline) {
      baselineWrite = {
        reused: true,
        reusedFromProofPath: reusableBaseline.path,
        contentHash: source.baselineHash,
        workerSha256: source.baselineHash,
      };
      baselineRun = {
        ...reusableBaseline.proof.runtime.baseline,
        variant: 'baseline',
        reused: true,
        reusedFromProofPath: reusableBaseline.path,
        runMs: 0,
        hostWallMs: 0,
        localCapturePath: reusableBaseline.proof.baseline.path,
      };
    } else {
      baselineWrite = await writeVariantSource({ variant: 'baseline', text: baselineSource });
      baselineRun = await runHiprtVariant('baseline');
    }
    changedWrite = await writeVariantSource({ variant: 'changed', text: changedSource });
    changedRun = await runHiprtVariant('changed');
    restoreWrite = await writeVariantSource({ variant: 'restored-baseline', text: baselineSource });
  }
  await refreshWorkerSourceIndex();

  const baselineStats = await imageStats(baselineRun.localCapturePath);
  const changedStats = await imageStats(changedRun.localCapturePath);
  const diffPath = path.join(CFG.outputDir, `${cleanIdentifier(CFG.slug)}-diff-amplified.png`);
  const diff = await diffImages({
    baselinePath: baselineRun.localCapturePath,
    changedPath: changedRun.localCapturePath,
    diffPath,
  });

  const acceptance = {
    strictProvenance: !CFG.requireStrictProvenance || strictSummary?.strictFullRuntimePassed === true,
    sourceHashesDiffer: source.baselineHash !== source.changedHash,
    baselineCopiedToWorker: baselineWrite.contentHash === baselineWrite.workerSha256,
    changedCopiedToWorker: changedWrite.contentHash === changedWrite.workerSha256,
    restoredBaselineInWorker: restoreWrite.contentHash === restoreWrite.workerSha256,
    baselineCapture: Boolean(baselineRun.captureLine) && baselineStats.acceptedAsVisualEvidence,
    changedCapture: Boolean(changedRun.captureLine) && changedStats.acceptedAsVisualEvidence,
    baselineNativeKernels: requiredKernelsPresent(baselineRun.nativeLaunchKernels),
    changedNativeKernels: requiredKernelsPresent(changedRun.nativeLaunchKernels),
    sameProcessRuntime:
      CFG.mode !== 'same-process'
      || (
        changedRun.sameProcess === true
        && Number.isFinite(changedRun.liveRecompileMs)
        && Boolean(changedRun.captureLine)
      ),
    visualDelta:
      diff.changedPixelRatioThreshold4 >= CFG.minChangedPixelRatio
      && diff.meanAbsDelta8bit >= CFG.minMeanAbsDelta8bit,
  };
  const accepted = Object.values(acceptance).every(Boolean);
  const proof = {
    schemaVersion: 'synthi.hiprt.warm_visual_proof.v2',
    slug: CFG.slug,
    createdAt: new Date().toISOString(),
    mode: CFG.mode,
    profile: {
      id: CFG.profileId,
      requiredKernels: CFG.requiredKernels,
      reloadKernelName: CFG.reloadKernelName,
      reloadKernelSymbol: CFG.reloadKernelSymbol,
    },
    runtimeProfile: CFG.runtimeProfile,
    claim: CFG.claim,
    repo: {
      workerContainer: CFG.workerContainer,
      workerRepoPath: CFG.workerRepoPath,
      commit: preflightResult.repoCommit,
      target: CFG.targetName,
    },
    dimensions: { width: CFG.width, height: CFG.height },
    runtimeLimits: {
      runTimeoutMs: CFG.runTimeoutMs,
      runTimeoutUnbounded: CFG.runTimeoutMs === 0,
      reloadTimeoutMs: CFG.reloadTimeoutMs,
      reloadTimeoutUnbounded: CFG.reloadTimeoutMs === 0,
      buildTimeoutMs: CFG.buildTimeoutMs,
    },
    source,
    sourceWrites: {
      baseline: baselineWrite,
      changed: changedWrite,
      restoredBaseline: restoreWrite,
    },
    baselineReuse: reusableBaseline
      ? {
          reused: true,
          proofPath: reusableBaseline.path,
          proofId: reusableBaseline.proof.proofId ?? null,
          baselineContentHash: reusableBaseline.proof.baseline?.contentHash ?? null,
        }
      : { reused: false },
    sameProcessAdapter,
    sameProcessBuild,
    strictHmrProvenance: strictSummary,
    runtime: {
      baseline: baselineRun,
      changed: changedRun,
    },
    baseline: baselineStats,
    changed: changedStats,
    diff,
    thresholds: {
      minChangedPixelRatio: CFG.minChangedPixelRatio,
      minMeanAbsDelta8bit: CFG.minMeanAbsDelta8bit,
    },
    timings: {
      totalWallMs: Date.now() - totalStartedAt,
      mode: CFG.mode,
      baselineReused: Boolean(reusableBaseline),
      sameProcessLiveRecompileMs: changedRun.liveRecompileMs ?? null,
      sameProcessTriggerWaitMs: changedRun.triggerWaitMs ?? null,
      sameProcessAdapterBuildMs: sameProcessBuild?.buildMs ?? null,
      baselineRunMs: baselineRun.runMs,
      baselineHostWallMs: baselineRun.hostWallMs,
      changedRunMs: changedRun.runMs,
      changedHostWallMs: changedRun.hostWallMs,
    },
    acceptance,
    accepted,
  };
  const proofBytesForId = Buffer.from(JSON.stringify({
    schemaVersion: proof.schemaVersion,
    slug: proof.slug,
    mode: proof.mode,
    profile: proof.profile,
    repo: proof.repo,
    source: proof.source,
    strictHmrProvenance: proof.strictHmrProvenance,
    baselineHash: proof.baseline.contentHash,
    changedHash: proof.changed.contentHash,
    diffHash: proof.diff.contentHash,
    timings: proof.timings,
    acceptance: proof.acceptance,
    accepted: proof.accepted,
  }));
  proof.proofId = `hiprt-warm-runtime-proof:sha256:${sha256Hex(proofBytesForId)}`;
  const proofPath = path.join(CFG.outputDir, `${cleanIdentifier(CFG.slug)}-proof.json`);
  await fs.writeFile(proofPath, `${JSON.stringify(proof, null, 2)}\n`);
  console.log(JSON.stringify({
    accepted,
    proofId: proof.proofId,
    proofPath,
    mode: CFG.mode,
    profileId: CFG.profileId,
    baseline: baselineStats.path,
    changed: changedStats.path,
    diff: diff.path,
    timings: proof.timings,
    diffStats: {
      changedPixelRatioThreshold4: diff.changedPixelRatioThreshold4,
      meanAbsDelta8bit: diff.meanAbsDelta8bit,
      maxChannelDelta8bit: diff.maxChannelDelta8bit,
    },
    baselineReused: Boolean(reusableBaseline),
    sameProcess: {
      enabled: CFG.mode === 'same-process',
      liveRecompileMs: changedRun.liveRecompileMs ?? null,
      adapterBuildMs: sameProcessBuild?.buildMs ?? null,
    },
    kernels: {
      baseline: baselineRun.nativeLaunchKernels.filter((kernel) =>
        [...CFG.requiredKernels, 'GMoNComputeMedianOfMeans'].includes(kernel),
      ),
      changed: changedRun.nativeLaunchKernels.filter((kernel) =>
        [...CFG.requiredKernels, 'GMoNComputeMedianOfMeans'].includes(kernel),
      ),
    },
  }, null, 2));
  if (!accepted && !CFG.allowRejected) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err?.stack ?? err?.message ?? String(err));
  if (err?.output) {
    console.error(String(err.output).slice(-8000));
  }
  process.exitCode = 1;
});
