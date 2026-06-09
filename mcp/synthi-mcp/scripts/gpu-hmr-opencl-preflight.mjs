#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../..');
const ARTIFACT_DIR = path.join(REPO_ROOT, 'mcp/synthi-mcp/.gpu-hmr-test-artifacts/opencl-preflight');
const SCHEMA = 'synthi.gpu_hmr.opencl_preflight.v1';

function nowSlugDate() {
  return new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
}

const CFG = {
  workerContainer: process.env.SYNTHI_OPENCL_WORKER_CONTAINER
    ?? process.env.WORKER_CONTAINER
    ?? 'vectant-ade-worker-1',
  slug: process.env.SLUG ?? `opencl-rocm-preflight-${nowSlugDate()}`,
  seed: process.env.SYNTHI_OPENCL_PREFLIGHT_SEED ?? '12345',
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
      ['exec', container, 'sh', '-lc', script],
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
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

function parseOpenClLibraries(text) {
  return parseLines(text)
    .filter((line) => /libOpenCL\.so/i.test(line));
}

function parseVendorIcds(text) {
  if (/^no_opencl_vendors$/m.test(text)) return [];
  return parseLines(text)
    .filter((line) => /\.icd(?:\s|$)|\.so(?:\.\d+)*$/i.test(line));
}

function parseClinfoSummary(text) {
  const platformMatch = String(text || '').match(/Number of platforms\s+(\d+)/i);
  const deviceMatches = [...String(text || '').matchAll(/Number of devices\s+(\d+)/gi)];
  return {
    platformCount: platformMatch ? Number(platformMatch[1]) : null,
    deviceCounts: deviceMatches.map((match) => Number(match[1])).filter(Number.isFinite),
  };
}

function classifyOpenClPreflight({ libraries, vendorIcds, clinfoProbe, clinfoSummary }) {
  const unsupportedReasons = [];
  if (!libraries.length) unsupportedReasons.push('opencl_loader_missing');
  if (!vendorIcds.length) unsupportedReasons.push('opencl_vendor_icd_missing');
  if (clinfoProbe.present !== true) unsupportedReasons.push('clinfo_missing');
  if (clinfoProbe.present === true && clinfoProbe.exitCode !== 0) {
    unsupportedReasons.push('clinfo_failed');
  }
  if (
    clinfoProbe.present === true
    && clinfoProbe.exitCode === 0
    && !(Number(clinfoSummary.platformCount) > 0)
  ) {
    unsupportedReasons.push('opencl_platform_missing');
  }
  if (
    clinfoProbe.present === true
    && clinfoProbe.exitCode === 0
    && !clinfoSummary.deviceCounts.some((count) => count > 0)
  ) {
    unsupportedReasons.push('opencl_device_missing');
  }
  return {
    openclAccepted: unsupportedReasons.length === 0,
    resultState: unsupportedReasons.length === 0
      ? 'opencl-runtime-preflight-accepted'
      : 'opencl-runtime-rejected',
    unsupportedReasons,
  };
}

async function buildProof() {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const libraryProbe = await execDockerShell(
    CFG.workerContainer,
    "ldconfig -p 2>/dev/null | grep -i 'libOpenCL\\.so' || find /opt/rocm /usr /lib -name 'libOpenCL.so*' 2>/dev/null | head -20",
  );
  const vendorProbe = await execDockerShell(
    CFG.workerContainer,
    "if [ -d /etc/OpenCL/vendors ]; then find /etc/OpenCL/vendors -maxdepth 1 -type f -print -exec cat {} \\; 2>/dev/null; else echo no_opencl_vendors; fi",
  );
  const clinfoPathProbe = await execDockerShell(
    CFG.workerContainer,
    'command -v clinfo || true',
  );
  const clinfoPath = parseLines(clinfoPathProbe.stdout)[0] ?? '';
  const clinfoProbe = clinfoPath
    ? await execDockerShell(CFG.workerContainer, 'clinfo 2>&1', 60000)
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
  const libraries = parseOpenClLibraries(libraryProbe.stdout);
  const vendorIcds = parseVendorIcds(vendorProbe.stdout);
  const clinfoSummary = parseClinfoSummary(`${clinfoProbe.stdout}\n${clinfoProbe.stderr}`);
  const clinfoPresence = {
    present: Boolean(clinfoPath),
    path: clinfoPath || null,
    exitCode: clinfoPath ? clinfoProbe.exitCode : null,
  };
  const classification = classifyOpenClPreflight({
    libraries,
    vendorIcds,
    clinfoProbe: clinfoPresence,
    clinfoSummary,
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
      command: "ldconfig/find libOpenCL.so",
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
    vendorIcdProbe: {
      command: 'find /etc/OpenCL/vendors',
      result: {
        exitCode: vendorProbe.exitCode,
        signal: vendorProbe.signal,
        durationMs: vendorProbe.durationMs,
        timedOut: vendorProbe.timedOut,
        stdoutTail: vendorProbe.stdoutTail,
        stderrTail: vendorProbe.stderrTail,
      },
      vendorIcds,
    },
    clinfoProbe: {
      present: clinfoPresence.present,
      path: clinfoPresence.path,
      result: {
        exitCode: clinfoProbe.exitCode,
        signal: clinfoProbe.signal,
        durationMs: clinfoProbe.durationMs,
        timedOut: clinfoProbe.timedOut,
        stdoutTail: clinfoProbe.stdoutTail,
        stderrTail: clinfoProbe.stderrTail,
      },
      summary: clinfoSummary,
    },
    classification: {
      openclAccepted: classification.openclAccepted,
      resultState: classification.resultState,
      unsupportedReasons: classification.unsupportedReasons,
      libraries,
      vendorIcds,
      platformCount: clinfoSummary.platformCount,
      deviceCounts: clinfoSummary.deviceCounts,
    },
    acceptance: {
      acceptedForOpenClRuntimePreflight: classification.openclAccepted,
      acceptedForOpenClOutputProof: false,
      gpuHmrSuccess: false,
      reason: classification.openclAccepted
        ? 'preflight_only_dispatch_and_output_oracle_still_required'
        : 'runtime_preflight_rejected',
      requiresVendorIcd: true,
      requiresOpenClDevice: true,
      dispatchTraceRequired: true,
      outputOracleRequired: true,
      noShimApplied: true,
      noVendorIcdSynthesized: true,
      noSymlinkApplied: true,
    },
  };
  proof.proofId = `opencl-preflight-proof:${sha256Text(canonicalJson(proof))}`;
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
    `opencl_accepted=${proof.classification.openclAccepted}`,
    `libraries=${proof.classification.libraries.join(',') || 'none'}`,
    `vendor_icds=${proof.classification.vendorIcds.join(',') || 'none'}`,
    `platform_count=${proof.classification.platformCount ?? 'unknown'}`,
    `device_counts=${proof.classification.deviceCounts.join(',') || 'none'}`,
    `unsupported_reasons=${proof.classification.unsupportedReasons.join(',') || 'none'}`,
    `no_shim_applied=${proof.acceptance.noShimApplied}`,
    `no_vendor_icd_synthesized=${proof.acceptance.noVendorIcdSynthesized}`,
    `no_symlink_applied=${proof.acceptance.noSymlinkApplied}`,
    '',
  ].join('\n'));
  return { proofPath, summaryPath };
}

function selfCheck() {
  const accepted = classifyOpenClPreflight({
    libraries: ['libOpenCL.so.1 => /lib/libOpenCL.so.1'],
    vendorIcds: ['/etc/OpenCL/vendors/amdocl64.icd', '/opt/rocm/lib/libamdocl64.so'],
    clinfoProbe: { present: true, exitCode: 0 },
    clinfoSummary: { platformCount: 1, deviceCounts: [1] },
  });
  const rejectedNoVendor = classifyOpenClPreflight({
    libraries: ['libOpenCL.so.1 => /lib/libOpenCL.so.1'],
    vendorIcds: [],
    clinfoProbe: { present: false, exitCode: null },
    clinfoSummary: { platformCount: null, deviceCounts: [] },
  });
  const rejectedNoDevice = classifyOpenClPreflight({
    libraries: ['libOpenCL.so.1 => /lib/libOpenCL.so.1'],
    vendorIcds: ['/etc/OpenCL/vendors/vendor.icd'],
    clinfoProbe: { present: true, exitCode: 0 },
    clinfoSummary: { platformCount: 1, deviceCounts: [0] },
  });
  if (!accepted.openclAccepted || accepted.resultState !== 'opencl-runtime-preflight-accepted') {
    throw new Error('OpenCL preflight self-check failed accepted case');
  }
  if (
    rejectedNoVendor.openclAccepted
    || !rejectedNoVendor.unsupportedReasons.includes('opencl_vendor_icd_missing')
    || !rejectedNoVendor.unsupportedReasons.includes('clinfo_missing')
  ) {
    throw new Error('OpenCL preflight self-check failed missing vendor case');
  }
  if (
    rejectedNoDevice.openclAccepted
    || !rejectedNoDevice.unsupportedReasons.includes('opencl_device_missing')
  ) {
    throw new Error('OpenCL preflight self-check failed missing device case');
  }
  console.log('[ok] OpenCL preflight self-check passed');
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
    console.log(`opencl_accepted=${proof.classification.openclAccepted}`);
    console.log(`proof_json=${proofPath}`);
    console.log(`summary_txt=${summaryPath}`);
    if (!proof.classification.openclAccepted) {
      console.log(`unsupported_reasons=${proof.classification.unsupportedReasons.join(',')}`);
    }
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}
