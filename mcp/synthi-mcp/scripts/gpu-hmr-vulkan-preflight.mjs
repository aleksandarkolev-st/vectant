#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../..');
const ARTIFACT_DIR = path.join(REPO_ROOT, 'mcp/synthi-mcp/.gpu-hmr-test-artifacts/vulkan-preflight');
const SCHEMA = 'synthi.gpu_hmr.vulkan_preflight.v1';

function nowSlugDate() {
  return new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
}

const CFG = {
  workerContainer: process.env.SYNTHI_VULKAN_WORKER_CONTAINER
    ?? process.env.WORKER_CONTAINER
    ?? 'vectant-ade-worker-1',
  slug: process.env.SLUG ?? `vulkan-rocm-preflight-${nowSlugDate()}`,
  seed: process.env.SYNTHI_VULKAN_PREFLIGHT_SEED ?? '12345',
};

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256Text(value) {
  return `sha256:${createHash('sha256').update(String(value)).digest('hex')}`;
}

function execDockerShell(container, script, timeoutMs = 30000) {
  const started = performance.now();
  return new Promise((resolve) => {
    execFile(
      'docker',
      ['exec', '-w', '/tmp', container, 'sh', '-lc', script],
      { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          exitCode: Number.isInteger(error?.code) ? error.code : 0,
          signal: error?.signal ?? null,
          durationMs: Number((performance.now() - started).toFixed(3)),
          timedOut: Boolean(error?.killed && error?.signal === 'SIGTERM'),
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          stdoutTail: String(stdout ?? '').slice(-4000),
          stderrTail: String(stderr ?? '').slice(-4000),
        });
      },
    );
  });
}

function parseLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function parseVulkanLibraries(text) {
  return parseLines(text)
    .filter((line) => /libvulkan\.so/i.test(line));
}

function parseIcdFiles(text) {
  if (/^no_vulkan_icds$/m.test(text)) return [];
  return parseLines(text)
    .filter((line) => /\/vulkan\/icd\.d\/.+\.json$/i.test(line));
}

function parseIcdLibraries(text) {
  const libraries = new Set();
  for (const match of String(text || '').matchAll(/"library_path"\s*:\s*"([^"]+)"/gi)) {
    libraries.add(match[1].trim());
  }
  return [...libraries].filter(Boolean).sort();
}

function parseVulkanInfoSummary(text) {
  const deviceNames = new Set();
  for (const match of String(text || '').matchAll(/\bdeviceName\s*=\s*(.+)$/gim)) {
    const name = match[1].trim();
    if (name) deviceNames.add(name);
  }
  for (const match of String(text || '').matchAll(/^GPU\d+\s*:\s*(.+)$/gim)) {
    const name = match[1].trim();
    if (name) deviceNames.add(name);
  }
  const apiVersionMatch = String(text || '').match(/\bapiVersion\s*=\s*(.+)$/im);
  return {
    apiVersion: apiVersionMatch ? apiVersionMatch[1].trim() : null,
    deviceNames: [...deviceNames].sort(),
    physicalDeviceCount: deviceNames.size,
  };
}

function classifyVulkanPreflight({ libraries, icdFiles, vulkaninfoProbe, vulkaninfoSummary }) {
  const unsupportedReasons = [];
  if (!libraries.length) unsupportedReasons.push('vulkan_loader_missing');
  if (!icdFiles.length) unsupportedReasons.push('vulkan_icd_missing');
  if (vulkaninfoProbe.present !== true) unsupportedReasons.push('vulkaninfo_missing');
  if (vulkaninfoProbe.present === true && vulkaninfoProbe.exitCode !== 0) {
    unsupportedReasons.push('vulkaninfo_failed');
  }
  if (
    vulkaninfoProbe.present === true
    && vulkaninfoProbe.exitCode === 0
    && !(Number(vulkaninfoSummary.physicalDeviceCount) > 0)
  ) {
    unsupportedReasons.push('vulkan_physical_device_missing');
  }
  return {
    vulkanAccepted: unsupportedReasons.length === 0,
    resultState: unsupportedReasons.length === 0
      ? 'vulkan-runtime-preflight-accepted'
      : 'vulkan-runtime-rejected',
    unsupportedReasons,
  };
}

async function buildProof() {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const libraryProbe = await execDockerShell(
    CFG.workerContainer,
    "ldconfig -p 2>/dev/null | grep -i 'libvulkan\\.so' || find /usr /lib /opt -name 'libvulkan.so*' 2>/dev/null | head -20",
  );
  const icdProbe = await execDockerShell(
    CFG.workerContainer,
    "if [ -d /etc/vulkan/icd.d ]; then find /etc/vulkan/icd.d -maxdepth 1 -type f -name '*.json' -print -exec cat {} \\; 2>/dev/null || true; else echo no_vulkan_icds; fi",
  );
  const vulkaninfoPathProbe = await execDockerShell(
    CFG.workerContainer,
    'command -v vulkaninfo || true',
  );
  const vulkaninfoPath = parseLines(vulkaninfoPathProbe.stdout)[0] ?? '';
  const vulkaninfoProbe = vulkaninfoPath
    ? await execDockerShell(CFG.workerContainer, 'vulkaninfo --summary 2>&1', 60000)
    : {
      exitCode: null,
      signal: null,
      durationMs: 0,
      timedOut: false,
      stdout: '',
      stderr: '',
      stdoutTail: '',
      stderrTail: '',
    };
  const libraries = parseVulkanLibraries(libraryProbe.stdout);
  const icdFiles = parseIcdFiles(icdProbe.stdout);
  const icdLibraries = parseIcdLibraries(icdProbe.stdout);
  const vulkaninfoSummary = parseVulkanInfoSummary(`${vulkaninfoProbe.stdout}\n${vulkaninfoProbe.stderr}`);
  const vulkaninfoPresence = {
    present: Boolean(vulkaninfoPath),
    path: vulkaninfoPath || null,
    exitCode: vulkaninfoPath ? vulkaninfoProbe.exitCode : null,
  };
  const classification = classifyVulkanPreflight({
    libraries,
    icdFiles,
    vulkaninfoProbe: vulkaninfoPresence,
    vulkaninfoSummary,
  });
  const proof = {
    schema: SCHEMA,
    slug: CFG.slug,
    startedAt,
    completedAt: new Date().toISOString(),
    durationMs: Number((performance.now() - started).toFixed(3)),
    workerContainer: CFG.workerContainer,
    seed: CFG.seed,
    loaderProbe: {
      command: 'ldconfig/find libvulkan.so',
      result: {
        exitCode: libraryProbe.exitCode,
        signal: libraryProbe.signal,
        durationMs: libraryProbe.durationMs,
        timedOut: libraryProbe.timedOut,
        stdoutTail: libraryProbe.stdoutTail,
        stderrTail: libraryProbe.stderrTail,
      },
      libraries,
    },
    icdProbe: {
      command: 'find /etc/vulkan/icd.d',
      result: {
        exitCode: icdProbe.exitCode,
        signal: icdProbe.signal,
        durationMs: icdProbe.durationMs,
        timedOut: icdProbe.timedOut,
        stdoutTail: icdProbe.stdoutTail,
        stderrTail: icdProbe.stderrTail,
      },
      icdFiles,
      icdLibraries,
    },
    vulkaninfoProbe: {
      present: vulkaninfoPresence.present,
      path: vulkaninfoPresence.path,
      result: {
        exitCode: vulkaninfoProbe.exitCode,
        signal: vulkaninfoProbe.signal,
        durationMs: vulkaninfoProbe.durationMs,
        timedOut: vulkaninfoProbe.timedOut,
        stdoutTail: vulkaninfoProbe.stdoutTail,
        stderrTail: vulkaninfoProbe.stderrTail,
      },
      summary: vulkaninfoSummary,
    },
    classification: {
      vulkanAccepted: classification.vulkanAccepted,
      resultState: classification.resultState,
      unsupportedReasons: classification.unsupportedReasons,
      libraries,
      icdFiles,
      icdLibraries,
      apiVersion: vulkaninfoSummary.apiVersion,
      physicalDeviceCount: vulkaninfoSummary.physicalDeviceCount,
      deviceNames: vulkaninfoSummary.deviceNames,
    },
    acceptance: {
      acceptedForVulkanRuntimePreflight: classification.vulkanAccepted,
      acceptedForVulkanPipelineProof: false,
      gpuHmrSuccess: false,
      reason: classification.vulkanAccepted
        ? 'preflight_only_pipeline_command_buffer_and_frame_oracle_still_required'
        : 'runtime_preflight_rejected',
      requiresVulkanIcd: true,
      requiresPhysicalDevice: true,
      pipelineLayoutProofRequired: true,
      commandBufferTraceRequired: true,
      frameOutputOracleRequired: true,
      noShimApplied: true,
      noIcdSynthesized: true,
      noSymlinkApplied: true,
    },
  };
  proof.proofId = `vulkan-preflight-proof:${sha256Text(canonicalJson(proof))}`;
  return proof;
}

async function writeProof(proof) {
  await mkdir(ARTIFACT_DIR, { recursive: true });
  const safeSlug = CFG.slug.replace(/[^a-zA-Z0-9_.-]+/g, '-');
  const proofPath = path.join(ARTIFACT_DIR, `${safeSlug}-proof.json`);
  const summaryPath = path.join(ARTIFACT_DIR, `${safeSlug}-summary.txt`);
  await writeFile(proofPath, `${JSON.stringify(proof, null, 2)}\n`);
  await writeFile(summaryPath, [
    `proof_id=${proof.proofId}`,
    `result_state=${proof.classification.resultState}`,
    `vulkan_accepted=${proof.classification.vulkanAccepted}`,
    `libraries=${proof.classification.libraries.join(',') || 'none'}`,
    `icd_files=${proof.classification.icdFiles.join(',') || 'none'}`,
    `icd_libraries=${proof.classification.icdLibraries.join(',') || 'none'}`,
    `api_version=${proof.classification.apiVersion ?? 'unknown'}`,
    `physical_device_count=${proof.classification.physicalDeviceCount}`,
    `device_names=${proof.classification.deviceNames.join(',') || 'none'}`,
    `unsupported_reasons=${proof.classification.unsupportedReasons.join(',') || 'none'}`,
    `no_shim_applied=${proof.acceptance.noShimApplied}`,
    `no_icd_synthesized=${proof.acceptance.noIcdSynthesized}`,
    `no_symlink_applied=${proof.acceptance.noSymlinkApplied}`,
    '',
  ].join('\n'));
  return { proofPath, summaryPath };
}

function selfCheck() {
  const accepted = classifyVulkanPreflight({
    libraries: ['libvulkan.so.1 => /lib/libvulkan.so.1'],
    icdFiles: ['/etc/vulkan/icd.d/radeon_icd.x86_64.json'],
    vulkaninfoProbe: { present: true, exitCode: 0 },
    vulkaninfoSummary: { physicalDeviceCount: 1, deviceNames: ['AMD Radeon'], apiVersion: '1.3' },
  });
  const rejectedNoIcd = classifyVulkanPreflight({
    libraries: ['libvulkan.so.1 => /lib/libvulkan.so.1'],
    icdFiles: [],
    vulkaninfoProbe: { present: false, exitCode: null },
    vulkaninfoSummary: { physicalDeviceCount: 0, deviceNames: [], apiVersion: null },
  });
  const rejectedNoDevice = classifyVulkanPreflight({
    libraries: ['libvulkan.so.1 => /lib/libvulkan.so.1'],
    icdFiles: ['/etc/vulkan/icd.d/vendor.json'],
    vulkaninfoProbe: { present: true, exitCode: 0 },
    vulkaninfoSummary: { physicalDeviceCount: 0, deviceNames: [], apiVersion: '1.3' },
  });
  if (!accepted.vulkanAccepted || accepted.resultState !== 'vulkan-runtime-preflight-accepted') {
    throw new Error('Vulkan preflight self-check failed accepted case');
  }
  if (
    rejectedNoIcd.vulkanAccepted
    || !rejectedNoIcd.unsupportedReasons.includes('vulkan_icd_missing')
    || !rejectedNoIcd.unsupportedReasons.includes('vulkaninfo_missing')
  ) {
    throw new Error('Vulkan preflight self-check failed missing ICD case');
  }
  if (
    rejectedNoDevice.vulkanAccepted
    || !rejectedNoDevice.unsupportedReasons.includes('vulkan_physical_device_missing')
  ) {
    throw new Error('Vulkan preflight self-check failed missing device case');
  }
  console.log('[ok] Vulkan preflight self-check passed');
}

if (process.argv.includes('--self-check')) {
  try {
    selfCheck();
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
} else {
  try {
    const proof = await buildProof();
    const { proofPath, summaryPath } = await writeProof(proof);
    console.log(`proof_id=${proof.proofId}`);
    console.log(`result_state=${proof.classification.resultState}`);
    console.log(`vulkan_accepted=${proof.classification.vulkanAccepted}`);
    console.log(`proof_json=${proofPath}`);
    console.log(`summary_txt=${summaryPath}`);
    if (!proof.classification.vulkanAccepted) {
      console.log(`unsupported_reasons=${proof.classification.unsupportedReasons.join(',')}`);
    }
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}
