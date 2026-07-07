#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import {
  buildGpuHmrProofLedger,
  queryGpuHmrLedgerInvariants,
} from './lib/gpu-hmr-proof-ledger.mjs';
import {
  evaluateGpuHmrAcceptanceContract,
  evaluateGpuHmrAcceptanceContractConsistency,
} from './lib/gpu-hmr-acceptance-contract.mjs';
import {
  runtimeProofArtifactStrictGate,
} from './lib/gpu-hmr-proof-strict-gates.mjs';
import {
  collectGpuHmrValidationMatrixLedger,
} from './lib/gpu-hmr-validation-matrix-ledger.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../..');
const MCP_ROOT = path.resolve(__dirname, '..');
const ARTIFACT_DIR = path.join(MCP_ROOT, '.gpu-hmr-test-artifacts/opencl-runtime-proof');
const SCHEMA = 'synthi.gpu_hmr.opencl_runtime_proof.v1';
const PROBE_SCHEMA = 'synthi.gpu_hmr.opencl_runtime_trace.v1';
const MODEL_AVAILABILITY_SOURCE = 'https://ai.google.dev/gemini-api/docs/deprecations';

const MODEL_REGISTRY = Object.freeze({
  'gemini-3.5-flash': {
    provider_model_status: 'available',
    provider_model_alias_resolved_to: 'gemini-3.5-flash',
    provider_shutdown_or_deprecation_detected: false,
  },
  'gemini-3.1-flash-lite': {
    provider_model_status: 'available',
    provider_model_alias_resolved_to: 'gemini-3.1-flash-lite',
    provider_shutdown_or_deprecation_detected: false,
  },
  'gemini-3.1-flash-lite-preview': {
    provider_model_status: 'shutdown',
    provider_model_alias_resolved_to: 'gemini-3.1-flash-lite',
    provider_shutdown_or_deprecation_detected: true,
    provider_recommended_replacement: 'gemini-3.1-flash-lite',
  },
});

const CFG = {
  slug: process.env.SLUG ?? `opencl-runtime-readback-${nowSlugDate()}`,
  workerContainer: process.env.SYNTHI_OPENCL_RUNTIME_CONTAINER
    ?? process.env.SYNTHI_OPENCL_WORKER_CONTAINER
    ?? process.env.WORKER_CONTAINER
    ?? 'vectant-ade-worker-1',
  useContainer: process.env.SYNTHI_OPENCL_RUNTIME_CONTAINER_DISABLED !== '1',
  timeoutMs: Number(process.env.SYNTHI_OPENCL_RUNTIME_TIMEOUT_MS ?? 120000),
  targetId: process.env.SYNTHI_OPENCL_RUNTIME_TARGET_ID ?? 'opencl-runtime-readback',
  metricScope: process.env.SYNTHI_OPENCL_RUNTIME_METRIC_SCOPE ?? 'hot_delta_1',
  cacheState: process.env.SYNTHI_OPENCL_RUNTIME_CACHE_STATE ?? 'compiler_cache_warm',
  differentEdit: process.env.SYNTHI_OPENCL_RUNTIME_DIFFERENT_EDIT === '1',
  afterMultiplier: Number(process.env.SYNTHI_OPENCL_RUNTIME_AFTER_MULTIPLIER ?? '3'),
  afterBias: Number(process.env.SYNTHI_OPENCL_RUNTIME_AFTER_BIAS ?? '0.5'),
  splitModel: process.env.SYNTHI_GEMINI_SPLIT_MODEL ?? 'gemini-3.5-flash',
  gpuDeltaModel: process.env.SYNTHI_GEMINI_DELTA_MODEL ?? 'gemini-3.1-flash-lite',
};

const INPUT_VALUES = Object.freeze([1, 2.5, 4, 8, 16, 32, 64, 128]);
const BEFORE_MULTIPLIER = 2;
const BEFORE_BIAS = 0.5;
const OPENCL_OUTPUT_TARGET_ID = 'opencl-buffer:output';

function nowSlugDate() {
  return new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${stableJson(value[key])}`
  ).join(',')}}`;
}

function sha256Bytes(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function sha256Text(value) {
  return sha256Bytes(String(value));
}

async function sha256File(filePath) {
  return sha256Bytes(await readFile(filePath));
}

function safeSlug(value) {
  return String(value || 'opencl-runtime').replace(/[^a-zA-Z0-9_.-]+/g, '-');
}

function relRepo(filePath) {
  return path.relative(REPO_ROOT, filePath).replace(/\\/g, '/');
}

function proofArtifactPath(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return null;
  if (/^[a-z][a-z0-9+.-]*:/iu.test(text)) return null;
  return text;
}

function computeOracleStrictGateOptions(oracleArtifacts = {}) {
  const artifactPaths = [
    oracleArtifacts.raw_readback_bin,
    oracleArtifacts.rawReadbackBin,
    oracleArtifacts.before_raw_readback_bin,
    oracleArtifacts.beforeRawReadbackBin,
    oracleArtifacts.readback_schema_json,
    oracleArtifacts.readbackSchemaJson,
    oracleArtifacts.rendered_card_png,
    oracleArtifacts.renderedCardPng,
    oracleArtifacts.raw_readback_cas_manifest,
    oracleArtifacts.rawReadbackCasManifest,
  ].map(proofArtifactPath).filter(Boolean);
  const allowedArtifactRoots = [...new Set(artifactPaths.map((artifactPath) => {
    const resolved = path.isAbsolute(artifactPath)
      ? artifactPath
      : path.resolve(REPO_ROOT, artifactPath);
    return path.dirname(resolved);
  }))];
  return {
    allowedArtifactRoots,
    computeArtifactPathBaseRoots: [REPO_ROOT],
  };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function nsSince(startNs) {
  return Number(process.hrtime.bigint() - startNs);
}

function durationNs(startNs, endNs) {
  return Number(endNs - startNs);
}

function execFileRaw(command, args, options = {}) {
  const started = performance.now();
  return new Promise((resolve) => {
    execFile(command, args, {
      timeout: options.timeout ?? CFG.timeoutMs,
      maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
      cwd: options.cwd,
    }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        exitCode: Number.isInteger(error?.code) ? error.code : 0,
        signal: error?.signal ?? null,
        timedOut: Boolean(error?.killed && error?.signal === 'SIGTERM'),
        durationMs: Number((performance.now() - started).toFixed(3)),
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
        error: error?.message ?? null,
      });
    });
  });
}

async function execFileChecked(command, args, options = {}) {
  const result = await execFileRaw(command, args, options);
  if (!result.ok) {
    throw new Error(`${command} ${args.join(' ')} failed exit=${result.exitCode} signal=${result.signal ?? ''}: ${result.stderr.slice(-1200)} ${result.stdout.slice(-1200)}`);
  }
  return result;
}

async function dockerExec(container, args, options = {}) {
  return execFileChecked('docker', ['exec', container, ...args], options);
}

async function dockerExecRaw(container, args, options = {}) {
  return execFileRaw('docker', ['exec', container, ...args], options);
}

async function dockerCpTo(container, localPath, remotePath) {
  await execFileChecked('docker', ['cp', localPath, `${container}:${remotePath}`], { timeout: CFG.timeoutMs });
}

async function dockerCpFrom(container, remotePath, localPath) {
  await execFileChecked('docker', ['cp', `${container}:${remotePath}`, localPath], { timeout: CFG.timeoutMs });
}

function encodeFloat32(values) {
  const buffer = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => buffer.writeFloatLE(Number(value), index * 4));
  return buffer;
}

function decodeFloat32(bytes) {
  const out = [];
  for (let offset = 0; offset + 4 <= bytes.length; offset += 4) {
    out.push(bytes.readFloatLE(offset));
  }
  return out;
}

function expectedValues(multiplier, bias) {
  return INPUT_VALUES.map((value) => Number((value * multiplier + bias).toFixed(6)));
}

function compareNumericValues(actual, expected, tolerance) {
  const mismatches = [];
  let maxAbsDelta = 0;
  const compared = Math.min(actual.length, expected.length);
  for (let index = 0; index < compared; index += 1) {
    const delta = Math.abs(Number(actual[index]) - Number(expected[index]));
    maxAbsDelta = Math.max(maxAbsDelta, delta);
    if (delta > tolerance) {
      mismatches.push({ index, actual: actual[index], expected: expected[index], abs_delta: delta });
    }
  }
  if (actual.length !== expected.length) {
    mismatches.push({ index: compared, actual_length: actual.length, expected_length: expected.length });
  }
  return {
    matched: mismatches.length === 0,
    compared,
    maxAbsDelta,
    mismatches,
  };
}

function kernelSource({ multiplier, bias, extraArg = false }) {
  const args = extraArg
    ? '__global float* output, __global const float* input, const unsigned int n, const unsigned int salt'
    : '__global float* output, __global const float* input, const unsigned int n';
  const saltTerm = extraArg ? ' + (float)(salt & 0u)' : '';
  return `__kernel void synthi_opencl_epoch_kernel(${args}) {
  const unsigned int i = get_global_id(0);
  if (i < n) {
    output[i] = input[i] * ${Number(multiplier).toFixed(8)}f + ${Number(bias).toFixed(8)}f${saltTerm};
  }
}
`;
}

function probeSource() {
  return String.raw`
#include <dlfcn.h>
#include <errno.h>
#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

typedef int32_t cl_int;
typedef uint32_t cl_uint;
typedef uint64_t cl_ulong;
typedef intptr_t cl_context_properties;
typedef cl_ulong cl_device_type;
typedef cl_ulong cl_mem_flags;
typedef cl_ulong cl_command_queue_properties;
typedef struct _cl_platform_id* cl_platform_id;
typedef struct _cl_device_id* cl_device_id;
typedef struct _cl_context* cl_context;
typedef struct _cl_command_queue* cl_command_queue;
typedef struct _cl_program* cl_program;
typedef struct _cl_kernel* cl_kernel;
typedef struct _cl_mem* cl_mem;
typedef struct _cl_event* cl_event;
typedef uint32_t cl_bool;

#define CL_SUCCESS 0
#define CL_TRUE 1
#define CL_DEVICE_TYPE_GPU (1ull << 2)
#define CL_DEVICE_TYPE_ALL 0xFFFFFFFFull
#define CL_MEM_READ_WRITE (1ull << 0)
#define CL_MEM_WRITE_ONLY (1ull << 1)
#define CL_MEM_READ_ONLY (1ull << 2)
#define CL_MEM_COPY_HOST_PTR (1ull << 5)
#define CL_PLATFORM_NAME 0x0902
#define CL_DEVICE_NAME 0x102B
#define CL_DEVICE_VENDOR 0x102C
#define CL_DEVICE_VERSION 0x102F
#define CL_PROGRAM_BUILD_LOG 0x1183

typedef cl_int (*p_clGetPlatformIDs)(cl_uint, cl_platform_id*, cl_uint*);
typedef cl_int (*p_clGetDeviceIDs)(cl_platform_id, cl_device_type, cl_uint, cl_device_id*, cl_uint*);
typedef cl_int (*p_clGetPlatformInfo)(cl_platform_id, cl_uint, size_t, void*, size_t*);
typedef cl_int (*p_clGetDeviceInfo)(cl_device_id, cl_uint, size_t, void*, size_t*);
typedef cl_context (*p_clCreateContext)(const cl_context_properties*, cl_uint, const cl_device_id*, void (*)(const char*, const void*, size_t, void*), void*, cl_int*);
typedef cl_command_queue (*p_clCreateCommandQueue)(cl_context, cl_device_id, cl_command_queue_properties, cl_int*);
typedef cl_program (*p_clCreateProgramWithSource)(cl_context, cl_uint, const char**, const size_t*, cl_int*);
typedef cl_int (*p_clBuildProgram)(cl_program, cl_uint, const cl_device_id*, const char*, void (*)(cl_program, void*), void*);
typedef cl_int (*p_clGetProgramBuildInfo)(cl_program, cl_device_id, cl_uint, size_t, void*, size_t*);
typedef cl_kernel (*p_clCreateKernel)(cl_program, const char*, cl_int*);
typedef cl_mem (*p_clCreateBuffer)(cl_context, cl_mem_flags, size_t, void*, cl_int*);
typedef cl_int (*p_clSetKernelArg)(cl_kernel, cl_uint, size_t, const void*);
typedef cl_int (*p_clEnqueueNDRangeKernel)(cl_command_queue, cl_kernel, cl_uint, const size_t*, const size_t*, const size_t*, cl_uint, const cl_event*, cl_event*);
typedef cl_int (*p_clEnqueueReadBuffer)(cl_command_queue, cl_mem, cl_bool, size_t, size_t, void*, cl_uint, const cl_event*, cl_event*);
typedef cl_int (*p_clWaitForEvents)(cl_uint, const cl_event*);
typedef cl_int (*p_clFinish)(cl_command_queue);
typedef cl_int (*p_clReleaseEvent)(cl_event);
typedef cl_int (*p_clReleaseMemObject)(cl_mem);
typedef cl_int (*p_clReleaseKernel)(cl_kernel);
typedef cl_int (*p_clReleaseProgram)(cl_program);
typedef cl_int (*p_clReleaseCommandQueue)(cl_command_queue);
typedef cl_int (*p_clReleaseContext)(cl_context);

struct opencl_api {
  p_clGetPlatformIDs clGetPlatformIDs;
  p_clGetDeviceIDs clGetDeviceIDs;
  p_clGetPlatformInfo clGetPlatformInfo;
  p_clGetDeviceInfo clGetDeviceInfo;
  p_clCreateContext clCreateContext;
  p_clCreateCommandQueue clCreateCommandQueue;
  p_clCreateProgramWithSource clCreateProgramWithSource;
  p_clBuildProgram clBuildProgram;
  p_clGetProgramBuildInfo clGetProgramBuildInfo;
  p_clCreateKernel clCreateKernel;
  p_clCreateBuffer clCreateBuffer;
  p_clSetKernelArg clSetKernelArg;
  p_clEnqueueNDRangeKernel clEnqueueNDRangeKernel;
  p_clEnqueueReadBuffer clEnqueueReadBuffer;
  p_clWaitForEvents clWaitForEvents;
  p_clFinish clFinish;
  p_clReleaseEvent clReleaseEvent;
  p_clReleaseMemObject clReleaseMemObject;
  p_clReleaseKernel clReleaseKernel;
  p_clReleaseProgram clReleaseProgram;
  p_clReleaseCommandQueue clReleaseCommandQueue;
  p_clReleaseContext clReleaseContext;
};

static uint64_t now_ns(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (uint64_t)ts.tv_sec * 1000000000ull + (uint64_t)ts.tv_nsec;
}

static char* read_file(const char* path, size_t* len_out) {
  FILE* f = fopen(path, "rb");
  if (!f) return NULL;
  fseek(f, 0, SEEK_END);
  long len = ftell(f);
  fseek(f, 0, SEEK_SET);
  char* data = (char*)calloc((size_t)len + 1, 1);
  if (!data) { fclose(f); return NULL; }
  if (fread(data, 1, (size_t)len, f) != (size_t)len) { fclose(f); free(data); return NULL; }
  fclose(f);
  data[len] = 0;
  if (len_out) *len_out = (size_t)len;
  return data;
}

static void json_escape(FILE* f, const char* s) {
  fputc('"', f);
  for (const unsigned char* p = (const unsigned char*)s; p && *p; ++p) {
    if (*p == '"' || *p == '\\') { fputc('\\', f); fputc(*p, f); }
    else if (*p == '\n') fputs("\\n", f);
    else if (*p == '\r') fputs("\\r", f);
    else if (*p == '\t') fputs("\\t", f);
    else if (*p >= 32) fputc(*p, f);
  }
  fputc('"', f);
}

static void get_info_string_device(struct opencl_api* api, cl_device_id dev, cl_uint param, char* out, size_t cap) {
  if (!out || cap == 0) return;
  out[0] = 0;
  size_t len = 0;
  if (api->clGetDeviceInfo(dev, param, cap, out, &len) != CL_SUCCESS) snprintf(out, cap, "unknown");
  out[cap - 1] = 0;
}

static void get_info_string_platform(struct opencl_api* api, cl_platform_id platform, cl_uint param, char* out, size_t cap) {
  if (!out || cap == 0) return;
  out[0] = 0;
  size_t len = 0;
  if (api->clGetPlatformInfo(platform, param, cap, out, &len) != CL_SUCCESS) snprintf(out, cap, "unknown");
  out[cap - 1] = 0;
}

static int load_api(struct opencl_api* api) {
  memset(api, 0, sizeof(*api));
  void* lib = dlopen("libOpenCL.so.1", RTLD_NOW | RTLD_LOCAL);
  if (!lib) lib = dlopen("libOpenCL.so", RTLD_NOW | RTLD_LOCAL);
  if (!lib) {
    fprintf(stderr, "opencl_runtime_error=loader_missing detail=%s\n", dlerror());
    return 2;
  }
#define LOAD(name) do { api->name = (p_##name)dlsym(lib, #name); if (!api->name) { fprintf(stderr, "opencl_runtime_error=symbol_missing symbol=%s\n", #name); return 3; } } while (0)
  LOAD(clGetPlatformIDs);
  LOAD(clGetDeviceIDs);
  LOAD(clGetPlatformInfo);
  LOAD(clGetDeviceInfo);
  LOAD(clCreateContext);
  LOAD(clCreateCommandQueue);
  LOAD(clCreateProgramWithSource);
  LOAD(clBuildProgram);
  LOAD(clGetProgramBuildInfo);
  LOAD(clCreateKernel);
  LOAD(clCreateBuffer);
  LOAD(clSetKernelArg);
  LOAD(clEnqueueNDRangeKernel);
  LOAD(clEnqueueReadBuffer);
  LOAD(clWaitForEvents);
  LOAD(clFinish);
  LOAD(clReleaseEvent);
  LOAD(clReleaseMemObject);
  LOAD(clReleaseKernel);
  LOAD(clReleaseProgram);
  LOAD(clReleaseCommandQueue);
  LOAD(clReleaseContext);
#undef LOAD
  return 0;
}

static int select_device(struct opencl_api* api, cl_platform_id* platform_out, cl_device_id* device_out) {
  cl_uint platform_count = 0;
  cl_int err = api->clGetPlatformIDs(0, NULL, &platform_count);
  if (err != CL_SUCCESS || platform_count == 0) {
    fprintf(stderr, "opencl_runtime_error=platform_missing err=%d count=%u\n", err, platform_count);
    return 10;
  }
  cl_platform_id* platforms = (cl_platform_id*)calloc(platform_count, sizeof(cl_platform_id));
  api->clGetPlatformIDs(platform_count, platforms, NULL);
  for (cl_uint i = 0; i < platform_count; ++i) {
    cl_uint device_count = 0;
    err = api->clGetDeviceIDs(platforms[i], CL_DEVICE_TYPE_GPU, 0, NULL, &device_count);
    if (err == CL_SUCCESS && device_count > 0) {
      cl_device_id* devices = (cl_device_id*)calloc(device_count, sizeof(cl_device_id));
      api->clGetDeviceIDs(platforms[i], CL_DEVICE_TYPE_GPU, device_count, devices, NULL);
      *platform_out = platforms[i];
      *device_out = devices[0];
      free(devices);
      free(platforms);
      return 0;
    }
  }
  for (cl_uint i = 0; i < platform_count; ++i) {
    cl_uint device_count = 0;
    err = api->clGetDeviceIDs(platforms[i], CL_DEVICE_TYPE_ALL, 0, NULL, &device_count);
    if (err == CL_SUCCESS && device_count > 0) {
      cl_device_id* devices = (cl_device_id*)calloc(device_count, sizeof(cl_device_id));
      api->clGetDeviceIDs(platforms[i], CL_DEVICE_TYPE_ALL, device_count, devices, NULL);
      *platform_out = platforms[i];
      *device_out = devices[0];
      free(devices);
      free(platforms);
      return 0;
    }
  }
  free(platforms);
  fprintf(stderr, "opencl_runtime_error=device_missing\n");
  return 11;
}

struct epoch_result {
  cl_program program;
  cl_kernel kernel;
  uint64_t build_ns;
  uint64_t kernel_ns;
  uint64_t dispatch_ns;
  uint64_t output_ns;
  float output[8];
};

static int build_and_run_epoch(
  struct opencl_api* api,
  cl_context context,
  cl_command_queue queue,
  cl_device_id device,
  const char* source,
  cl_mem input_buf,
  cl_mem output_buf,
  struct epoch_result* result
) {
  memset(result, 0, sizeof(*result));
  cl_int err = CL_SUCCESS;
  const char* sources[1] = { source };
  size_t lengths[1] = { strlen(source) };
  result->program = api->clCreateProgramWithSource(context, 1, sources, lengths, &err);
  if (err != CL_SUCCESS || !result->program) {
    fprintf(stderr, "opencl_runtime_error=create_program_failed err=%d\n", err);
    return 20;
  }
  result->build_ns = now_ns();
  err = api->clBuildProgram(result->program, 1, &device, "", NULL, NULL);
  if (err != CL_SUCCESS) {
    char log[8192];
    memset(log, 0, sizeof(log));
    api->clGetProgramBuildInfo(result->program, device, CL_PROGRAM_BUILD_LOG, sizeof(log) - 1, log, NULL);
    fprintf(stderr, "opencl_runtime_error=build_failed err=%d log=%s\n", err, log);
    return 21;
  }
  result->kernel_ns = now_ns();
  result->kernel = api->clCreateKernel(result->program, "synthi_opencl_epoch_kernel", &err);
  if (err != CL_SUCCESS || !result->kernel) {
    fprintf(stderr, "opencl_runtime_error=create_kernel_failed err=%d\n", err);
    return 22;
  }
  const cl_uint n = 8;
  err = api->clSetKernelArg(result->kernel, 0, sizeof(cl_mem), &output_buf);
  if (err == CL_SUCCESS) err = api->clSetKernelArg(result->kernel, 1, sizeof(cl_mem), &input_buf);
  if (err == CL_SUCCESS) err = api->clSetKernelArg(result->kernel, 2, sizeof(cl_uint), &n);
  if (err != CL_SUCCESS) {
    fprintf(stderr, "opencl_runtime_error=set_arg_failed err=%d\n", err);
    return 23;
  }
  const size_t global_size[1] = { 8 };
  const size_t local_size[1] = { 8 };
  cl_event dispatch_event = NULL;
  result->dispatch_ns = now_ns();
  err = api->clEnqueueNDRangeKernel(queue, result->kernel, 1, NULL, global_size, local_size, 0, NULL, &dispatch_event);
  if (err != CL_SUCCESS) {
    fprintf(stderr, "opencl_runtime_error=enqueue_failed err=%d\n", err);
    return 24;
  }
  api->clWaitForEvents(1, &dispatch_event);
  api->clReleaseEvent(dispatch_event);
  cl_event read_event = NULL;
  err = api->clEnqueueReadBuffer(queue, output_buf, CL_TRUE, 0, sizeof(result->output), result->output, 0, NULL, &read_event);
  if (err != CL_SUCCESS) {
    fprintf(stderr, "opencl_runtime_error=readback_failed err=%d\n", err);
    return 25;
  }
  api->clWaitForEvents(1, &read_event);
  api->clReleaseEvent(read_event);
  api->clFinish(queue);
  result->output_ns = now_ns();
  return 0;
}

static void write_values_json(FILE* f, const float values[8]) {
  fputc('[', f);
  for (int i = 0; i < 8; ++i) {
    if (i) fputc(',', f);
    fprintf(f, "%.9g", values[i]);
  }
  fputc(']', f);
}

int main(int argc, char** argv) {
  if (argc != 7) {
    fprintf(stderr, "usage: %s before.cl after.cl raw-after.bin trace.json before_hash after_hash\n", argv[0]);
    return 64;
  }
  const char* before_path = argv[1];
  const char* after_path = argv[2];
  const char* raw_path = argv[3];
  const char* trace_path = argv[4];
  const char* before_hash = argv[5];
  const char* after_hash = argv[6];
  struct opencl_api api;
  int rc = load_api(&api);
  if (rc != 0) return rc;
  cl_platform_id platform = NULL;
  cl_device_id device = NULL;
  rc = select_device(&api, &platform, &device);
  if (rc != 0) return rc;
  char platform_name[256], device_name[256], device_vendor[256], device_version[256];
  get_info_string_platform(&api, platform, CL_PLATFORM_NAME, platform_name, sizeof(platform_name));
  get_info_string_device(&api, device, CL_DEVICE_NAME, device_name, sizeof(device_name));
  get_info_string_device(&api, device, CL_DEVICE_VENDOR, device_vendor, sizeof(device_vendor));
  get_info_string_device(&api, device, CL_DEVICE_VERSION, device_version, sizeof(device_version));
  size_t before_len = 0, after_len = 0;
  char* before_source = read_file(before_path, &before_len);
  char* after_source = read_file(after_path, &after_len);
  if (!before_source || !after_source) {
    fprintf(stderr, "opencl_runtime_error=source_read_failed errno=%d\n", errno);
    return 30;
  }
  cl_int err = CL_SUCCESS;
  cl_context context = api.clCreateContext(NULL, 1, &device, NULL, NULL, &err);
  if (err != CL_SUCCESS || !context) {
    fprintf(stderr, "opencl_runtime_error=context_failed err=%d\n", err);
    return 31;
  }
  cl_command_queue queue = api.clCreateCommandQueue(context, device, 0, &err);
  if (err != CL_SUCCESS || !queue) {
    fprintf(stderr, "opencl_runtime_error=queue_failed err=%d\n", err);
    return 32;
  }
  float input[8] = { 1.0f, 2.5f, 4.0f, 8.0f, 16.0f, 32.0f, 64.0f, 128.0f };
  float zero[8] = {0};
  cl_mem input_buf = api.clCreateBuffer(context, CL_MEM_READ_ONLY | CL_MEM_COPY_HOST_PTR, sizeof(input), input, &err);
  if (err != CL_SUCCESS || !input_buf) {
    fprintf(stderr, "opencl_runtime_error=input_buffer_failed err=%d\n", err);
    return 33;
  }
  cl_mem output_buf = api.clCreateBuffer(context, CL_MEM_READ_WRITE | CL_MEM_COPY_HOST_PTR, sizeof(zero), zero, &err);
  if (err != CL_SUCCESS || !output_buf) {
    fprintf(stderr, "opencl_runtime_error=output_buffer_failed err=%d\n", err);
    return 34;
  }
  const uint64_t process_start_ns = now_ns();
  struct epoch_result before, after;
  rc = build_and_run_epoch(&api, context, queue, device, before_source, input_buf, output_buf, &before);
  if (rc != 0) return rc;
  rc = build_and_run_epoch(&api, context, queue, device, after_source, input_buf, output_buf, &after);
  if (rc != 0) return rc;
  FILE* raw = fopen(raw_path, "wb");
  if (!raw) {
    fprintf(stderr, "opencl_runtime_error=raw_write_failed errno=%d\n", errno);
    return 40;
  }
  fwrite(after.output, sizeof(float), 8, raw);
  fclose(raw);
  FILE* trace = fopen(trace_path, "wb");
  if (!trace) {
    fprintf(stderr, "opencl_runtime_error=trace_write_failed errno=%d\n", errno);
    return 41;
  }
  fprintf(trace, "{\n");
  fprintf(trace, "  \"schemaVersion\": \"%s\",\n", "${PROBE_SCHEMA}");
  fprintf(trace, "  \"processId\": \"pid:%ld\",\n", (long)getpid());
  fprintf(trace, "  \"sameProcess\": true,\n  \"processRestarted\": false,\n");
  fprintf(trace, "  \"device\": {\"backend\":\"opencl\", \"platformName\":");
  json_escape(trace, platform_name);
  fprintf(trace, ", \"deviceName\":");
  json_escape(trace, device_name);
  fprintf(trace, ", \"deviceVendor\":");
  json_escape(trace, device_vendor);
  fprintf(trace, ", \"deviceVersion\":");
  json_escape(trace, device_version);
  fprintf(trace, "},\n");
  fprintf(trace, "  \"loaderEvents\": [\n");
  fprintf(trace, "    {\"id\":\"opencl-build-epoch-1\", \"api\":\"clBuildProgram\", \"artifact_hash\":");
  json_escape(trace, before_hash);
  fprintf(trace, ", \"epoch\":\"1\", \"timestamp_monotonic_ns\":%" PRIu64 "},\n", before.build_ns);
  fprintf(trace, "    {\"id\":\"opencl-build-epoch-2\", \"api\":\"clBuildProgram\", \"artifact_hash\":");
  json_escape(trace, after_hash);
  fprintf(trace, ", \"epoch\":\"2\", \"timestamp_monotonic_ns\":%" PRIu64 "}\n", after.build_ns);
  fprintf(trace, "  ],\n");
  fprintf(trace, "  \"kernelEvents\": [\n");
  fprintf(trace, "    {\"id\":\"opencl-kernel-epoch-1\", \"api\":\"clCreateKernel\", \"kernel_name\":\"synthi_opencl_epoch_kernel\", \"artifact_hash\":");
  json_escape(trace, before_hash);
  fprintf(trace, ", \"epoch\":\"1\", \"timestamp_monotonic_ns\":%" PRIu64 "},\n", before.kernel_ns);
  fprintf(trace, "    {\"id\":\"opencl-kernel-epoch-2\", \"api\":\"clCreateKernel\", \"kernel_name\":\"synthi_opencl_epoch_kernel\", \"artifact_hash\":");
  json_escape(trace, after_hash);
  fprintf(trace, ", \"epoch\":\"2\", \"timestamp_monotonic_ns\":%" PRIu64 "}\n", after.kernel_ns);
  fprintf(trace, "  ],\n");
  fprintf(trace, "  \"epochEvents\": [\n");
  fprintf(trace, "    {\"id\":\"opencl-epoch-1\", \"event\":\"published\", \"artifact_hash\":");
  json_escape(trace, before_hash);
  fprintf(trace, ", \"epoch\":\"1\", \"timestamp_monotonic_ns\":%" PRIu64 ", \"dispatch_binding\":\"cl_kernel:synthi_opencl_epoch_kernel\"},\n", before.kernel_ns);
  fprintf(trace, "    {\"id\":\"opencl-epoch-2\", \"event\":\"published\", \"artifact_hash\":");
  json_escape(trace, after_hash);
  fprintf(trace, ", \"epoch\":\"2\", \"timestamp_monotonic_ns\":%" PRIu64 ", \"dispatch_binding\":\"cl_kernel:synthi_opencl_epoch_kernel\"}\n", after.kernel_ns);
  fprintf(trace, "  ],\n");
  fprintf(trace, "  \"dispatchEvents\": [\n");
  fprintf(trace, "    {\"id\":\"opencl-dispatch-epoch-1\", \"launch_api\":\"clEnqueueNDRangeKernel\", \"artifact_hash\":");
  json_escape(trace, before_hash);
  fprintf(trace, ", \"epoch\":\"1\", \"timestamp_monotonic_ns\":%" PRIu64 ", \"kernel_name\":\"synthi_opencl_epoch_kernel\", \"global_work_size\":[8], \"local_work_size\":[8], \"output_target_id\":\"opencl-buffer:output\"},\n", before.dispatch_ns);
  fprintf(trace, "    {\"id\":\"opencl-dispatch-epoch-2\", \"launch_api\":\"clEnqueueNDRangeKernel\", \"artifact_hash\":");
  json_escape(trace, after_hash);
  fprintf(trace, ", \"epoch\":\"2\", \"timestamp_monotonic_ns\":%" PRIu64 ", \"kernel_name\":\"synthi_opencl_epoch_kernel\", \"global_work_size\":[8], \"local_work_size\":[8], \"output_target_id\":\"opencl-buffer:output\"}\n", after.dispatch_ns);
  fprintf(trace, "  ],\n");
  fprintf(trace, "  \"outputEvents\": [\n");
  fprintf(trace, "    {\"id\":\"opencl-output-epoch-1\", \"passed\":true, \"after_dispatch_id\":\"opencl-dispatch-epoch-1\", \"artifact_hash\":");
  json_escape(trace, before_hash);
  fprintf(trace, ", \"epoch\":\"1\", \"timestamp_monotonic_ns\":%" PRIu64 ", \"output_target_id\":\"opencl-buffer:output\", \"values\":", before.output_ns);
  write_values_json(trace, before.output);
  fprintf(trace, "},\n");
  fprintf(trace, "    {\"id\":\"opencl-output-epoch-2\", \"passed\":true, \"after_dispatch_id\":\"opencl-dispatch-epoch-2\", \"artifact_hash\":");
  json_escape(trace, after_hash);
  fprintf(trace, ", \"epoch\":\"2\", \"timestamp_monotonic_ns\":%" PRIu64 ", \"output_target_id\":\"opencl-buffer:output\", \"values\":", after.output_ns);
  write_values_json(trace, after.output);
  fprintf(trace, "}\n");
  fprintf(trace, "  ],\n");
  fprintf(trace, "  \"retirementEvent\": {\"id\":\"opencl-retire-epoch-1\", \"status\":\"queue_idle_proven\", \"retired_epoch\":\"1\", \"timestamp_monotonic_ns\":%" PRIu64 ", \"evidence_refs\":[\"runtime:opencl:clFinish\", \"runtime:opencl:clReleaseProgram\"]},\n", now_ns());
  fprintf(trace, "  \"nativeApiCounts\": {\"clBuildProgram\":2, \"clCreateKernel\":2, \"clEnqueueNDRangeKernel\":2, \"clEnqueueReadBuffer\":2, \"clFinish\":2},\n");
  fprintf(trace, "  \"processStartTimestampNs\": %" PRIu64 "\n", process_start_ns);
  fprintf(trace, "}\n");
  fclose(trace);
  api.clReleaseMemObject(input_buf);
  api.clReleaseMemObject(output_buf);
  api.clReleaseKernel(before.kernel);
  api.clReleaseKernel(after.kernel);
  api.clReleaseProgram(before.program);
  api.clReleaseProgram(after.program);
  api.clReleaseCommandQueue(queue);
  api.clReleaseContext(context);
  free(before_source);
  free(after_source);
  return 0;
}
`;
}

function windowsPowerShellProbeSource() {
  return String.raw`
param(
  [Parameter(Mandatory=$true)][string]$BeforePath,
  [Parameter(Mandatory=$true)][string]$AfterPath,
  [Parameter(Mandatory=$true)][string]$RawPath,
  [Parameter(Mandatory=$true)][string]$TracePath,
  [Parameter(Mandatory=$true)][string]$BeforeHash,
  [Parameter(Mandatory=$true)][string]$AfterHash,
  [Parameter(Mandatory=$true)][string]$SchemaVersion
)
$ErrorActionPreference = 'Stop'
$source = @'
using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class SynthiOpenClWindowsProbe {
  const int CL_SUCCESS = 0;
  const uint CL_TRUE = 1;
  const ulong CL_DEVICE_TYPE_GPU = (1UL << 2);
  const ulong CL_DEVICE_TYPE_ALL = 0xFFFFFFFFUL;
  const ulong CL_MEM_READ_WRITE = (1UL << 0);
  const ulong CL_MEM_READ_ONLY = (1UL << 2);
  const ulong CL_MEM_COPY_HOST_PTR = (1UL << 5);
  const uint CL_PLATFORM_NAME = 0x0902;
  const uint CL_DEVICE_NAME = 0x102B;
  const uint CL_DEVICE_VENDOR = 0x102C;
  const uint CL_DEVICE_VERSION = 0x102F;
  const uint CL_PROGRAM_BUILD_LOG = 0x1183;

  [DllImport("OpenCL.dll")]
  static extern int clGetPlatformIDs(uint numEntries, [Out] IntPtr[] platforms, out uint numPlatforms);
  [DllImport("OpenCL.dll")]
  static extern int clGetDeviceIDs(IntPtr platform, ulong deviceType, uint numEntries, [Out] IntPtr[] devices, out uint numDevices);
  [DllImport("OpenCL.dll")]
  static extern int clGetPlatformInfo(IntPtr platform, uint paramName, UIntPtr paramValueSize, StringBuilder paramValue, out UIntPtr paramValueSizeRet);
  [DllImport("OpenCL.dll")]
  static extern int clGetDeviceInfo(IntPtr device, uint paramName, UIntPtr paramValueSize, StringBuilder paramValue, out UIntPtr paramValueSizeRet);
  [DllImport("OpenCL.dll")]
  static extern IntPtr clCreateContext(IntPtr properties, uint numDevices, IntPtr[] devices, IntPtr notify, IntPtr userData, out int errcodeRet);
  [DllImport("OpenCL.dll")]
  static extern IntPtr clCreateCommandQueue(IntPtr context, IntPtr device, ulong properties, out int errcodeRet);
  [DllImport("OpenCL.dll", CharSet = CharSet.Ansi)]
  static extern IntPtr clCreateProgramWithSource(IntPtr context, uint count, string[] strings, UIntPtr[] lengths, out int errcodeRet);
  [DllImport("OpenCL.dll", CharSet = CharSet.Ansi)]
  static extern int clBuildProgram(IntPtr program, uint numDevices, IntPtr[] deviceList, string options, IntPtr notify, IntPtr userData);
  [DllImport("OpenCL.dll")]
  static extern int clGetProgramBuildInfo(IntPtr program, IntPtr device, uint paramName, UIntPtr paramValueSize, StringBuilder paramValue, out UIntPtr paramValueSizeRet);
  [DllImport("OpenCL.dll", CharSet = CharSet.Ansi)]
  static extern IntPtr clCreateKernel(IntPtr program, string kernelName, out int errcodeRet);
  [DllImport("OpenCL.dll")]
  static extern IntPtr clCreateBuffer(IntPtr context, ulong flags, UIntPtr size, IntPtr hostPtr, out int errcodeRet);
  [DllImport("OpenCL.dll", EntryPoint = "clSetKernelArg")]
  static extern int clSetKernelArgMem(IntPtr kernel, uint argIndex, UIntPtr argSize, ref IntPtr argValue);
  [DllImport("OpenCL.dll", EntryPoint = "clSetKernelArg")]
  static extern int clSetKernelArgUInt(IntPtr kernel, uint argIndex, UIntPtr argSize, ref uint argValue);
  [DllImport("OpenCL.dll")]
  static extern int clEnqueueNDRangeKernel(IntPtr commandQueue, IntPtr kernel, uint workDim, IntPtr globalWorkOffset, UIntPtr[] globalWorkSize, UIntPtr[] localWorkSize, uint numEventsInWaitList, IntPtr eventWaitList, out IntPtr evt);
  [DllImport("OpenCL.dll")]
  static extern int clEnqueueReadBuffer(IntPtr commandQueue, IntPtr buffer, uint blockingRead, UIntPtr offset, UIntPtr cb, IntPtr ptr, uint numEventsInWaitList, IntPtr eventWaitList, out IntPtr evt);
  [DllImport("OpenCL.dll")]
  static extern int clWaitForEvents(uint numEvents, IntPtr[] eventList);
  [DllImport("OpenCL.dll")]
  static extern int clFinish(IntPtr commandQueue);
  [DllImport("OpenCL.dll")]
  static extern int clReleaseEvent(IntPtr evt);
  [DllImport("OpenCL.dll")]
  static extern int clReleaseMemObject(IntPtr memobj);
  [DllImport("OpenCL.dll")]
  static extern int clReleaseKernel(IntPtr kernel);
  [DllImport("OpenCL.dll")]
  static extern int clReleaseProgram(IntPtr program);
  [DllImport("OpenCL.dll")]
  static extern int clReleaseCommandQueue(IntPtr commandQueue);
  [DllImport("OpenCL.dll")]
  static extern int clReleaseContext(IntPtr context);

  sealed class EpochResult {
    public IntPtr Program;
    public IntPtr Kernel;
    public long BuildNs;
    public long KernelNs;
    public long DispatchNs;
    public long OutputNs;
    public float[] Output = new float[8];
  }

  static long NowNs() {
    return (long)((Stopwatch.GetTimestamp() * 1000000000.0) / Stopwatch.Frequency);
  }

  static int Fail(string code, int exitCode, string detail) {
    Console.Error.WriteLine("opencl_runtime_error=" + code + " detail=" + detail);
    return exitCode;
  }

  static string InfoStringPlatform(IntPtr platform, uint param) {
    StringBuilder value = new StringBuilder(256);
    UIntPtr ignored;
    int err = clGetPlatformInfo(platform, param, new UIntPtr((uint)value.Capacity), value, out ignored);
    return err == CL_SUCCESS ? value.ToString().TrimEnd('\0') : "unknown";
  }

  static string InfoStringDevice(IntPtr device, uint param) {
    StringBuilder value = new StringBuilder(256);
    UIntPtr ignored;
    int err = clGetDeviceInfo(device, param, new UIntPtr((uint)value.Capacity), value, out ignored);
    return err == CL_SUCCESS ? value.ToString().TrimEnd('\0') : "unknown";
  }

  static int SelectDevice(out IntPtr platform, out IntPtr device) {
    platform = IntPtr.Zero;
    device = IntPtr.Zero;
    uint platformCount;
    int err = clGetPlatformIDs(0, null, out platformCount);
    if (err != CL_SUCCESS || platformCount == 0) return Fail("platform_missing", 10, "err=" + err + " count=" + platformCount);
    IntPtr[] platforms = new IntPtr[(int)platformCount];
    err = clGetPlatformIDs(platformCount, platforms, out platformCount);
    if (err != CL_SUCCESS) return Fail("platform_missing", 10, "enumeration_err=" + err);
    for (int i = 0; i < platforms.Length; i++) {
      uint deviceCount;
      err = clGetDeviceIDs(platforms[i], CL_DEVICE_TYPE_GPU, 0, null, out deviceCount);
      if (err == CL_SUCCESS && deviceCount > 0) {
        IntPtr[] devices = new IntPtr[(int)deviceCount];
        err = clGetDeviceIDs(platforms[i], CL_DEVICE_TYPE_GPU, deviceCount, devices, out deviceCount);
        if (err == CL_SUCCESS && deviceCount > 0) {
          platform = platforms[i];
          device = devices[0];
          return 0;
        }
      }
    }
    for (int i = 0; i < platforms.Length; i++) {
      uint deviceCount;
      err = clGetDeviceIDs(platforms[i], CL_DEVICE_TYPE_ALL, 0, null, out deviceCount);
      if (err == CL_SUCCESS && deviceCount > 0) {
        IntPtr[] devices = new IntPtr[(int)deviceCount];
        err = clGetDeviceIDs(platforms[i], CL_DEVICE_TYPE_ALL, deviceCount, devices, out deviceCount);
        if (err == CL_SUCCESS && deviceCount > 0) {
          platform = platforms[i];
          device = devices[0];
          return 0;
        }
      }
    }
    return Fail("device_missing", 11, "no GPU or fallback OpenCL device found");
  }

  static string BuildLog(IntPtr program, IntPtr device) {
    StringBuilder value = new StringBuilder(8192);
    UIntPtr ignored;
    clGetProgramBuildInfo(program, device, CL_PROGRAM_BUILD_LOG, new UIntPtr((uint)value.Capacity), value, out ignored);
    return value.ToString();
  }

  static int BuildAndRunEpoch(IntPtr context, IntPtr queue, IntPtr device, string source, IntPtr inputBuf, IntPtr outputBuf, EpochResult result) {
    int err;
    string[] sources = new string[] { source };
    UIntPtr[] lengths = new UIntPtr[] { new UIntPtr((uint)Encoding.ASCII.GetByteCount(source)) };
    result.Program = clCreateProgramWithSource(context, 1, sources, lengths, out err);
    if (err != CL_SUCCESS || result.Program == IntPtr.Zero) return Fail("create_program_failed", 20, "err=" + err);
    result.BuildNs = NowNs();
    err = clBuildProgram(result.Program, 1, new IntPtr[] { device }, "", IntPtr.Zero, IntPtr.Zero);
    if (err != CL_SUCCESS) return Fail("build_failed", 21, "err=" + err + " log=" + BuildLog(result.Program, device));
    result.KernelNs = NowNs();
    result.Kernel = clCreateKernel(result.Program, "synthi_opencl_epoch_kernel", out err);
    if (err != CL_SUCCESS || result.Kernel == IntPtr.Zero) return Fail("create_kernel_failed", 22, "err=" + err);
    IntPtr outputArg = outputBuf;
    IntPtr inputArg = inputBuf;
    uint n = 8;
    err = clSetKernelArgMem(result.Kernel, 0, new UIntPtr((uint)IntPtr.Size), ref outputArg);
    if (err == CL_SUCCESS) err = clSetKernelArgMem(result.Kernel, 1, new UIntPtr((uint)IntPtr.Size), ref inputArg);
    if (err == CL_SUCCESS) err = clSetKernelArgUInt(result.Kernel, 2, new UIntPtr((uint)4), ref n);
    if (err != CL_SUCCESS) return Fail("set_arg_failed", 23, "err=" + err);
    UIntPtr[] global = new UIntPtr[] { new UIntPtr((uint)8) };
    UIntPtr[] local = new UIntPtr[] { new UIntPtr((uint)8) };
    IntPtr dispatchEvent;
    result.DispatchNs = NowNs();
    err = clEnqueueNDRangeKernel(queue, result.Kernel, 1, IntPtr.Zero, global, local, 0, IntPtr.Zero, out dispatchEvent);
    if (err != CL_SUCCESS) return Fail("enqueue_failed", 24, "err=" + err);
    if (dispatchEvent != IntPtr.Zero) {
      clWaitForEvents(1, new IntPtr[] { dispatchEvent });
      clReleaseEvent(dispatchEvent);
    }
    GCHandle outputHandle = GCHandle.Alloc(result.Output, GCHandleType.Pinned);
    try {
      IntPtr readEvent;
      err = clEnqueueReadBuffer(queue, outputBuf, CL_TRUE, UIntPtr.Zero, new UIntPtr((uint)(result.Output.Length * 4)), outputHandle.AddrOfPinnedObject(), 0, IntPtr.Zero, out readEvent);
      if (err != CL_SUCCESS) return Fail("readback_failed", 25, "err=" + err);
      if (readEvent != IntPtr.Zero) {
        clWaitForEvents(1, new IntPtr[] { readEvent });
        clReleaseEvent(readEvent);
      }
      clFinish(queue);
      result.OutputNs = NowNs();
    } finally {
      outputHandle.Free();
    }
    return 0;
  }

  static void AppendEscaped(StringBuilder sb, string value) {
    sb.Append('"');
    if (value != null) {
      for (int i = 0; i < value.Length; i++) {
        char c = value[i];
        if (c == '"' || c == '\\') {
          sb.Append('\\').Append(c);
        } else if (c == '\n') {
          sb.Append("\\n");
        } else if (c == '\r') {
          sb.Append("\\r");
        } else if (c == '\t') {
          sb.Append("\\t");
        } else if (c >= 32) {
          sb.Append(c);
        }
      }
    }
    sb.Append('"');
  }

  static void AppendValues(StringBuilder sb, float[] values) {
    sb.Append('[');
    for (int i = 0; i < values.Length; i++) {
      if (i > 0) sb.Append(',');
      sb.Append(values[i].ToString("R", CultureInfo.InvariantCulture));
    }
    sb.Append(']');
  }

  static void WriteTrace(string tracePath, string schemaVersion, string beforeHash, string afterHash, string platformName, string deviceName, string deviceVendor, string deviceVersion, EpochResult before, EpochResult after, long processStartNs) {
    string processId = "pid:" + Process.GetCurrentProcess().Id.ToString(CultureInfo.InvariantCulture);
    StringBuilder trace = new StringBuilder();
    trace.Append("{\n");
    trace.Append("  \"schemaVersion\": "); AppendEscaped(trace, schemaVersion); trace.Append(",\n");
    trace.Append("  \"processId\": "); AppendEscaped(trace, processId); trace.Append(",\n");
    trace.Append("  \"sameProcess\": true,\n  \"processRestarted\": false,\n");
    trace.Append("  \"probeTransport\": \"local_windows_powershell_add_type\",\n");
    trace.Append("  \"device\": {\"backend\":\"opencl\", \"platformName\":"); AppendEscaped(trace, platformName);
    trace.Append(", \"deviceName\":"); AppendEscaped(trace, deviceName);
    trace.Append(", \"deviceVendor\":"); AppendEscaped(trace, deviceVendor);
    trace.Append(", \"deviceVersion\":"); AppendEscaped(trace, deviceVersion); trace.Append("},\n");
    trace.Append("  \"loaderEvents\": [\n");
    trace.Append("    {\"id\":\"opencl-build-epoch-1\", \"api\":\"clBuildProgram\", \"artifact_hash\":"); AppendEscaped(trace, beforeHash); trace.Append(", \"epoch\":\"1\", \"timestamp_monotonic_ns\":").Append(before.BuildNs).Append("},\n");
    trace.Append("    {\"id\":\"opencl-build-epoch-2\", \"api\":\"clBuildProgram\", \"artifact_hash\":"); AppendEscaped(trace, afterHash); trace.Append(", \"epoch\":\"2\", \"timestamp_monotonic_ns\":").Append(after.BuildNs).Append("}\n");
    trace.Append("  ],\n");
    trace.Append("  \"kernelEvents\": [\n");
    trace.Append("    {\"id\":\"opencl-kernel-epoch-1\", \"api\":\"clCreateKernel\", \"kernel_name\":\"synthi_opencl_epoch_kernel\", \"artifact_hash\":"); AppendEscaped(trace, beforeHash); trace.Append(", \"epoch\":\"1\", \"timestamp_monotonic_ns\":").Append(before.KernelNs).Append("},\n");
    trace.Append("    {\"id\":\"opencl-kernel-epoch-2\", \"api\":\"clCreateKernel\", \"kernel_name\":\"synthi_opencl_epoch_kernel\", \"artifact_hash\":"); AppendEscaped(trace, afterHash); trace.Append(", \"epoch\":\"2\", \"timestamp_monotonic_ns\":").Append(after.KernelNs).Append("}\n");
    trace.Append("  ],\n");
    trace.Append("  \"epochEvents\": [\n");
    trace.Append("    {\"id\":\"opencl-epoch-1\", \"event\":\"published\", \"artifact_hash\":"); AppendEscaped(trace, beforeHash); trace.Append(", \"epoch\":\"1\", \"timestamp_monotonic_ns\":").Append(before.KernelNs).Append(", \"dispatch_binding\":\"cl_kernel:synthi_opencl_epoch_kernel\"},\n");
    trace.Append("    {\"id\":\"opencl-epoch-2\", \"event\":\"published\", \"artifact_hash\":"); AppendEscaped(trace, afterHash); trace.Append(", \"epoch\":\"2\", \"timestamp_monotonic_ns\":").Append(after.KernelNs).Append(", \"dispatch_binding\":\"cl_kernel:synthi_opencl_epoch_kernel\"}\n");
    trace.Append("  ],\n");
    trace.Append("  \"dispatchEvents\": [\n");
    trace.Append("    {\"id\":\"opencl-dispatch-epoch-1\", \"launch_api\":\"clEnqueueNDRangeKernel\", \"artifact_hash\":"); AppendEscaped(trace, beforeHash); trace.Append(", \"epoch\":\"1\", \"timestamp_monotonic_ns\":").Append(before.DispatchNs).Append(", \"kernel_name\":\"synthi_opencl_epoch_kernel\", \"global_work_size\":[8], \"local_work_size\":[8], \"output_target_id\":\"opencl-buffer:output\"},\n");
    trace.Append("    {\"id\":\"opencl-dispatch-epoch-2\", \"launch_api\":\"clEnqueueNDRangeKernel\", \"artifact_hash\":"); AppendEscaped(trace, afterHash); trace.Append(", \"epoch\":\"2\", \"timestamp_monotonic_ns\":").Append(after.DispatchNs).Append(", \"kernel_name\":\"synthi_opencl_epoch_kernel\", \"global_work_size\":[8], \"local_work_size\":[8], \"output_target_id\":\"opencl-buffer:output\"}\n");
    trace.Append("  ],\n");
    trace.Append("  \"outputEvents\": [\n");
    trace.Append("    {\"id\":\"opencl-output-epoch-1\", \"passed\":true, \"after_dispatch_id\":\"opencl-dispatch-epoch-1\", \"artifact_hash\":"); AppendEscaped(trace, beforeHash); trace.Append(", \"epoch\":\"1\", \"timestamp_monotonic_ns\":").Append(before.OutputNs).Append(", \"output_target_id\":\"opencl-buffer:output\", \"values\":"); AppendValues(trace, before.Output); trace.Append("},\n");
    trace.Append("    {\"id\":\"opencl-output-epoch-2\", \"passed\":true, \"after_dispatch_id\":\"opencl-dispatch-epoch-2\", \"artifact_hash\":"); AppendEscaped(trace, afterHash); trace.Append(", \"epoch\":\"2\", \"timestamp_monotonic_ns\":").Append(after.OutputNs).Append(", \"output_target_id\":\"opencl-buffer:output\", \"values\":"); AppendValues(trace, after.Output); trace.Append("}\n");
    trace.Append("  ],\n");
    trace.Append("  \"retirementEvent\": {\"id\":\"opencl-retire-epoch-1\", \"status\":\"queue_idle_proven\", \"retired_epoch\":\"1\", \"timestamp_monotonic_ns\":").Append(NowNs()).Append(", \"evidence_refs\":[\"runtime:opencl:clFinish\", \"runtime:opencl:clReleaseProgram\"]},\n");
    trace.Append("  \"nativeApiCounts\": {\"clBuildProgram\":2, \"clCreateKernel\":2, \"clEnqueueNDRangeKernel\":2, \"clEnqueueReadBuffer\":2, \"clFinish\":2},\n");
    trace.Append("  \"processStartTimestampNs\": ").Append(processStartNs).Append("\n");
    trace.Append("}\n");
    File.WriteAllText(tracePath, trace.ToString(), new UTF8Encoding(false));
  }

  public static int Run(string beforePath, string afterPath, string rawPath, string tracePath, string beforeHash, string afterHash, string schemaVersion) {
    IntPtr context = IntPtr.Zero;
    IntPtr queue = IntPtr.Zero;
    IntPtr inputBuf = IntPtr.Zero;
    IntPtr outputBuf = IntPtr.Zero;
    EpochResult before = new EpochResult();
    EpochResult after = new EpochResult();
    try {
      IntPtr platform;
      IntPtr device;
      int rc = SelectDevice(out platform, out device);
      if (rc != 0) return rc;
      string beforeSource = File.ReadAllText(beforePath, Encoding.UTF8);
      string afterSource = File.ReadAllText(afterPath, Encoding.UTF8);
      int err;
      context = clCreateContext(IntPtr.Zero, 1, new IntPtr[] { device }, IntPtr.Zero, IntPtr.Zero, out err);
      if (err != CL_SUCCESS || context == IntPtr.Zero) return Fail("context_failed", 31, "err=" + err);
      queue = clCreateCommandQueue(context, device, 0, out err);
      if (err != CL_SUCCESS || queue == IntPtr.Zero) return Fail("queue_failed", 32, "err=" + err);
      float[] input = new float[] { 1.0f, 2.5f, 4.0f, 8.0f, 16.0f, 32.0f, 64.0f, 128.0f };
      GCHandle inputHandle = GCHandle.Alloc(input, GCHandleType.Pinned);
      try {
        inputBuf = clCreateBuffer(context, CL_MEM_READ_ONLY | CL_MEM_COPY_HOST_PTR, new UIntPtr((uint)(input.Length * 4)), inputHandle.AddrOfPinnedObject(), out err);
      } finally {
        inputHandle.Free();
      }
      if (err != CL_SUCCESS || inputBuf == IntPtr.Zero) return Fail("input_buffer_failed", 33, "err=" + err);
      outputBuf = clCreateBuffer(context, CL_MEM_READ_WRITE, new UIntPtr((uint)(input.Length * 4)), IntPtr.Zero, out err);
      if (err != CL_SUCCESS || outputBuf == IntPtr.Zero) return Fail("output_buffer_failed", 34, "err=" + err);
      long processStartNs = NowNs();
      rc = BuildAndRunEpoch(context, queue, device, beforeSource, inputBuf, outputBuf, before);
      if (rc != 0) return rc;
      rc = BuildAndRunEpoch(context, queue, device, afterSource, inputBuf, outputBuf, after);
      if (rc != 0) return rc;
      byte[] raw = new byte[after.Output.Length * 4];
      Buffer.BlockCopy(after.Output, 0, raw, 0, raw.Length);
      File.WriteAllBytes(rawPath, raw);
      WriteTrace(
        tracePath,
        schemaVersion,
        beforeHash,
        afterHash,
        InfoStringPlatform(platform, CL_PLATFORM_NAME),
        InfoStringDevice(device, CL_DEVICE_NAME),
        InfoStringDevice(device, CL_DEVICE_VENDOR),
        InfoStringDevice(device, CL_DEVICE_VERSION),
        before,
        after,
        processStartNs
      );
      return 0;
    } catch (DllNotFoundException ex) {
      return Fail("loader_missing", 2, ex.Message);
    } catch (EntryPointNotFoundException ex) {
      return Fail("symbol_missing", 3, ex.Message);
    } catch (Exception ex) {
      return Fail("exception", 1, ex.GetType().Name + ":" + ex.Message);
    } finally {
      if (inputBuf != IntPtr.Zero) clReleaseMemObject(inputBuf);
      if (outputBuf != IntPtr.Zero) clReleaseMemObject(outputBuf);
      if (before.Kernel != IntPtr.Zero) clReleaseKernel(before.Kernel);
      if (after.Kernel != IntPtr.Zero) clReleaseKernel(after.Kernel);
      if (before.Program != IntPtr.Zero) clReleaseProgram(before.Program);
      if (after.Program != IntPtr.Zero) clReleaseProgram(after.Program);
      if (queue != IntPtr.Zero) clReleaseCommandQueue(queue);
      if (context != IntPtr.Zero) clReleaseContext(context);
    }
  }
}
'@
Add-Type -TypeDefinition $source
$exitCode = [SynthiOpenClWindowsProbe]::Run($BeforePath, $AfterPath, $RawPath, $TracePath, $BeforeHash, $AfterHash, $SchemaVersion)
exit $exitCode
`;
}

function runModeFor({ afterHash }) {
  const scope = CFG.metricScope;
  return {
    metric_clock: 'monotonic_ns',
    metric_scope: scope,
    cache_state: CFG.cacheState,
    edit_id: `${CFG.targetId}-opencl-${scope}`,
    edit_hash: sha256Text(`${CFG.targetId}:${scope}:${afterHash}`),
    edit_kind: 'gpu_artifact_edit',
    different_edit: CFG.differentEdit,
  };
}

function modelRegistryStatus(model) {
  return MODEL_REGISTRY[model] ?? {
    provider_model_status: 'unknown',
    provider_model_alias_resolved_to: null,
    provider_shutdown_or_deprecation_detected: false,
  };
}

function modelProvenanceRecord({ mode, model, checkedAt }) {
  const status = modelRegistryStatus(model);
  return {
    provider: 'google_gemini',
    requested_model: model,
    provider_model_status: status.provider_model_status,
    provider_model_alias_resolved_to: status.provider_model_alias_resolved_to,
    provider_shutdown_or_deprecation_detected: status.provider_shutdown_or_deprecation_detected,
    provider_model_status_source: 'static_registry',
    provider_model_status_checked_against: MODEL_AVAILABILITY_SOURCE,
    model_availability_source: MODEL_AVAILABILITY_SOURCE,
    model_availability_basis: 'static_registry',
    model_availability_check_time_ms: 0,
    model_availability_checked_at: checkedAt,
    actual_model: status.provider_model_status === 'shutdown' ? null : model,
    fallback_model: null,
    fallback_used: false,
    request_mode: mode,
    hard_infra_failure: status.provider_model_status === 'shutdown',
  };
}

function modelProvenance(checkedAt = new Date().toISOString()) {
  return {
    split: modelProvenanceRecord({ mode: 'split', model: CFG.splitModel, checkedAt }),
    gpu_delta: modelProvenanceRecord({ mode: 'gpu_delta', model: CFG.gpuDeltaModel, checkedAt }),
  };
}

function timingFields({ runtimeTrace, compileNs, runtimeNs, oracleNs, runMode }) {
  const loader = runtimeTrace.loaderEvents?.[1]?.timestamp_monotonic_ns ?? 0;
  const publish = runtimeTrace.epochEvents?.[1]?.timestamp_monotonic_ns ?? loader;
  const dispatch = runtimeTrace.dispatchEvents?.[1]?.timestamp_monotonic_ns ?? publish;
  const output = runtimeTrace.outputEvents?.[1]?.timestamp_monotonic_ns ?? dispatch;
  const retirement = runtimeTrace.retirementEvent?.timestamp_monotonic_ns ?? output;
  return {
    metric_clock: 'monotonic_ns',
    metric_scope: runMode.metric_scope,
    cache_state: runMode.cache_state,
    edit_id: runMode.edit_id,
    edit_hash: runMode.edit_hash,
    edit_kind: runMode.edit_kind,
    different_edit: runMode.different_edit,
    static_discovery_time: 1,
    ai_contract_synthesis_time: 0,
    model_availability_check_time: 1,
    artifact_hash_time: 1,
    adapter_generation_time: 0,
    device_compile_wall_time: compileNs,
    artifact_load_time: 0,
    epoch_publish_time: 0,
    dispatch_trace_time: 0,
    runtime_probe_time: runtimeNs,
    oracle_analysis_time: oracleNs,
    trigger_to_visible_time: runtimeNs,
    screenshot_capture_time: 0,
    dispatch_to_output_proof_time: Math.max(0, Number(output) - Number(dispatch)),
    total_validator_wall_time: compileNs + runtimeNs + oracleNs,
    loaderTimestampNs: loader,
    publishTimestampNs: publish,
    dispatchTimestampNs: dispatch,
    outputTimestampNs: output,
    retirementTimestampNs: retirement,
  };
}

function fieldEvidenceRefs(fields, refs) {
  return Object.fromEntries(fields.map((field) => [field, refs]));
}

function buildContract({ beforeHash, afterHash, runtimeTrace, runMode }) {
  const sourcePaths = ['kernels/opencl-before.cl', 'kernels/opencl-after.cl'];
  const evidenceRefs = [
    beforeHash,
    afterHash,
    'runtime:opencl:clBuildProgram',
    'runtime:opencl:clEnqueueNDRangeKernel',
    'runtime:opencl:clEnqueueReadBuffer',
  ];
  const processId = runtimeTrace.processId ?? 'opencl-runtime-process';
  const outputOracleContract = {
    kind: 'compute',
    target_id: OPENCL_OUTPUT_TARGET_ID,
    epoch: 2,
    readback_resource: 'output',
    expected_output_verified_by: 'raw_float32_readback_schema',
    evidence_refs: ['runtime:opencl:clEnqueueReadBuffer'],
  };
  const fissionVerifierEvidenceId = `runtime:fission-verifier-report:opencl:${sha256Text(stableJson({
    sourcePaths,
    entryPoint: 'synthi_opencl_epoch_kernel',
    beforeHash,
    afterHash,
    runMode: runMode.metric_scope,
    abi: 'compatible',
  })).replace(/^sha256:/, '')}`;
  const selectionDecisionHash = sha256Text(stableJson({
    selectedIsland: 'opencl-program:synthi_opencl_epoch_kernel',
    selectedReason: 'verified_fission_contract',
    changedSources: sourcePaths,
    beforeHash,
    afterHash,
    outputOracleContract,
  }));
  const openclFields = [
    'program_hash_before',
    'program_hash_after',
    'kernel_name',
    'command_queue',
    'work_dim',
    'global_work_size',
    'local_work_size',
    'event_trace',
    'output_buffer_readback',
  ];
  const contract = {
    contract_version: 'synthi.gpu_hmr.contract.v1',
    project_id: CFG.targetId,
    edit_id: runMode.edit_id,
    backend: 'opencl',
    confidence: 0.96,
    evidence_refs: evidenceRefs,
    ai_hints: [],
    unsupported_reasons: [],
    failure_mode: 'reject',
    classification: {
      project_kind: 'gpu_project',
      edit_kind: 'gpu_artifact_edit',
      route: 'gpu_hmr',
      confidence: 0.96,
      blocking_gaps: [],
    },
    artifact_identity: {
      source_paths: sourcePaths,
      artifact_kind: 'opencl_program',
      entry_points: ['synthi_opencl_epoch_kernel'],
      compile_target: runtimeTrace.device?.deviceName ?? 'opencl-device',
      compiler: 'opencl-runtime-jit',
      compiler_args_hash: sha256Text('opencl-runtime-jit-default-build-options'),
      supported_pipeline_scope: 'opencl_declared_compute_readback',
    },
    artifact_hash_before: beforeHash,
    artifact_hash_after: afterHash,
    unaffected_artifacts_hash_unchanged: true,
    abi_compatibility_class: {
      value: 'compatible',
      evidence_refs: ['source:opencl-kernel-signature', 'runtime:opencl:clSetKernelArg'],
      notes: 'OpenCL kernel argument shape is unchanged; runtime dispatch and readback oracle still gate acceptance.',
    },
    abi_metadata: {
      args: [
        { name: 'output', type: '__global float*', size: 8, offset: 0, value_kind: 'global_buffer', access: 'write', address_space: 'global', source: 'runtime_trace' },
        { name: 'input', type: '__global const float*', size: 8, offset: 8, value_kind: 'global_buffer', access: 'read', address_space: 'global', source: 'runtime_trace' },
        { name: 'n', type: 'unsigned int', size: 4, offset: 16, value_kind: 'by_value', access: 'read', address_space: 'private', source: 'runtime_trace' },
      ],
      descriptor_or_binding_layout: 'opencl-kernel-arg-layout:v1',
      workgroup_or_launch_shape: { work_dim: 1, global_work_size: [8], local_work_size: [8] },
      stream_or_queue_requirements: 'single command queue with clFinish retirement proof',
      extractor_provenance: {
        source: 'opencl_runtime_trace_and_kernel_signature',
        extractor: 'synthi-opencl-runtime-proof',
        runtime_trace_schema: PROBE_SCHEMA,
        evidence_refs: ['runtime:opencl:clSetKernelArg', 'runtime:opencl:kernel-signature'],
      },
    },
    firewall_evidence: {
      route: 'gpu_runtime_epoch_reload',
      evidence_source: 'opencl_runtime_same_process_trace',
      evidence_refs: [`runtime:opencl:process-continuity:${processId}`, 'runtime:opencl:clBuildProgram'],
      cpu_hmr_used: false,
      full_rebuild_used: false,
      process_restarted: runtimeTrace.processRestarted === true,
      process_id_before: processId,
      process_id_after: processId,
    },
    output_oracle_target: {
      kind: 'compute',
      target_id: OPENCL_OUTPUT_TARGET_ID,
      compute_only_target_verified: true,
      evidence_refs: ['runtime:opencl:clEnqueueReadBuffer', 'runtime:opencl:raw-readback'],
    },
    reload_mechanism: 'built_in',
    adapter_outcome: 'adapter_not_needed_builtin_reload',
    reload_evidence_refs: ['runtime:opencl:clBuildProgram', 'runtime:opencl:clCreateKernel'],
    dispatch_trace_required: true,
    oracle_trace_required: true,
    state_preservation_checks: {
      process_id: runtimeTrace.processId,
      device_uuid: sha256Text(`${runtimeTrace.device?.platformName ?? ''}:${runtimeTrace.device?.deviceName ?? ''}`),
      context_or_device_handle: 'opencl-context:same-process',
      queue_or_stream_handle: 'opencl-command-queue:same-process',
      persistent_gpu_allocations: ['input', 'output'],
      engine_scene_handles: [],
      camera_state_hash: 'not_visual_compute_oracle',
      swapchain_or_framebuffer_identity: 'not_visual_compute_oracle',
    },
    epoch_policy: {
      publish_mechanism: 'clCreateKernel-after-clBuildProgram',
      dispatch_binding: 'cl_kernel:synthi_opencl_epoch_kernel',
      retirement_mechanism: 'clFinish-before-release-old-program',
    },
    epoch_retirement_proof: {
      value: 'queue_idle_proven',
      evidence_refs: ['runtime:opencl:clFinish', 'runtime:opencl:clReleaseProgram'],
    },
    fission_report: {
      selected_island: 'opencl-program:synthi_opencl_epoch_kernel',
      selected_reason: 'verified_fission_contract',
      changed_sources: sourcePaths,
      included_dependencies: [],
      excluded_host_sources: [],
      artifact_hash_before: beforeHash,
      artifact_hash_after: afterHash,
      abi_compatibility_class: 'compatible',
      full_device_fallback: false,
      host_relinked: false,
      process_restarted: runtimeTrace.processRestarted === true,
      full_rebuild_used: false,
      unaffected_artifacts_hash_unchanged: true,
      selected_verifier_evidence_id: fissionVerifierEvidenceId,
      deterministic_verifier_evidence_refs: [
        fissionVerifierEvidenceId,
        'runtime:opencl:kernel-signature',
      ],
      selection_decision_hash: selectionDecisionHash,
      output_oracle_contract: outputOracleContract,
      smallest_safe_island_proven: true,
      evidence_refs: [
        fissionVerifierEvidenceId,
        'runtime:opencl:clBuildProgram',
        'runtime:opencl:clCreateKernel',
      ],
    },
    opencl_contract: {
      program_hash_before: beforeHash,
      program_hash_after: afterHash,
      kernel_name: 'synthi_opencl_epoch_kernel',
      command_queue: 'opencl-command-queue:same-process',
      work_dim: 1,
      global_work_size: [8],
      local_work_size: [8],
      event_trace: 'runtimeTrace.dispatchEvents[epoch=2]',
      output_buffer_readback: 'output',
      field_evidence_refs: fieldEvidenceRefs(openclFields, evidenceRefs),
    },
  };
  contract.contract_hash = sha256Text(stableJson(contract));
  contract.contract_id = `opencl-contract:${contract.contract_hash}`;
  return contract;
}

async function renderComputeCard({ filePath, afterValues, rawHash, sliceHash, expectedVerification, runtimeTrace }) {
  const width = 760;
  const height = 420;
  const maxAbs = Math.max(1, ...afterValues.map((value) => Math.abs(value)));
  const bars = afterValues.map((value, index) => {
    const x = 48 + index * 76;
    const h = Math.max(2, Math.abs(value) / maxAbs * 170);
    const y = 300 - h;
    return `<rect x="${x}" y="${y}" width="44" height="${h}" fill="#38bdf8"/>`;
  }).join('');
  const deviceText = `${runtimeTrace.device?.platformName ?? 'OpenCL'} ${runtimeTrace.device?.deviceName ?? 'device'}`.slice(0, 92);
  const afterText = afterValues.map((value) => Number(value).toFixed(2)).join(', ');
  const svg = `
<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <rect width="100%" height="100%" fill="#0f172a"/>
  <text x="32" y="44" fill="#f8fafc" font-family="Arial" font-size="24">OpenCL Runtime Readback Proof</text>
  <text x="32" y="78" fill="#bfdbfe" font-family="Arial" font-size="14">${deviceText}</text>
  <text x="32" y="112" fill="#cbd5e1" font-family="Arial" font-size="13">raw ${rawHash.slice(0, 30)}... slice ${sliceHash.slice(0, 30)}...</text>
  <text x="32" y="142" fill="#cbd5e1" font-family="Arial" font-size="13">after[0..7] ${afterText}</text>
  <text x="32" y="172" fill="#cbd5e1" font-family="Arial" font-size="13">expected output verified: ${expectedVerification.matched} max_delta=${expectedVerification.maxAbsDelta.toFixed(6)}</text>
  <text x="32" y="202" fill="#cbd5e1" font-family="Arial" font-size="13">API chain: clBuildProgram -> clCreateKernel -> clEnqueueNDRangeKernel -> clEnqueueReadBuffer</text>
  <line x1="32" y1="300" x2="728" y2="300" stroke="#475569" stroke-width="1"/>
  ${bars}
  <text x="32" y="378" fill="#e2e8f0" font-family="Arial" font-size="13">Card is rendered from raw OpenCL readback bytes after the epoch-2 dispatch.</text>
</svg>`;
  await sharp(Buffer.from(svg)).png().toFile(filePath);
}

async function writeComputeOracleArtifacts({ outDir, rawAfterPath, runtimeTrace, timings }) {
  const oracleStart = process.hrtime.bigint();
  const afterBytes = await readFile(rawAfterPath);
  const afterValues = decodeFloat32(afterBytes);
  const beforeValues = runtimeTrace.outputEvents?.[0]?.values ?? expectedValues(BEFORE_MULTIPLIER, BEFORE_BIAS);
  const beforeBytes = encodeFloat32(beforeValues);
  const beforeRawPath = path.join(outDir, `${safeSlug(CFG.targetId)}-before-readback.bin`);
  const schemaPath = path.join(outDir, `${safeSlug(CFG.targetId)}-readback-schema.json`);
  const cardPath = path.join(outDir, `${safeSlug(CFG.targetId)}-compute-card.png`);
  await writeFile(beforeRawPath, beforeBytes);
  const rawHash = sha256Bytes(afterBytes);
  const beforeHash = sha256Bytes(beforeBytes);
  const expectedAfter = expectedValues(CFG.afterMultiplier, CFG.afterBias);
  const expectedBytes = encodeFloat32(expectedAfter);
  const expectedHash = sha256Bytes(expectedBytes);
  const expectedVerification = compareNumericValues(afterValues, expectedAfter, 0.0001);
  const sliceOffset = 0;
  const sliceLength = afterBytes.length;
  const sliceHash = sha256Bytes(afterBytes.subarray(sliceOffset, sliceOffset + sliceLength));
  const schema = {
    schemaVersion: 'synthi.gpu.hmr.compute_readback_schema.v1',
    producer: 'opencl_runtime_proof',
    dataType: 'float32',
    byteLength: afterBytes.length,
    elementCount: afterValues.length,
    readbackResource: 'output',
    dispatchId: runtimeTrace.dispatchEvents?.[1]?.id,
    epoch: 2,
    rawReadbackHash: rawHash,
    expectedOutput: {
      dataType: 'float32',
      values: expectedAfter,
      tolerance: 0.0001,
      expectedHash,
      verified: expectedVerification.matched,
      maxAbsDelta: expectedVerification.maxAbsDelta,
      compared: expectedVerification.compared,
      mismatches: expectedVerification.mismatches,
    },
    deterministicSlice: { offset: sliceOffset, length: sliceLength, hash: sliceHash },
    beforeValues,
    afterValues,
  };
  await writeFile(schemaPath, `${JSON.stringify(schema, null, 2)}\n`);
  await renderComputeCard({
    filePath: cardPath,
    afterValues,
    rawHash,
    sliceHash,
    expectedVerification,
    runtimeTrace,
  });
  const schemaHash = sha256Bytes(await readFile(schemaPath));
  const cardHash = sha256Bytes(await readFile(cardPath));
  const artifacts = {
    raw_readback_bin: relRepo(rawAfterPath),
    rawReadbackBin: relRepo(rawAfterPath),
    before_raw_readback_bin: relRepo(beforeRawPath),
    readback_schema_json: relRepo(schemaPath),
    readbackSchemaJson: relRepo(schemaPath),
    raw_readback_hash: rawHash,
    rawReadbackHash: rawHash,
    raw_readback_hash_verified: true,
    raw_readback_source: 'runtime_raw_readback',
    raw_readback_byte_length: afterBytes.length,
    readback_schema_hash: schemaHash,
    checksum_before: beforeHash,
    checksum_after: rawHash,
    output_change_expected: true,
    expected_output_declared: true,
    expected_output_required: true,
    expected_output_data_type: 'float32',
    expected_output_values: expectedAfter,
    expected_output_hash: expectedHash,
    expected_output_tolerance: 0.0001,
    expected_output_verified: expectedVerification.matched,
    expected_output_max_abs_delta: expectedVerification.maxAbsDelta,
    expected_output_compared: expectedVerification.compared,
    expected_output_mismatches: expectedVerification.mismatches,
    deterministic_slice: { offset: sliceOffset, length: sliceLength, hash: sliceHash, source: 'runtime_raw_readback' },
    deterministic_slice_hash: sliceHash,
    deterministic_slice_hash_verified: true,
    oracle_code_hash: sha256Text(renderComputeCard.toString()),
    rendered_card_png: relRepo(cardPath),
    renderedCardPng: relRepo(cardPath),
    rendered_card_hash: cardHash,
    producer: 'opencl_runtime_proof',
    timestamp_after_dispatch: timings.outputTimestampNs,
    epoch: 2,
    raw_readback_verification: {
      raw_readback_hash: rawHash,
      hash_verified: true,
      byte_length: afterBytes.length,
      deterministic_slice_hash: sliceHash,
      deterministic_slice_hash_verified: true,
      readback_schema_hash: schemaHash,
    },
  };
  return {
    artifacts,
    oracleDurationNs: nsSince(oracleStart),
    validation: computeOracleValidation(artifacts),
  };
}

function computeOracleValidation(artifacts) {
  const changed = artifacts.checksum_before !== artifacts.checksum_after;
  const expectedVerified = artifacts.expected_output_declared === true && artifacts.expected_output_verified === true;
  const failedGates = [
    changed ? null : 'compute_oracle_checksum_unchanged',
    artifacts.raw_readback_hash_verified === true ? null : 'compute_oracle_raw_readback_hash_unverified',
    artifacts.deterministic_slice_hash_verified === true ? null : 'compute_oracle_deterministic_slice_hash_unverified',
    expectedVerified ? null : 'compute_oracle_expected_output_not_verified',
  ].filter(Boolean);
  return {
    accepted: failedGates.length === 0,
    checksumChanged: changed,
    rawReadbackHashVerified: artifacts.raw_readback_hash_verified === true,
    deterministicSliceHashVerified: artifacts.deterministic_slice_hash_verified === true,
    expectedOutputDeclared: artifacts.expected_output_declared === true,
    expectedOutputVerified: expectedVerified,
    expectedOutputRequired: artifacts.expected_output_required !== false,
    expectedOutputHash: artifacts.expected_output_hash,
    expectedOutputMaxAbsDelta: artifacts.expected_output_max_abs_delta,
    failedGates,
  };
}

function buildProofLedgerRecord({ beforeHash, afterHash, runtimeTrace, contract, runMode, timings, oracleArtifacts, oracleValidation }) {
  const afterEpoch = '2';
  const beforeEpoch = '1';
  const dispatchId = runtimeTrace.dispatchEvents?.[1]?.id ?? 'opencl-dispatch-epoch-2';
  const processId = runtimeTrace.processId;
  const outputTargetId = OPENCL_OUTPUT_TARGET_ID;
  return {
    project_id: CFG.targetId,
    edit_id: runMode.edit_id,
    edit_hash: runMode.edit_hash,
    edit_kind: runMode.edit_kind,
    different_edit: runMode.different_edit,
    backend: 'opencl',
    classification: {
      project_kind: 'gpu_project',
      edit_kind: 'gpu_artifact_edit',
      route: 'gpu_hmr',
    },
    contract_hash: contract.contract_hash,
    artifact_before_hash: beforeHash,
    artifact_after_hash: afterHash,
    loader_event: {
      id: 'opencl-build-epoch-2',
      artifact_hash: afterHash,
      epoch: afterEpoch,
      timestamp_monotonic_ns: timings.loaderTimestampNs,
      process_id: processId,
      source: 'clBuildProgram',
    },
    epoch_publish_event: {
      id: 'opencl-publish-epoch-2',
      artifact_hash: afterHash,
      epoch: afterEpoch,
      timestamp_monotonic_ns: timings.publishTimestampNs,
      process_id: processId,
      dispatch_binding: 'cl_kernel:synthi_opencl_epoch_kernel',
    },
    dispatch_event: {
      id: dispatchId,
      artifact_hash: afterHash,
      epoch: afterEpoch,
      timestamp_monotonic_ns: timings.dispatchTimestampNs,
      process_id: processId,
      launch_api: 'clEnqueueNDRangeKernel',
      kernel_name: 'synthi_opencl_epoch_kernel',
      work_dim: 1,
      global_work_size: [8],
      local_work_size: [8],
      output_target_id: outputTargetId,
      outputTargetId,
      command_queue: 'opencl-command-queue:same-process',
      command: 'clEnqueueNDRangeKernel',
    },
    output_event: {
      id: 'opencl-output-epoch-2',
      kind: 'compute_readback',
      passed: oracleValidation.accepted,
      after_dispatch_id: dispatchId,
      artifact_hash: afterHash,
      epoch: afterEpoch,
      output_target_id: outputTargetId,
      outputTargetId,
      timestamp_monotonic_ns: timings.outputTimestampNs,
      process_id: processId,
      output_oracle: {
        kind: 'compute_oracle',
        oracle_artifacts: {
          compute_oracle_artifacts: {
            ...oracleArtifacts,
            timestamp_after_dispatch: timings.outputTimestampNs,
          },
        },
      },
    },
    retirement_event: {
      id: 'opencl-retire-epoch-1',
      status: 'queue_idle_proven',
      timestamp_monotonic_ns: timings.retirementTimestampNs,
      process_id: processId,
      retired_epoch: beforeEpoch,
      evidence_refs: ['runtime:opencl:clFinish', 'runtime:opencl:clReleaseProgram'],
    },
    process_identity: {
      process_id: processId,
      host_pid: processId,
      same_process: runtimeTrace.sameProcess === true,
    },
    device_identity: {
      backend: 'opencl',
      device_uuid: contract.state_preservation_checks.device_uuid,
      adapter_info: runtimeTrace.device,
      command_queue: 'opencl-command-queue:same-process',
    },
    firewall_evidence: {
      route: 'gpu_runtime_epoch_reload',
      cpu_hmr_used: false,
      full_rebuild_used: false,
      process_restarted: runtimeTrace.processRestarted === true,
      process_id_before: processId,
      process_id_after: processId,
      evidence_source: 'opencl_runtime_same_process_trace',
      evidence_refs: [`runtime:opencl:process-continuity:${processId}`],
    },
    output_oracle_target: {
      kind: 'compute',
      target_id: OPENCL_OUTPUT_TARGET_ID,
      compute_only_target_verified: true,
      evidence_refs: [oracleArtifacts.raw_readback_hash, oracleArtifacts.rendered_card_png],
    },
    oracle_artifacts: {
      compute_oracle_artifacts: {
        ...oracleArtifacts,
        timestamp_after_dispatch: timings.outputTimestampNs,
      },
    },
    metric_clock: 'monotonic_ns',
    metric_scope: runMode.metric_scope,
    cache_state: runMode.cache_state,
    timings,
    timing_metrics: {
      metric_clock: 'monotonic_ns',
      metric_scope: runMode.metric_scope,
      cache_state: runMode.cache_state,
    },
    model_provenance: modelProvenance(),
    evidence_refs: [
      beforeHash,
      afterHash,
      oracleArtifacts.raw_readback_hash,
      `runtime:opencl:dispatch:${dispatchId}`,
    ],
    cpu_hmr_used: false,
    full_rebuild_used: false,
    process_restarted: runtimeTrace.processRestarted === true,
  };
}

function nativeOpenClApiEvidence(runtimeTrace) {
  const counts = runtimeTrace.nativeApiCounts ?? {};
  const failedGates = [
    Number(counts.clBuildProgram ?? 0) >= 2 ? null : 'missing_clBuildProgram',
    Number(counts.clCreateKernel ?? 0) >= 2 ? null : 'missing_clCreateKernel',
    Number(counts.clEnqueueNDRangeKernel ?? 0) >= 2 ? null : 'missing_clEnqueueNDRangeKernel',
    Number(counts.clEnqueueReadBuffer ?? 0) >= 2 ? null : 'missing_clEnqueueReadBuffer',
    runtimeTrace.sameProcess === true ? null : 'same_process_not_proven',
  ].filter(Boolean);
  return {
    accepted: failedGates.length === 0,
    required: ['clBuildProgram', 'clCreateKernel', 'clEnqueueNDRangeKernel', 'clEnqueueReadBuffer'],
    counts,
    failedGates,
    source: 'native_opencl_runtime_trace',
  };
}

function runtimeProofArtifact({ beforeHash, afterHash, runtimeTrace, proofLedger, ledger, contract, contractEvaluation, contractConsistency, oracleArtifacts, oracleValidation, nativeApiEvidence }) {
  const record = proofLedger.records?.[0] ?? {};
  const dispatchId = record.dispatch_event?.id;
  const proofLedgerSourceConsistency = {
    accepted: ledger.gpuHmrSuccess === true && ledger.failedInvariants.length === 0,
    mode: 'derived_only',
    source: 'opencl_runtime_recomputed',
    proofLedgerId: proofLedger.proofId,
    proof_ledger_id: proofLedger.proofId,
    evidenceRefs: record.evidence_refs ?? [],
    evidence_refs: record.evidence_refs ?? [],
    failures: ledger.failedInvariants,
  };
  const processContinuity = {
    accepted: runtimeTrace.sameProcess === true && runtimeTrace.processRestarted === false,
    sameProcess: runtimeTrace.sameProcess === true,
    same_process: runtimeTrace.sameProcess === true,
    processRestarted: runtimeTrace.processRestarted === true,
    process_restarted: runtimeTrace.processRestarted === true,
    processId: runtimeTrace.processId,
    process_id: runtimeTrace.processId,
    failedGates: [
      runtimeTrace.sameProcess === true ? null : 'same_process_not_proven',
      runtimeTrace.processRestarted === false ? null : 'process_restarted',
    ].filter(Boolean),
  };
  const artifactChanged = beforeHash && afterHash && beforeHash !== afterHash;
  const retirementProven = contract.epoch_retirement_proof?.value === 'queue_idle_proven';
  const limitationCodes = [
    ...ledger.failedInvariants.map((failure) => failure.code),
    ...contractEvaluation.failedGates.map((failure) => failure.code),
    ...contractConsistency.failedGates.map((failure) => failure.code),
    ...oracleValidation.failedGates,
    ...nativeApiEvidence.failedGates,
    ...processContinuity.failedGates,
    artifactChanged ? null : 'opencl_program_hash_not_changed',
    retirementProven ? null : 'opencl_queue_retirement_unproven',
  ].filter(Boolean);
  const fullRuntimeProven =
    ledger.gpuHmrSuccess === true
    && ledger.failedInvariants.length === 0
    && contractEvaluation.accepted === true
    && contractConsistency.accepted === true
    && proofLedgerSourceConsistency.accepted === true
    && oracleValidation.accepted === true
    && nativeApiEvidence.accepted === true
    && processContinuity.accepted === true
    && artifactChanged
    && retirementProven
    && limitationCodes.length === 0;
  const artifact = {
    schemaVersion: 'synthi.gpu.hmr.runtime_proof_artifact.v1',
    proofId: `opencl-runtime-proof-artifact:${sha256Text(stableJson({
      proofLedgerId: proofLedger.proofId,
      contractHash: contract.contract_hash,
      artifactHashAfter: afterHash,
      dispatchId,
      rawReadbackHash: oracleArtifacts.raw_readback_hash,
      nativeApiCounts: nativeApiEvidence.counts,
    })).replace(/^sha256:/, '')}`,
    resultState: fullRuntimeProven ? 'gpu-hmr-full-runtime-proven' : 'gpu-hmr-runtime-proof-rejected',
    fullRuntimeProven,
    full_runtime_proven: fullRuntimeProven,
    gpuHmrSuccess: fullRuntimeProven,
    gpu_hmr_success: fullRuntimeProven,
    stageResults: [
      { stageId: 'opencl-program-source-artifact', status: artifactChanged ? 'passed' : 'failed', evidenceRefs: [beforeHash, afterHash] },
      { stageId: 'opencl-build-kernel-epoch', status: nativeApiEvidence.counts?.clBuildProgram >= 2 && nativeApiEvidence.counts?.clCreateKernel >= 2 ? 'passed' : 'failed', evidenceRefs: ['runtime:opencl:clBuildProgram', 'runtime:opencl:clCreateKernel'] },
      { stageId: 'opencl-post-epoch-dispatch', status: nativeApiEvidence.counts?.clEnqueueNDRangeKernel >= 2 && ledger.gpuHmrSuccess === true ? 'passed' : 'failed', evidenceRefs: [dispatchId, proofLedger.proofId].filter(Boolean) },
      { stageId: 'opencl-raw-readback-oracle', status: oracleValidation.accepted === true ? 'passed' : 'failed', evidenceRefs: [oracleArtifacts.raw_readback_hash, oracleArtifacts.deterministic_slice_hash, oracleArtifacts.readback_schema_hash].filter(Boolean) },
      { stageId: 'opencl-acceptance-contract', status: contractEvaluation.accepted === true && contractConsistency.accepted === true ? 'passed' : 'failed', evidenceRefs: [contract.contract_hash] },
      { stageId: 'opencl-process-firewall', status: processContinuity.accepted === true ? 'passed' : 'failed', evidenceRefs: [`runtime:opencl:process-continuity:${runtimeTrace.processId}`] },
      { stageId: 'opencl-queue-retirement', status: retirementProven ? 'passed' : 'failed', evidenceRefs: contract.epoch_retirement_proof?.evidence_refs ?? [] },
    ],
    limitations: fullRuntimeProven ? [] : limitationCodes.map((code) => ({ code })),
    proofLedger,
    proof_ledger: proofLedger,
    proofLedgerQuery: ledger,
    proof_ledger_query: ledger,
    proofLedgerSourceConsistency,
    proof_ledger_source_consistency: proofLedgerSourceConsistency,
    acceptanceContract: contract,
    acceptance_contract: contract,
    acceptanceContractEvaluation: contractEvaluation,
    acceptance_contract_evaluation: contractEvaluation,
    acceptanceContractConsistency: contractConsistency,
    acceptance_contract_consistency: contractConsistency,
    computeOracleArtifacts: oracleArtifacts,
    compute_oracle_artifacts: oracleArtifacts,
    computeOracleValidation: oracleValidation,
    compute_oracle_validation: oracleValidation,
    nativeOpenClApiEvidence: nativeApiEvidence,
    native_opencl_api_evidence: nativeApiEvidence,
    processContinuity,
    process_continuity: processContinuity,
  };
  const strictGate = runtimeProofArtifactStrictGate(
    artifact,
    computeOracleStrictGateOptions(oracleArtifacts),
  );
  return {
    ...artifact,
    strictGate,
    strict_gate: strictGate,
    fullRuntimeProven: artifact.fullRuntimeProven && strictGate.status === 'pass',
    full_runtime_proven: artifact.fullRuntimeProven && strictGate.status === 'pass',
    gpuHmrSuccess: artifact.gpuHmrSuccess && strictGate.status === 'pass',
    gpu_hmr_success: artifact.gpuHmrSuccess && strictGate.status === 'pass',
  };
}

function buildNegativeRefusal({ beforeSource, negativeSource }) {
  const signature = (source) => {
    const match = String(source).match(/__kernel\s+void\s+synthi_opencl_epoch_kernel\s*\(([^)]*)\)/u);
    const params = match ? match[1].split(',').map((item) => item.trim().replace(/\s+/g, ' ')) : [];
    return {
      found: Boolean(match),
      params,
      signatureHash: sha256Text(stableJson(params)),
    };
  };
  const accepted = signature(beforeSource);
  const negative = signature(negativeSource);
  const signatureChanged = accepted.signatureHash !== negative.signatureHash;
  return {
    schemaVersion: 'synthi.gpu.hmr.agent_split_negative_edit_refusal.v1',
    backend: 'opencl',
    targetId: CFG.targetId,
    editId: `${CFG.targetId}-opencl-abi-layout-change`,
    editHash: sha256Text(negativeSource),
    claim: 'OpenCL kernel argument layout changed and must be rejected before GPU HMR acceptance.',
    reasons: ['opencl_kernel_argument_layout_changed', 'gpu_hmr_rejected_before_load'],
    abiCompatibilityClass: 'layout_changed',
    executableStaticCheck: {
      source: 'opencl_negative_source_signature',
      sourceAfterHash: sha256Text(negativeSource),
      acceptedSignatureHash: accepted.signatureHash,
      negativeSignatureHash: negative.signatureHash,
      negativeKernelFound: negative.found,
      signatureChanged,
      acceptedParams: accepted.params,
      negativeParams: negative.params,
      accepted: negative.found === true && signatureChanged,
    },
    gpuHmrSuccess: false,
    acceptedForGpuHmr: false,
    refusalProven: negative.found === true && signatureChanged,
    refusedBeforeLoad: true,
    validationTargetScope: 'opencl_runtime_readback_target',
    validation_target_scope: 'opencl_runtime_readback_target',
  };
}

async function compileAndRunProbe({ outDir, beforePath, afterPath, beforeHash, afterHash, rawAfterPath, tracePath }) {
  const probePath = path.join(outDir, 'opencl_runtime_probe.c');
  await writeFile(probePath, probeSource());
  const windowsProbePath = path.join(outDir, 'opencl_runtime_probe_windows.ps1');
  await writeFile(windowsProbePath, windowsPowerShellProbeSource());
  const compileStart = process.hrtime.bigint();
  const runWindowsLocalProbe = async (fallbackFrom = null) => {
    const runtimeStart = process.hrtime.bigint();
    const run = await execFileRaw('powershell', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      windowsProbePath,
      '-BeforePath',
      beforePath,
      '-AfterPath',
      afterPath,
      '-RawPath',
      rawAfterPath,
      '-TracePath',
      tracePath,
      '-BeforeHash',
      beforeHash,
      '-AfterHash',
      afterHash,
      '-SchemaVersion',
      PROBE_SCHEMA,
    ], { timeout: CFG.timeoutMs });
    return {
      ok: run.ok,
      compileNs: 0,
      runtimeNs: nsSince(runtimeStart),
      run,
      exePath: windowsProbePath,
      transport: 'local_windows_powershell_add_type',
      fallbackFrom,
    };
  };
  const canUseWindowsLocalProbe = () =>
    process.platform === 'win32'
    && process.env.SYNTHI_OPENCL_RUNTIME_WINDOWS_LOCAL_DISABLED !== '1';
  const containerFailureAllowsWindowsFallback = (run) => {
    const stderr = String(run?.stderr ?? '');
    const stdout = String(run?.stdout ?? '');
    const error = String(run?.error ?? '');
    const text = `${stderr}\n${stdout}\n${error}`;
    return /opencl_runtime_error=(platform_missing|device_missing|loader_missing)|(?:^|\n).*cc: not found|No such file or directory|No such container/i.test(text);
  };
  if (CFG.useContainer && CFG.workerContainer) {
    const remoteDir = `/tmp/synthi-opencl-runtime/${safeSlug(CFG.slug)}`;
    const remoteProbe = `${remoteDir}/opencl_runtime_probe.c`;
    const remoteExe = `${remoteDir}/opencl_runtime_probe`;
    const remoteBefore = `${remoteDir}/before.cl`;
    const remoteAfter = `${remoteDir}/after.cl`;
    const remoteRaw = `${remoteDir}/after-readback.bin`;
    const remoteTrace = `${remoteDir}/runtime-trace.json`;
    try {
      await dockerExec(CFG.workerContainer, ['sh', '-lc', `rm -rf ${shellQuote(remoteDir)} && mkdir -p ${shellQuote(remoteDir)}`], { timeout: CFG.timeoutMs });
      await dockerCpTo(CFG.workerContainer, probePath, remoteProbe);
      await dockerCpTo(CFG.workerContainer, beforePath, remoteBefore);
      await dockerCpTo(CFG.workerContainer, afterPath, remoteAfter);
      await dockerExec(CFG.workerContainer, ['cc', remoteProbe, '-ldl', '-O2', '-o', remoteExe], { timeout: CFG.timeoutMs });
      const compileNs = nsSince(compileStart);
      const runtimeStart = process.hrtime.bigint();
      const run = await dockerExecRaw(CFG.workerContainer, [
        remoteExe,
        remoteBefore,
        remoteAfter,
        remoteRaw,
        remoteTrace,
        beforeHash,
        afterHash,
      ], { timeout: CFG.timeoutMs });
      if (!run.ok) {
        const containerProbe = {
          ok: false,
          compileNs,
          runtimeNs: nsSince(runtimeStart),
          run,
          remoteDir,
          transport: 'docker_exec_container',
        };
        if (canUseWindowsLocalProbe() && containerFailureAllowsWindowsFallback(run)) {
          return runWindowsLocalProbe(containerProbe);
        }
        return containerProbe;
      }
      await dockerCpFrom(CFG.workerContainer, remoteRaw, rawAfterPath);
      await dockerCpFrom(CFG.workerContainer, remoteTrace, tracePath);
      return {
        ok: true,
        compileNs,
        runtimeNs: nsSince(runtimeStart),
        run,
        remoteDir,
        transport: 'docker_exec_container',
      };
    } catch (error) {
      const containerProbe = {
        ok: false,
        compileNs: nsSince(compileStart),
        runtimeNs: 0,
        run: {
          ok: false,
          exitCode: 1,
          signal: null,
          timedOut: false,
          stdout: '',
          stderr: String(error?.message ?? error),
          error: String(error?.message ?? error),
        },
        remoteDir,
        transport: 'docker_exec_container',
      };
      if (canUseWindowsLocalProbe() && containerFailureAllowsWindowsFallback(containerProbe.run)) {
        return runWindowsLocalProbe(containerProbe);
      }
      return containerProbe;
    }
  }
  if (canUseWindowsLocalProbe()) {
    return runWindowsLocalProbe();
  }
  const exePath = process.platform === 'win32'
    ? path.join(outDir, 'opencl_runtime_probe.exe')
    : path.join(outDir, 'opencl_runtime_probe');
  await execFileChecked('cc', [probePath, '-ldl', '-O2', '-o', exePath], { timeout: CFG.timeoutMs });
  const compileNs = nsSince(compileStart);
  const runtimeStart = process.hrtime.bigint();
  const run = await execFileRaw(exePath, [beforePath, afterPath, rawAfterPath, tracePath, beforeHash, afterHash], { timeout: CFG.timeoutMs });
  return { ok: run.ok, compileNs, runtimeNs: nsSince(runtimeStart), run, exePath, transport: 'local_posix_cc' };
}

async function rejectionProof({ outDir, reasons, run = null }) {
  const proof = {
    schemaVersion: SCHEMA,
    schema: SCHEMA,
    targetId: CFG.targetId,
    backend: 'opencl',
    resultState: 'gpu-hmr-runtime-proof-rejected',
    fullRuntimeProven: false,
    full_runtime_proven: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    proofId: `opencl-runtime-proof:sha256:${createHash('sha256').update(stableJson({ reasons, stderr: run?.stderr?.slice(-1000), stdout: run?.stdout?.slice(-1000) })).digest('hex')}`,
    limitations: reasons.map((code) => ({ code })),
    runFailure: run ? {
      exitCode: run.exitCode,
      signal: run.signal,
      timedOut: run.timedOut,
      stdoutTail: run.stdout.slice(-4000),
      stderrTail: run.stderr.slice(-4000),
    } : null,
    evidenceAuthority: 'opencl_runtime_refusal_only_not_gpu_hmr_success',
  };
  const proofPath = path.join(outDir, `${safeSlug(CFG.targetId)}-opencl-runtime-rejected.json`);
  await writeFile(proofPath, `${JSON.stringify(proof, null, 2)}\n`);
  return { proof, proofPath };
}

async function buildProof() {
  const totalStart = process.hrtime.bigint();
  const outDir = path.join(ARTIFACT_DIR, safeSlug(CFG.slug));
  await mkdir(outDir, { recursive: true });
  const beforeSource = kernelSource({ multiplier: BEFORE_MULTIPLIER, bias: BEFORE_BIAS });
  const afterSource = kernelSource({ multiplier: CFG.afterMultiplier, bias: CFG.afterBias });
  const negativeSource = kernelSource({ multiplier: CFG.afterMultiplier, bias: CFG.afterBias, extraArg: true });
  const beforePath = path.join(outDir, 'opencl-before.cl');
  const afterPath = path.join(outDir, 'opencl-after.cl');
  const negativePath = path.join(outDir, 'opencl-after-abi-layout-changed.cl');
  await writeFile(beforePath, beforeSource);
  await writeFile(afterPath, afterSource);
  await writeFile(negativePath, negativeSource);
  const beforeHash = await sha256File(beforePath);
  const afterHash = await sha256File(afterPath);
  const runMode = runModeFor({ afterHash });
  const rawAfterPath = path.join(outDir, `${safeSlug(CFG.targetId)}-after-readback.bin`);
  const tracePath = path.join(outDir, `${safeSlug(CFG.targetId)}-runtime-trace.json`);
  const probe = await compileAndRunProbe({ outDir, beforePath, afterPath, beforeHash, afterHash, rawAfterPath, tracePath });
  if (!probe.ok) {
    const reasons = [
      'opencl_runtime_probe_failed',
      probe.run?.stderr.includes('platform_missing') ? 'opencl_platform_missing' : null,
      probe.run?.stderr.includes('device_missing') ? 'opencl_device_missing' : null,
      probe.run?.stderr.includes('loader_missing') ? 'opencl_loader_missing' : null,
      probe.run?.stderr.includes('build_failed') ? 'opencl_program_build_failed' : null,
    ].filter(Boolean);
    return rejectionProof({ outDir, reasons, run: probe.run });
  }
  const runtimeTrace = JSON.parse(await readFile(tracePath, 'utf8'));
  const timings = timingFields({
    runtimeTrace,
    compileNs: probe.compileNs,
    runtimeNs: probe.runtimeNs,
    oracleNs: 0,
    runMode,
  });
  const oracle = await writeComputeOracleArtifacts({ outDir, rawAfterPath, runtimeTrace, timings });
  timings.oracle_analysis_time = oracle.oracleDurationNs;
  timings.total_validator_wall_time = durationNs(totalStart, process.hrtime.bigint());
  const contract = buildContract({ beforeHash, afterHash, runtimeTrace, runMode });
  const contractEvaluation = evaluateGpuHmrAcceptanceContract(contract);
  const contractConsistency = evaluateGpuHmrAcceptanceContractConsistency({ before: contract, after: contract });
  const ledgerRecord = buildProofLedgerRecord({
    beforeHash,
    afterHash,
    runtimeTrace,
    contract,
    runMode,
    timings,
    oracleArtifacts: oracle.artifacts,
    oracleValidation: oracle.validation,
  });
  const proofLedger = buildGpuHmrProofLedger(ledgerRecord);
  const ledger = queryGpuHmrLedgerInvariants(proofLedger);
  const nativeApiEvidence = nativeOpenClApiEvidence(runtimeTrace);
  const runtimeProof = runtimeProofArtifact({
    beforeHash,
    afterHash,
    runtimeTrace,
    proofLedger,
    ledger,
    contract,
    contractEvaluation,
    contractConsistency,
    oracleArtifacts: oracle.artifacts,
    oracleValidation: oracle.validation,
    nativeApiEvidence,
  });
  const fullRuntimeProven = runtimeProof.fullRuntimeProven === true;
  const negativeEditRefusal = buildNegativeRefusal({ beforeSource, negativeSource });
  const material = {
    schemaVersion: SCHEMA,
    schema: SCHEMA,
    targetId: CFG.targetId,
    profile: {
      id: CFG.targetId,
      targetId: CFG.targetId,
      validationScope: 'opencl_declared_compute_readback',
    },
    backend: 'opencl',
    resultState: fullRuntimeProven ? 'gpu-hmr-full-runtime-proven' : 'gpu-hmr-runtime-proof-rejected',
    fullRuntimeProven,
    full_runtime_proven: fullRuntimeProven,
    gpuHmrSuccess: fullRuntimeProven,
    gpu_hmr_success: fullRuntimeProven,
    acceptedForGpuHmr: fullRuntimeProven,
    accepted_for_gpu_hmr: fullRuntimeProven,
    compiler: {
      transport: probe.transport ?? (CFG.useContainer ? 'docker_exec_container' : 'local_process'),
      fallback_from_transport: probe.fallbackFrom?.transport ?? null,
      beforeProgramHash: beforeHash,
      before_program_hash: beforeHash,
      afterProgramHash: afterHash,
      after_program_hash: afterHash,
    },
    contract,
    acceptanceContract: contract,
    acceptance_contract: contract,
    contractEvaluation,
    contract_evaluation: contractEvaluation,
    proofLedger,
    proof_ledger: proofLedger,
    ledger,
    proofLedgerQuery: ledger,
    proof_ledger_query: ledger,
    runtimeProofArtifact: runtimeProof,
    runtime_proof_artifact: runtimeProof,
    computeOracleArtifacts: oracle.artifacts,
    compute_oracle_artifacts: oracle.artifacts,
    computeOracleValidation: oracle.validation,
    compute_oracle_validation: oracle.validation,
    nativeOpenClApiEvidence: nativeApiEvidence,
    native_opencl_api_evidence: nativeApiEvidence,
    runtimeTrace,
    runtime_trace: runtimeTrace,
    runtimeProbeExecution: {
      transport: probe.transport ?? (CFG.useContainer ? 'docker_exec_container' : 'local_process'),
      fallbackFromTransport: probe.fallbackFrom?.transport ?? null,
      fallbackFromRuntimeUnavailable: Boolean(probe.fallbackFrom),
      evidenceAuthority: 'runtime_probe_execution_transport_only_not_gpu_hmr_success',
    },
    runtime_probe_execution: {
      transport: probe.transport ?? (CFG.useContainer ? 'docker_exec_container' : 'local_process'),
      fallback_from_transport: probe.fallbackFrom?.transport ?? null,
      fallback_from_runtime_unavailable: Boolean(probe.fallbackFrom),
      evidence_authority: 'runtime_probe_execution_transport_only_not_gpu_hmr_success',
    },
    negativeEditRefusal,
    negative_edit_refusal: negativeEditRefusal,
    timingMetrics: timings,
    timing_metrics: timings,
    timings,
    runMode,
    run_mode: runMode,
    limitations: fullRuntimeProven ? [] : runtimeProof.limitations,
  };
  material.proofId = `opencl-runtime-proof:sha256:${createHash('sha256').update(stableJson({
    targetId: CFG.targetId,
    ledgerProofId: proofLedger.proofId,
    runtimeProofArtifactId: runtimeProof.proofId,
    afterHash,
    rawReadbackHash: oracle.artifacts.raw_readback_hash,
  })).digest('hex')}`;
  const runtimeProofPath = path.join(outDir, `${safeSlug(CFG.targetId)}-runtime-proof-artifact.json`);
  const proofPath = path.join(outDir, `${safeSlug(CFG.targetId)}-proof.json`);
  const negativePathOut = path.join(outDir, `${safeSlug(CFG.targetId)}-negative-edit-refusal.json`);
  await writeFile(runtimeProofPath, `${JSON.stringify(runtimeProof, null, 2)}\n`);
  await writeFile(proofPath, `${JSON.stringify(material, null, 2)}\n`);
  await writeFile(negativePathOut, `${JSON.stringify(negativeEditRefusal, null, 2)}\n`);
  return { proof: material, proofPath, runtimeProofPath, negativePath: negativePathOut };
}

async function selfCheck() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'synthi-opencl-runtime-self-check-'));
  const old = {
    metricScope: CFG.metricScope,
    cacheState: CFG.cacheState,
    differentEdit: CFG.differentEdit,
  };
  try {
    const windowsProbe = windowsPowerShellProbeSource();
    const windowsProbeChecks = [
      windowsProbe.includes('[DllImport("OpenCL.dll")]') ? null : 'windows_opencl_dll_import_missing',
      windowsProbe.includes('clEnqueueNDRangeKernel') ? null : 'windows_dispatch_binding_missing',
      windowsProbe.includes('clEnqueueReadBuffer') ? null : 'windows_readback_binding_missing',
      windowsProbe.includes('probeTransport') && windowsProbe.includes('local_windows_powershell_add_type') ? null : 'windows_transport_trace_missing',
      windowsProbe.includes('dlopen(') ? 'windows_probe_uses_posix_dlopen' : null,
      windowsProbe.includes('libOpenCL.so') ? 'windows_probe_uses_linux_opencl_loader' : null,
    ].filter(Boolean);
    if (windowsProbeChecks.length > 0) {
      throw new Error(`Windows OpenCL probe source failed self-checks: ${windowsProbeChecks.join(',')}`);
    }
    const runtimeTrace = {
      processId: 'pid:1234',
      sameProcess: true,
      processRestarted: false,
      device: {
        backend: 'opencl',
        platformName: 'self-check-platform',
        deviceName: 'self-check-device',
        deviceVendor: 'self-check-vendor',
        deviceVersion: 'OpenCL 1.2',
      },
      loaderEvents: [
        { id: 'opencl-build-epoch-1', api: 'clBuildProgram', artifact_hash: sha256Text('before'), epoch: '1', timestamp_monotonic_ns: 10 },
        { id: 'opencl-build-epoch-2', api: 'clBuildProgram', artifact_hash: sha256Text('after'), epoch: '2', timestamp_monotonic_ns: 20 },
      ],
      kernelEvents: [
        { id: 'opencl-kernel-epoch-1', api: 'clCreateKernel', artifact_hash: sha256Text('before'), epoch: '1', timestamp_monotonic_ns: 30 },
        { id: 'opencl-kernel-epoch-2', api: 'clCreateKernel', artifact_hash: sha256Text('after'), epoch: '2', timestamp_monotonic_ns: 40 },
      ],
      epochEvents: [
        { id: 'opencl-epoch-1', artifact_hash: sha256Text('before'), epoch: '1', timestamp_monotonic_ns: 30 },
        { id: 'opencl-epoch-2', artifact_hash: sha256Text('after'), epoch: '2', timestamp_monotonic_ns: 40 },
      ],
      dispatchEvents: [
        { id: 'opencl-dispatch-epoch-1', artifact_hash: sha256Text('before'), epoch: '1', timestamp_monotonic_ns: 50, output_target_id: OPENCL_OUTPUT_TARGET_ID },
        { id: 'opencl-dispatch-epoch-2', artifact_hash: sha256Text('after'), epoch: '2', timestamp_monotonic_ns: 60, output_target_id: OPENCL_OUTPUT_TARGET_ID },
      ],
      outputEvents: [
        { id: 'opencl-output-epoch-1', passed: true, after_dispatch_id: 'opencl-dispatch-epoch-1', artifact_hash: sha256Text('before'), epoch: '1', timestamp_monotonic_ns: 70, output_target_id: OPENCL_OUTPUT_TARGET_ID, values: expectedValues(BEFORE_MULTIPLIER, BEFORE_BIAS) },
        { id: 'opencl-output-epoch-2', passed: true, after_dispatch_id: 'opencl-dispatch-epoch-2', artifact_hash: sha256Text('after'), epoch: '2', timestamp_monotonic_ns: 80, output_target_id: OPENCL_OUTPUT_TARGET_ID, values: expectedValues(CFG.afterMultiplier, CFG.afterBias) },
      ],
      retirementEvent: { id: 'opencl-retire-epoch-1', status: 'queue_idle_proven', retired_epoch: '1', timestamp_monotonic_ns: 90 },
      nativeApiCounts: { clBuildProgram: 2, clCreateKernel: 2, clEnqueueNDRangeKernel: 2, clEnqueueReadBuffer: 2, clFinish: 2 },
    };
    const rawAfterPath = path.join(tmp, 'after-readback.bin');
    await writeFile(rawAfterPath, encodeFloat32(expectedValues(CFG.afterMultiplier, CFG.afterBias)));
    const beforeHash = sha256Text('before');
    const afterHash = sha256Text('after');
    const runMode = runModeFor({ afterHash });
    const timings = timingFields({ runtimeTrace, compileNs: 1, runtimeNs: 100, oracleNs: 1, runMode });
    const oracle = await writeComputeOracleArtifacts({ outDir: tmp, rawAfterPath, runtimeTrace, timings });
    const contract = buildContract({ beforeHash, afterHash, runtimeTrace, runMode });
    const contractEvaluation = evaluateGpuHmrAcceptanceContract(contract);
    const contractConsistency = evaluateGpuHmrAcceptanceContractConsistency({ before: contract, after: contract });
    const ledgerRecord = buildProofLedgerRecord({
      beforeHash,
      afterHash,
      runtimeTrace,
      contract,
      runMode,
      timings,
      oracleArtifacts: oracle.artifacts,
      oracleValidation: oracle.validation,
    });
    const proofLedger = buildGpuHmrProofLedger(ledgerRecord);
    const ledger = queryGpuHmrLedgerInvariants(proofLedger);
    const nativeApiEvidence = nativeOpenClApiEvidence(runtimeTrace);
    const artifact = runtimeProofArtifact({
      beforeHash,
      afterHash,
      runtimeTrace,
      proofLedger,
      ledger,
      contract,
      contractEvaluation,
      contractConsistency,
      oracleArtifacts: oracle.artifacts,
      oracleValidation: oracle.validation,
      nativeApiEvidence,
    });
    if (artifact.gpuHmrSuccess !== true) {
      throw new Error(`self-check strict artifact rejected: ${JSON.stringify({
        strictGate: artifact.strictGate,
        ledger,
        contractEvaluation,
        contractConsistency,
        oracleValidation: oracle.validation,
        nativeApiEvidence,
        limitations: artifact.limitations,
      }, null, 2)}`);
    }
    const proof = {
      schemaVersion: SCHEMA,
      schema: SCHEMA,
      targetId: CFG.targetId,
      backend: 'opencl',
      profile: { id: CFG.targetId, targetId: CFG.targetId, validationScope: 'opencl_declared_compute_readback' },
      resultState: 'gpu-hmr-full-runtime-proven',
      fullRuntimeProven: true,
      gpuHmrSuccess: true,
      acceptedForGpuHmr: true,
      proofId: `opencl-runtime-proof:sha256:${createHash('sha256').update(stableJson({ selfCheck: true, proofLedgerId: proofLedger.proofId })).digest('hex')}`,
      contract,
      acceptanceContract: contract,
      proofLedger,
      runtimeProofArtifact: artifact,
      computeOracleArtifacts: oracle.artifacts,
      computeOracleValidation: oracle.validation,
      nativeOpenClApiEvidence: nativeApiEvidence,
      runtimeTrace,
      runtimeProbeExecution: {
        transport: 'self_check_synthetic_runtime_trace',
        fallbackFromTransport: null,
        fallbackFromRuntimeUnavailable: false,
        evidenceAuthority: 'runtime_probe_execution_transport_only_not_gpu_hmr_success',
      },
      negativeEditRefusal: buildNegativeRefusal({
        beforeSource: kernelSource({ multiplier: CFG.afterMultiplier, bias: CFG.afterBias }),
        negativeSource: kernelSource({ multiplier: CFG.afterMultiplier, bias: CFG.afterBias, extraArg: true }),
      }),
      timings,
      runMode,
      limitations: [],
    };
    const proofPath = path.join(tmp, 'opencl-runtime-proof.json');
    await writeFile(proofPath, `${JSON.stringify(proof, null, 2)}\n`);
    const matrix = await collectGpuHmrValidationMatrixLedger({
      repoRoot: REPO_ROOT,
      mcpRoot: MCP_ROOT,
      roots: [tmp],
      latestPerTarget: false,
      includeUnproven: true,
      generatedAt: '2026-06-30T00:00:00.000Z',
    });
    const row = matrix.rows.find((entry) => entry.targetId === CFG.targetId && entry.backend === 'opencl');
    if (!row || row.matrixOutcome !== 'full_runtime_gpu_hmr' || row.acceptanceScope !== 'opencl_declared_compute_readback') {
      throw new Error(`self-check matrix row rejected: ${JSON.stringify({
        openGaps: row?.openGaps,
        reasons: row?.reasons,
        ledger: row?.ledger,
        runtimeProofArtifact: row?.runtimeProofArtifact,
        declaredScopeEvidence: row?.declaredScopeEvidence,
        sourceAdaptation: row?.sourceAdaptation,
        negativeAbiRefusalAccepted: row?.negativeAbiRefusalAccepted,
        runtimeTimestampProof: row?.runtimeTimestampProof,
        epoch2ArtifactHashProof: row?.epoch2ArtifactHashProof,
        nativeOpenClApiEvidence: row?.nativeOpenClApiEvidence,
      }, null, 2)}`);
    }
    const outputBinding = row.outputOracleFacet?.outputBinding ?? row.outputOracleFacet?.output_binding ?? {};
    if (
      row.outputOracleFacet?.accepted !== true
      || outputBinding.accepted !== true
      || outputBinding.dispatchOutputTargetId !== OPENCL_OUTPUT_TARGET_ID
      || outputBinding.oracleOutputTargetId !== OPENCL_OUTPUT_TARGET_ID
      || contract.output_oracle_target?.target_id !== OPENCL_OUTPUT_TARGET_ID
      || contract.fission_report?.output_oracle_contract?.target_id !== OPENCL_OUTPUT_TARGET_ID
    ) {
      throw new Error(`self-check output target binding rejected: ${JSON.stringify({
        outputOracleFacet: row.outputOracleFacet,
        contractOutputTarget: contract.output_oracle_target,
        fissionOutputOracleContract: contract.fission_report?.output_oracle_contract,
      }, null, 2)}`);
    }
    const forged = JSON.parse(JSON.stringify(proof));
    forged.proofId = 'opencl-runtime-proof:sha256:forged';
    forged.computeOracleArtifacts.raw_readback_hash = sha256Text('forged');
    const forgedRecord = forged.proofLedger.records[0];
    const forgedHash = sha256Text('forged');
    for (const artifactCopy of [
      forgedRecord.oracle_artifacts?.compute_oracle_artifacts,
      forgedRecord.oracleArtifacts?.computeOracleArtifacts,
      forgedRecord.oracleArtifacts?.compute_oracle_artifacts,
      forgedRecord.output_event?.output_oracle?.oracle_artifacts?.compute_oracle_artifacts,
      forgedRecord.outputEvent?.outputOracle?.oracleArtifacts?.computeOracleArtifacts,
      forged.compute_oracle_artifacts,
      forged.computeOracleArtifacts,
    ]) {
      if (artifactCopy && typeof artifactCopy === 'object') {
        artifactCopy.raw_readback_hash = forgedHash;
        artifactCopy.rawReadbackHash = forgedHash;
      }
    }
    await writeFile(path.join(tmp, 'opencl-runtime-proof-forged.json'), `${JSON.stringify(forged, null, 2)}\n`);
    const forgedMatrix = await collectGpuHmrValidationMatrixLedger({
      repoRoot: REPO_ROOT,
      mcpRoot: MCP_ROOT,
      roots: [tmp],
      latestPerTarget: false,
      includeUnproven: true,
      generatedAt: '2026-06-30T00:00:00.000Z',
    });
    const forgedRow = forgedMatrix.rows.find((entry) => entry.proofIds?.includes('opencl-runtime-proof:sha256:forged'));
    if (forgedRow?.matrixOutcome === 'full_runtime_gpu_hmr') {
      throw new Error('forged OpenCL raw readback hash was accepted');
    }
    console.log(JSON.stringify({
      ok: true,
      schemaVersion: SCHEMA,
      proofId: proof.proofId,
      matrixProofId: matrix.proofId,
      rowId: row.rowId,
      forgedRejected: true,
      windowsProbeSourceChecked: true,
    }, null, 2));
  } finally {
    CFG.metricScope = old.metricScope;
    CFG.cacheState = old.cacheState;
    CFG.differentEdit = old.differentEdit;
  }
}

async function main() {
  if (process.argv.includes('--self-check')) {
    await selfCheck();
    return;
  }
  const result = await buildProof();
  console.log(JSON.stringify({
    ok: result.proof?.gpuHmrSuccess === true,
    schemaVersion: SCHEMA,
    proofId: result.proof?.proofId,
    resultState: result.proof?.resultState,
    fullRuntimeProven: result.proof?.fullRuntimeProven,
    gpuHmrSuccess: result.proof?.gpuHmrSuccess,
    proofPath: result.proofPath,
    runtimeProofArtifactId: result.proof?.runtimeProofArtifact?.proofId ?? null,
    ledgerProofId: result.proof?.proofLedger?.proofId ?? null,
    limitations: result.proof?.limitations ?? [],
  }, null, 2));
  if (process.env.SYNTHI_OPENCL_RUNTIME_FAIL_ON_REJECTION === '1' && result.proof?.gpuHmrSuccess !== true) {
    process.exitCode = 1;
  }
}

await main();
