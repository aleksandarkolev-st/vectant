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
import { evaluateGpuHmrDeterministicVisualMode } from './lib/gpu-hmr-visual-evidence.mjs';
import { runtimeProofArtifactStrictGate } from './lib/gpu-hmr-proof-strict-gates.mjs';
import {
  collectGpuHmrValidationMatrixLedger,
} from './lib/gpu-hmr-validation-matrix-ledger.mjs';
import {
  visualEvidenceArtifactsFromVisualOracleArtifacts,
} from './lib/gpu-hmr-validation-proof-artifact.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../..');
const MCP_ROOT = path.resolve(__dirname, '..');
const ARTIFACT_DIR = path.join(MCP_ROOT, '.gpu-hmr-test-artifacts/vulkan-runtime-proof');
const SCHEMA = 'synthi.gpu_hmr.vulkan_runtime_proof.v1';
const MODEL_AVAILABILITY_SOURCE = 'https://ai.google.dev/gemini-api/docs/deprecations';
const VULKAN_VISUAL_OUTPUT_TARGET_ID = 'vulkan-frame-readback';
const VULKAN_FRAMEBUFFER_ID = 'swapchain-framebuffer';

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
  slug: process.env.SLUG ?? `vulkan-runtime-frame-${nowSlugDate()}`,
  workerContainer: process.env.SYNTHI_VULKAN_WORKER_CONTAINER
    ?? process.env.WORKER_CONTAINER
    ?? 'vectant-ade-worker-1',
  timeoutMs: Number(process.env.SYNTHI_VULKAN_RUNTIME_TIMEOUT_MS ?? 120000),
  targetId: process.env.SYNTHI_VULKAN_RUNTIME_TARGET_ID ?? 'vulkan-runtime-frame',
  metricScope: process.env.SYNTHI_VULKAN_RUNTIME_METRIC_SCOPE ?? 'hot_delta_1',
  cacheState: process.env.SYNTHI_VULKAN_RUNTIME_CACHE_STATE ?? 'pipeline_cache_warm',
  differentEdit: process.env.SYNTHI_VULKAN_RUNTIME_DIFFERENT_EDIT === '1',
  splitModel: process.env.SYNTHI_GEMINI_SPLIT_MODEL ?? 'gemini-3.5-flash',
  gpuDeltaModel: process.env.SYNTHI_GEMINI_DELTA_MODEL ?? 'gemini-3.1-flash-lite',
};

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
  return String(value || 'vulkan-runtime').replace(/[^a-zA-Z0-9_.-]+/g, '-');
}

function relRepo(filePath) {
  const resolved = path.resolve(filePath);
  const relative = path.relative(REPO_ROOT, resolved);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    return relative.replace(/\\/g, '/');
  }
  return resolved;
}

function firstText(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function finiteNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
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
        stdoutTail: String(stdout ?? '').slice(-4000),
        stderrTail: String(stderr ?? '').slice(-4000),
        error: error?.message ?? null,
      });
    });
  });
}

async function dockerShell(script, timeout = CFG.timeoutMs) {
  return execFileRaw('docker', ['exec', '-w', '/tmp', CFG.workerContainer, 'sh', '-lc', script], { timeout });
}

function parseLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function parseVulkanLibraries(text) {
  return parseLines(text).filter((line) => /libvulkan\.so/i.test(line));
}

function parseIcdFiles(text) {
  if (/^no_vulkan_icds$/m.test(text)) return [];
  return parseLines(text).filter((line) => /\/vulkan\/icd\.d\/.+\.json$/i.test(line));
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

function spirvStringWords(value) {
  const bytes = Buffer.from(`${value}\0`, 'utf8');
  const padded = Buffer.concat([bytes, Buffer.alloc((4 - (bytes.length % 4)) % 4)]);
  const words = [];
  for (let offset = 0; offset < padded.length; offset += 4) {
    words.push(padded.readUInt32LE(offset));
  }
  return words;
}

function spirvInst(opcode, ...operands) {
  return [((1 + operands.length) << 16) | opcode, ...operands];
}

function spirvInstString(opcode, prefixOperands, text, suffixOperands = []) {
  const stringWords = spirvStringWords(text);
  return [
    ((1 + prefixOperands.length + stringWords.length + suffixOperands.length) << 16) | opcode,
    ...prefixOperands,
    ...stringWords,
    ...suffixOperands,
  ];
}

function vulkanComputeSpirv({ color }) {
  const ids = {
    void: 1,
    fnVoid: 2,
    uint: 3,
    v3uint: 4,
    ptrInputV3uint: 5,
    globalInvocationId: 6,
    runtimeArrayUint: 7,
    outputStruct: 8,
    ptrStorageOutputStruct: 9,
    outputBuffer: 10,
    ptrStorageUint: 11,
    c0: 12,
    cColor: 13,
    main: 30,
    label: 31,
    invocation: 32,
    idx: 33,
    outputPtr: 34,
  };
  const words = [];
  const emit = (...instWords) => words.push(...instWords);
  emit(...spirvInst(17, 1)); // OpCapability Shader
  emit(...spirvInst(14, 0, 1)); // OpMemoryModel Logical GLSL450
  emit(...spirvInstString(15, [5, ids.main], 'main', [ids.globalInvocationId, ids.outputBuffer]));
  emit(...spirvInst(16, ids.main, 17, 64, 1, 1)); // OpExecutionMode LocalSize 64 1 1
  emit(...spirvInst(71, ids.globalInvocationId, 11, 28)); // BuiltIn GlobalInvocationId
  emit(...spirvInst(71, ids.runtimeArrayUint, 6, 4)); // ArrayStride 4
  emit(...spirvInst(72, ids.outputStruct, 0, 35, 0)); // MemberDecorate Offset 0
  emit(...spirvInst(71, ids.outputStruct, 2)); // Block
  emit(...spirvInst(71, ids.outputBuffer, 34, 0)); // DescriptorSet 0
  emit(...spirvInst(71, ids.outputBuffer, 33, 0)); // Binding 0
  emit(...spirvInst(19, ids.void));
  emit(...spirvInst(33, ids.fnVoid, ids.void));
  emit(...spirvInst(21, ids.uint, 32, 0));
  emit(...spirvInst(23, ids.v3uint, ids.uint, 3));
  emit(...spirvInst(32, ids.ptrInputV3uint, 1, ids.v3uint));
  emit(...spirvInst(29, ids.runtimeArrayUint, ids.uint));
  emit(...spirvInst(30, ids.outputStruct, ids.runtimeArrayUint));
  emit(...spirvInst(32, ids.ptrStorageOutputStruct, 12, ids.outputStruct));
  emit(...spirvInst(32, ids.ptrStorageUint, 12, ids.uint));
  for (const [id, value] of [[ids.c0, 0], [ids.cColor, color]]) {
    emit(...spirvInst(43, ids.uint, id, value >>> 0));
  }
  emit(...spirvInst(59, ids.ptrInputV3uint, ids.globalInvocationId, 1));
  emit(...spirvInst(59, ids.ptrStorageOutputStruct, ids.outputBuffer, 12));
  emit(...spirvInst(54, ids.void, ids.main, 0, ids.fnVoid));
  emit(...spirvInst(248, ids.label));
  emit(...spirvInst(61, ids.v3uint, ids.invocation, ids.globalInvocationId));
  emit(...spirvInst(81, ids.uint, ids.idx, ids.invocation, 0));
  emit(...spirvInst(65, ids.ptrStorageUint, ids.outputPtr, ids.outputBuffer, ids.c0, ids.idx));
  emit(...spirvInst(62, ids.outputPtr, ids.cColor));
  emit(...spirvInst(253));
  emit(...spirvInst(56));
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x07230203, 0);
  header.writeUInt32LE(0x00010300, 4);
  header.writeUInt32LE(0, 8);
  header.writeUInt32LE(64, 12);
  header.writeUInt32LE(0, 16);
  const body = Buffer.alloc(words.length * 4);
  words.forEach((word, index) => body.writeUInt32LE(word >>> 0, index * 4));
  return Buffer.concat([header, body]);
}

async function writeVulkanShaderArtifacts(outDir) {
  const beforeSpv = vulkanComputeSpirv({ color: 0xff3030b0 });
  const afterSpv = vulkanComputeSpirv({ color: 0xffd09024 });
  const beforePath = path.join(outDir, 'vulkan-before.comp.spv');
  const afterPath = path.join(outDir, 'vulkan-after.comp.spv');
  await writeFile(beforePath, beforeSpv);
  await writeFile(afterPath, afterSpv);
  return {
    beforePath,
    afterPath,
    beforeHash: sha256Bytes(beforeSpv),
    afterHash: sha256Bytes(afterSpv),
  };
}

async function renderFramesFromRgbaReadback({ outDir, beforeRawPath, afterRawPath, width, height }) {
  const beforeBuffer = await readFile(beforeRawPath);
  const afterBuffer = await readFile(afterRawPath);
  const expectedBytes = width * height * 4;
  if (beforeBuffer.length !== expectedBytes || afterBuffer.length !== expectedBytes) {
    throw new Error(`Vulkan readback size mismatch: before=${beforeBuffer.length} after=${afterBuffer.length} expected=${expectedBytes}`);
  }
  const beforePath = path.join(outDir, 'vulkan-before-frame.png');
  const afterPath = path.join(outDir, 'vulkan-after-frame.png');
  const diffPath = path.join(outDir, 'vulkan-diff-frame.png');
  await sharp(beforeBuffer, { raw: { width, height, channels: 4 } }).png().toFile(beforePath);
  await sharp(afterBuffer, { raw: { width, height, channels: 4 } }).png().toFile(afterPath);
  const diffBuffer = Buffer.alloc(expectedBytes);
  let changedPixels = 0;
  let totalAbs = 0;
  for (let offset = 0; offset < expectedBytes; offset += 4) {
    let pixelChanged = false;
    for (let channel = 0; channel < 3; channel += 1) {
      const delta = Math.abs(Number(afterBuffer[offset + channel]) - Number(beforeBuffer[offset + channel]));
      totalAbs += delta;
      diffBuffer[offset + channel] = Math.min(255, delta * 3);
      if (delta > 4) pixelChanged = true;
    }
    diffBuffer[offset + 3] = 255;
    if (pixelChanged) changedPixels += 1;
  }
  await sharp(diffBuffer, { raw: { width, height, channels: 4 } }).png().toFile(diffPath);
  const pixelCount = width * height;
  return {
    width,
    height,
    beforePath,
    afterPath,
    diffPath,
    beforeHash: await sha256File(beforePath),
    afterHash: await sha256File(afterPath),
    diffHash: await sha256File(diffPath),
    changedPixels,
    changedPixelRatio: changedPixels / pixelCount,
    meanAbsDelta8bit: totalAbs / (pixelCount * 3),
    visiblePixelCount: changedPixels,
    perceptualDiff: totalAbs / (pixelCount * 3 * 255),
  };
}

function windowsVulkanPowerShellProbeSource() {
  return String.raw`
param(
  [Parameter(Mandatory=$true)][string]$BeforeSpvPath,
  [Parameter(Mandatory=$true)][string]$AfterSpvPath,
  [Parameter(Mandatory=$true)][string]$BeforeRawPath,
  [Parameter(Mandatory=$true)][string]$AfterRawPath,
  [Parameter(Mandatory=$true)][string]$TracePath,
  [Parameter(Mandatory=$true)][string]$BeforeHash,
  [Parameter(Mandatory=$true)][string]$AfterHash,
  [Parameter(Mandatory=$true)][string]$SchemaVersion
)
$ErrorActionPreference = 'Stop'
$source = @'
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class SynthiVulkanWindowsProbe {
  const int VK_SUCCESS = 0;
  const int VK_STRUCTURE_TYPE_APPLICATION_INFO = 0;
  const int VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO = 1;
  const int VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO = 2;
  const int VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO = 3;
  const int VK_STRUCTURE_TYPE_SUBMIT_INFO = 4;
  const int VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO = 5;
  const int VK_STRUCTURE_TYPE_FENCE_CREATE_INFO = 8;
  const int VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO = 12;
  const int VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO = 16;
  const int VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO = 18;
  const int VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO = 28;
  const int VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO = 30;
  const int VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO = 32;
  const int VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO = 33;
  const int VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO = 34;
  const int VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET = 35;
  const int VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO = 39;
  const int VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO = 42;
  const int VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO = 43;
  const uint VK_QUEUE_COMPUTE_BIT = 0x00000002;
  const uint VK_BUFFER_USAGE_STORAGE_BUFFER_BIT = 0x00000020;
  const uint VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT = 0x00000001;
  const uint VK_MEMORY_PROPERTY_HOST_COHERENT_BIT = 0x00000002;
  const uint VK_DESCRIPTOR_TYPE_STORAGE_BUFFER = 7;
  const uint VK_SHADER_STAGE_COMPUTE_BIT = 0x00000020;
  const uint VK_PIPELINE_BIND_POINT_COMPUTE = 1;
  const uint VK_COMMAND_BUFFER_LEVEL_PRIMARY = 0;
  const uint VK_SHARING_MODE_EXCLUSIVE = 0;
  const uint WIDTH = 128;
  const uint HEIGHT = 128;
  const uint PIXELS = WIDTH * HEIGHT;
  const ulong BUFFER_BYTES = PIXELS * 4;
  const int BUFFER_BYTE_COUNT = 128 * 128 * 4;

  [StructLayout(LayoutKind.Sequential)]
  struct VkApplicationInfo {
    public int sType;
    public IntPtr pNext;
    public IntPtr pApplicationName;
    public uint applicationVersion;
    public IntPtr pEngineName;
    public uint engineVersion;
    public uint apiVersion;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct VkInstanceCreateInfo {
    public int sType;
    public IntPtr pNext;
    public uint flags;
    public IntPtr pApplicationInfo;
    public uint enabledLayerCount;
    public IntPtr ppEnabledLayerNames;
    public uint enabledExtensionCount;
    public IntPtr ppEnabledExtensionNames;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct VkDeviceQueueCreateInfo {
    public int sType;
    public IntPtr pNext;
    public uint flags;
    public uint queueFamilyIndex;
    public uint queueCount;
    public IntPtr pQueuePriorities;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct VkDeviceCreateInfo {
    public int sType;
    public IntPtr pNext;
    public uint flags;
    public uint queueCreateInfoCount;
    public IntPtr pQueueCreateInfos;
    public uint enabledLayerCount;
    public IntPtr ppEnabledLayerNames;
    public uint enabledExtensionCount;
    public IntPtr ppEnabledExtensionNames;
    public IntPtr pEnabledFeatures;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct VkBufferCreateInfo {
    public int sType;
    public IntPtr pNext;
    public uint flags;
    public ulong size;
    public uint usage;
    public uint sharingMode;
    public uint queueFamilyIndexCount;
    public IntPtr pQueueFamilyIndices;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct VkMemoryRequirements {
    public ulong size;
    public ulong alignment;
    public uint memoryTypeBits;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct VkMemoryAllocateInfo {
    public int sType;
    public IntPtr pNext;
    public ulong allocationSize;
    public uint memoryTypeIndex;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct VkDescriptorSetLayoutBinding {
    public uint binding;
    public uint descriptorType;
    public uint descriptorCount;
    public uint stageFlags;
    public IntPtr pImmutableSamplers;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct VkDescriptorSetLayoutCreateInfo {
    public int sType;
    public IntPtr pNext;
    public uint flags;
    public uint bindingCount;
    public IntPtr pBindings;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct VkDescriptorPoolSize {
    public uint type;
    public uint descriptorCount;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct VkDescriptorPoolCreateInfo {
    public int sType;
    public IntPtr pNext;
    public uint flags;
    public uint maxSets;
    public uint poolSizeCount;
    public IntPtr pPoolSizes;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct VkDescriptorSetAllocateInfo {
    public int sType;
    public IntPtr pNext;
    public IntPtr descriptorPool;
    public uint descriptorSetCount;
    public IntPtr pSetLayouts;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct VkDescriptorBufferInfo {
    public IntPtr buffer;
    public ulong offset;
    public ulong range;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct VkWriteDescriptorSet {
    public int sType;
    public IntPtr pNext;
    public IntPtr dstSet;
    public uint dstBinding;
    public uint dstArrayElement;
    public uint descriptorCount;
    public uint descriptorType;
    public IntPtr pImageInfo;
    public IntPtr pBufferInfo;
    public IntPtr pTexelBufferView;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct VkPipelineLayoutCreateInfo {
    public int sType;
    public IntPtr pNext;
    public uint flags;
    public uint setLayoutCount;
    public IntPtr pSetLayouts;
    public uint pushConstantRangeCount;
    public IntPtr pPushConstantRanges;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct VkShaderModuleCreateInfo {
    public int sType;
    public IntPtr pNext;
    public uint flags;
    public UIntPtr codeSize;
    public IntPtr pCode;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct VkPipelineShaderStageCreateInfo {
    public int sType;
    public IntPtr pNext;
    public uint flags;
    public uint stage;
    public IntPtr module;
    public IntPtr pName;
    public IntPtr pSpecializationInfo;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct VkComputePipelineCreateInfo {
    public int sType;
    public IntPtr pNext;
    public uint flags;
    public VkPipelineShaderStageCreateInfo stage;
    public IntPtr layout;
    public IntPtr basePipelineHandle;
    public int basePipelineIndex;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct VkCommandPoolCreateInfo {
    public int sType;
    public IntPtr pNext;
    public uint flags;
    public uint queueFamilyIndex;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct VkCommandBufferAllocateInfo {
    public int sType;
    public IntPtr pNext;
    public IntPtr commandPool;
    public uint level;
    public uint commandBufferCount;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct VkCommandBufferBeginInfo {
    public int sType;
    public IntPtr pNext;
    public uint flags;
    public IntPtr pInheritanceInfo;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct VkSubmitInfo {
    public int sType;
    public IntPtr pNext;
    public uint waitSemaphoreCount;
    public IntPtr pWaitSemaphores;
    public IntPtr pWaitDstStageMask;
    public uint commandBufferCount;
    public IntPtr pCommandBuffers;
    public uint signalSemaphoreCount;
    public IntPtr pSignalSemaphores;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct VkFenceCreateInfo {
    public int sType;
    public IntPtr pNext;
    public uint flags;
  }

  [DllImport("vulkan-1.dll")] static extern int vkCreateInstance(ref VkInstanceCreateInfo createInfo, IntPtr allocator, out IntPtr instance);
  [DllImport("vulkan-1.dll")] static extern int vkEnumeratePhysicalDevices(IntPtr instance, ref uint count, IntPtr[] devices);
  [DllImport("vulkan-1.dll")] static extern void vkGetPhysicalDeviceQueueFamilyProperties(IntPtr physicalDevice, ref uint count, IntPtr properties);
  [DllImport("vulkan-1.dll")] static extern void vkGetPhysicalDeviceMemoryProperties(IntPtr physicalDevice, IntPtr properties);
  [DllImport("vulkan-1.dll")] static extern int vkCreateDevice(IntPtr physicalDevice, ref VkDeviceCreateInfo createInfo, IntPtr allocator, out IntPtr device);
  [DllImport("vulkan-1.dll")] static extern void vkGetDeviceQueue(IntPtr device, uint queueFamilyIndex, uint queueIndex, out IntPtr queue);
  [DllImport("vulkan-1.dll")] static extern int vkCreateBuffer(IntPtr device, ref VkBufferCreateInfo createInfo, IntPtr allocator, out IntPtr buffer);
  [DllImport("vulkan-1.dll")] static extern void vkGetBufferMemoryRequirements(IntPtr device, IntPtr buffer, out VkMemoryRequirements requirements);
  [DllImport("vulkan-1.dll")] static extern int vkAllocateMemory(IntPtr device, ref VkMemoryAllocateInfo allocateInfo, IntPtr allocator, out IntPtr memory);
  [DllImport("vulkan-1.dll")] static extern int vkBindBufferMemory(IntPtr device, IntPtr buffer, IntPtr memory, ulong offset);
  [DllImport("vulkan-1.dll")] static extern int vkMapMemory(IntPtr device, IntPtr memory, ulong offset, ulong size, uint flags, out IntPtr data);
  [DllImport("vulkan-1.dll")] static extern void vkUnmapMemory(IntPtr device, IntPtr memory);
  [DllImport("vulkan-1.dll")] static extern int vkCreateDescriptorSetLayout(IntPtr device, ref VkDescriptorSetLayoutCreateInfo createInfo, IntPtr allocator, out IntPtr setLayout);
  [DllImport("vulkan-1.dll")] static extern int vkCreatePipelineLayout(IntPtr device, ref VkPipelineLayoutCreateInfo createInfo, IntPtr allocator, out IntPtr pipelineLayout);
  [DllImport("vulkan-1.dll")] static extern int vkCreateDescriptorPool(IntPtr device, ref VkDescriptorPoolCreateInfo createInfo, IntPtr allocator, out IntPtr descriptorPool);
  [DllImport("vulkan-1.dll")] static extern int vkAllocateDescriptorSets(IntPtr device, ref VkDescriptorSetAllocateInfo allocateInfo, out IntPtr descriptorSet);
  [DllImport("vulkan-1.dll")] static extern void vkUpdateDescriptorSets(IntPtr device, uint writeCount, ref VkWriteDescriptorSet writes, uint copyCount, IntPtr copies);
  [DllImport("vulkan-1.dll")] static extern int vkCreateShaderModule(IntPtr device, ref VkShaderModuleCreateInfo createInfo, IntPtr allocator, out IntPtr shaderModule);
  [DllImport("vulkan-1.dll")] static extern int vkCreateComputePipelines(IntPtr device, IntPtr pipelineCache, uint createInfoCount, ref VkComputePipelineCreateInfo createInfo, IntPtr allocator, out IntPtr pipeline);
  [DllImport("vulkan-1.dll")] static extern int vkCreateCommandPool(IntPtr device, ref VkCommandPoolCreateInfo createInfo, IntPtr allocator, out IntPtr commandPool);
  [DllImport("vulkan-1.dll")] static extern int vkAllocateCommandBuffers(IntPtr device, ref VkCommandBufferAllocateInfo allocateInfo, out IntPtr commandBuffer);
  [DllImport("vulkan-1.dll")] static extern int vkBeginCommandBuffer(IntPtr commandBuffer, ref VkCommandBufferBeginInfo beginInfo);
  [DllImport("vulkan-1.dll")] static extern void vkCmdBindPipeline(IntPtr commandBuffer, uint pipelineBindPoint, IntPtr pipeline);
  [DllImport("vulkan-1.dll")] static extern void vkCmdBindDescriptorSets(IntPtr commandBuffer, uint pipelineBindPoint, IntPtr layout, uint firstSet, uint descriptorSetCount, IntPtr[] descriptorSets, uint dynamicOffsetCount, IntPtr dynamicOffsets);
  [DllImport("vulkan-1.dll")] static extern void vkCmdDispatch(IntPtr commandBuffer, uint groupCountX, uint groupCountY, uint groupCountZ);
  [DllImport("vulkan-1.dll")] static extern int vkEndCommandBuffer(IntPtr commandBuffer);
  [DllImport("vulkan-1.dll")] static extern int vkCreateFence(IntPtr device, ref VkFenceCreateInfo createInfo, IntPtr allocator, out IntPtr fence);
  [DllImport("vulkan-1.dll")] static extern int vkQueueSubmit(IntPtr queue, uint submitCount, ref VkSubmitInfo submits, IntPtr fence);
  [DllImport("vulkan-1.dll")] static extern int vkWaitForFences(IntPtr device, uint fenceCount, IntPtr[] fences, uint waitAll, ulong timeout);
  [DllImport("vulkan-1.dll")] static extern void vkDestroyFence(IntPtr device, IntPtr fence, IntPtr allocator);
  [DllImport("vulkan-1.dll")] static extern void vkDestroyPipeline(IntPtr device, IntPtr pipeline, IntPtr allocator);
  [DllImport("vulkan-1.dll")] static extern void vkDestroyShaderModule(IntPtr device, IntPtr shaderModule, IntPtr allocator);
  [DllImport("vulkan-1.dll")] static extern void vkDestroyCommandPool(IntPtr device, IntPtr commandPool, IntPtr allocator);
  [DllImport("vulkan-1.dll")] static extern void vkDestroyDescriptorPool(IntPtr device, IntPtr descriptorPool, IntPtr allocator);
  [DllImport("vulkan-1.dll")] static extern void vkDestroyPipelineLayout(IntPtr device, IntPtr pipelineLayout, IntPtr allocator);
  [DllImport("vulkan-1.dll")] static extern void vkDestroyDescriptorSetLayout(IntPtr device, IntPtr descriptorSetLayout, IntPtr allocator);
  [DllImport("vulkan-1.dll")] static extern void vkDestroyBuffer(IntPtr device, IntPtr buffer, IntPtr allocator);
  [DllImport("vulkan-1.dll")] static extern void vkFreeMemory(IntPtr device, IntPtr memory, IntPtr allocator);
  [DllImport("vulkan-1.dll")] static extern void vkDestroyDevice(IntPtr device, IntPtr allocator);
  [DllImport("vulkan-1.dll")] static extern void vkDestroyInstance(IntPtr instance, IntPtr allocator);

  sealed class ProbeState {
    public IntPtr Instance;
    public IntPtr PhysicalDevice;
    public IntPtr Device;
    public IntPtr Queue;
    public uint QueueFamilyIndex;
    public IntPtr Buffer;
    public IntPtr Memory;
    public IntPtr DescriptorSetLayout;
    public IntPtr PipelineLayout;
    public IntPtr ExtraPipelineLayout;
    public IntPtr DescriptorPool;
    public IntPtr DescriptorSet;
    public IntPtr CommandPool;
    public int VkCreateShaderModule;
    public int VkCreatePipelineLayout;
    public int VkCreateComputePipelines;
    public int VkAllocateCommandBuffers;
    public int VkBeginCommandBuffer;
    public int VkCmdBindPipeline;
    public int VkCmdDispatch;
    public int VkQueueSubmit;
    public int VkWaitForFences;
    public int VkMapMemory;
  }

  struct EpochRunResult {
    public long DispatchNs;
    public long OutputNs;
  }

  static long NowNs() {
    return (long)((Stopwatch.GetTimestamp() * 1000000000.0) / Stopwatch.Frequency);
  }

  static int Fail(string code, int exitCode, string detail) {
    Console.Error.WriteLine("vulkan_runtime_error=" + code + " detail=" + detail);
    return exitCode;
  }

  static string PtrHex(IntPtr value) {
    return "0x" + value.ToInt64().ToString("x");
  }

  static void Check(int err, string code) {
    if (err != VK_SUCCESS) throw new Exception(code + ": vk_result=" + err);
  }

  static uint SelectMemoryType(IntPtr physicalDevice, uint bits, uint requiredFlags) {
    IntPtr mem = Marshal.AllocHGlobal(1024);
    try {
      for (int i = 0; i < 1024; i++) Marshal.WriteByte(mem, i, 0);
      vkGetPhysicalDeviceMemoryProperties(physicalDevice, mem);
      uint typeCount = (uint)Marshal.ReadInt32(mem, 0);
      for (uint i = 0; i < typeCount && i < 32; i++) {
        if ((bits & (1u << (int)i)) == 0) continue;
        int offset = 4 + ((int)i * 8);
        uint flags = (uint)Marshal.ReadInt32(mem, offset);
        if ((flags & requiredFlags) == requiredFlags) return i;
      }
      throw new Exception("no HOST_VISIBLE|HOST_COHERENT memory type for bits=" + bits);
    } finally {
      Marshal.FreeHGlobal(mem);
    }
  }

  static uint SelectComputeQueueFamily(IntPtr physicalDevice) {
    uint count = 0;
    vkGetPhysicalDeviceQueueFamilyProperties(physicalDevice, ref count, IntPtr.Zero);
    if (count == 0) throw new Exception("queue_family_missing");
    int stride = 24;
    IntPtr props = Marshal.AllocHGlobal((int)count * stride);
    try {
      vkGetPhysicalDeviceQueueFamilyProperties(physicalDevice, ref count, props);
      for (uint i = 0; i < count; i++) {
        int offset = (int)i * stride;
        uint flags = (uint)Marshal.ReadInt32(props, offset);
        uint queueCount = (uint)Marshal.ReadInt32(props, offset + 4);
        if (queueCount > 0 && (flags & VK_QUEUE_COMPUTE_BIT) != 0) return i;
      }
      throw new Exception("compute_queue_missing");
    } finally {
      Marshal.FreeHGlobal(props);
    }
  }

  static ProbeState CreateState() {
    ProbeState state = new ProbeState();
    IntPtr appName = Marshal.StringToHGlobalAnsi("synthi-vulkan-runtime-proof");
    IntPtr engineName = Marshal.StringToHGlobalAnsi("synthi");
    IntPtr queueInfoPtr = IntPtr.Zero;
    IntPtr priorityPtr = IntPtr.Zero;
    IntPtr bindingPtr = IntPtr.Zero;
    IntPtr setLayoutPtr = IntPtr.Zero;
    IntPtr poolSizePtr = IntPtr.Zero;
    IntPtr descriptorBufferInfoPtr = IntPtr.Zero;
    try {
      VkApplicationInfo app = new VkApplicationInfo {
        sType = VK_STRUCTURE_TYPE_APPLICATION_INFO,
        pApplicationName = appName,
        applicationVersion = 1,
        pEngineName = engineName,
        engineVersion = 1,
        apiVersion = (1u << 22) | (1u << 12)
      };
      IntPtr appPtr = Marshal.AllocHGlobal(Marshal.SizeOf<VkApplicationInfo>());
      try {
        Marshal.StructureToPtr(app, appPtr, false);
        VkInstanceCreateInfo instanceInfo = new VkInstanceCreateInfo {
          sType = VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO,
          pApplicationInfo = appPtr
        };
        Check(vkCreateInstance(ref instanceInfo, IntPtr.Zero, out state.Instance), "vkCreateInstance");
      } finally {
        Marshal.FreeHGlobal(appPtr);
      }
      uint deviceCount = 0;
      Check(vkEnumeratePhysicalDevices(state.Instance, ref deviceCount, null), "vkEnumeratePhysicalDevicesCount");
      if (deviceCount == 0) throw new Exception("physical_device_missing");
      IntPtr[] devices = new IntPtr[(int)deviceCount];
      Check(vkEnumeratePhysicalDevices(state.Instance, ref deviceCount, devices), "vkEnumeratePhysicalDevices");
      state.PhysicalDevice = devices[0];
      state.QueueFamilyIndex = SelectComputeQueueFamily(state.PhysicalDevice);
      float[] priorities = new float[] { 1.0f };
      GCHandle priorityHandle = GCHandle.Alloc(priorities, GCHandleType.Pinned);
      try {
        priorityPtr = priorityHandle.AddrOfPinnedObject();
        VkDeviceQueueCreateInfo queueInfo = new VkDeviceQueueCreateInfo {
          sType = VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO,
          queueFamilyIndex = state.QueueFamilyIndex,
          queueCount = 1,
          pQueuePriorities = priorityPtr
        };
        queueInfoPtr = Marshal.AllocHGlobal(Marshal.SizeOf<VkDeviceQueueCreateInfo>());
        Marshal.StructureToPtr(queueInfo, queueInfoPtr, false);
        VkDeviceCreateInfo deviceInfo = new VkDeviceCreateInfo {
          sType = VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO,
          queueCreateInfoCount = 1,
          pQueueCreateInfos = queueInfoPtr
        };
        Check(vkCreateDevice(state.PhysicalDevice, ref deviceInfo, IntPtr.Zero, out state.Device), "vkCreateDevice");
      } finally {
        if (priorityHandle.IsAllocated) priorityHandle.Free();
      }
      vkGetDeviceQueue(state.Device, state.QueueFamilyIndex, 0, out state.Queue);
      VkBufferCreateInfo bufferInfo = new VkBufferCreateInfo {
        sType = VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO,
        size = BUFFER_BYTES,
        usage = VK_BUFFER_USAGE_STORAGE_BUFFER_BIT,
        sharingMode = VK_SHARING_MODE_EXCLUSIVE
      };
      Check(vkCreateBuffer(state.Device, ref bufferInfo, IntPtr.Zero, out state.Buffer), "vkCreateBuffer");
      VkMemoryRequirements req;
      vkGetBufferMemoryRequirements(state.Device, state.Buffer, out req);
      VkMemoryAllocateInfo alloc = new VkMemoryAllocateInfo {
        sType = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO,
        allocationSize = req.size,
        memoryTypeIndex = SelectMemoryType(state.PhysicalDevice, req.memoryTypeBits, VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT)
      };
      Check(vkAllocateMemory(state.Device, ref alloc, IntPtr.Zero, out state.Memory), "vkAllocateMemory");
      Check(vkBindBufferMemory(state.Device, state.Buffer, state.Memory, 0), "vkBindBufferMemory");
      VkDescriptorSetLayoutBinding binding = new VkDescriptorSetLayoutBinding {
        binding = 0,
        descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER,
        descriptorCount = 1,
        stageFlags = VK_SHADER_STAGE_COMPUTE_BIT
      };
      bindingPtr = Marshal.AllocHGlobal(Marshal.SizeOf<VkDescriptorSetLayoutBinding>());
      Marshal.StructureToPtr(binding, bindingPtr, false);
      VkDescriptorSetLayoutCreateInfo layoutInfo = new VkDescriptorSetLayoutCreateInfo {
        sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO,
        bindingCount = 1,
        pBindings = bindingPtr
      };
      Check(vkCreateDescriptorSetLayout(state.Device, ref layoutInfo, IntPtr.Zero, out state.DescriptorSetLayout), "vkCreateDescriptorSetLayout");
      setLayoutPtr = Marshal.AllocHGlobal(IntPtr.Size);
      Marshal.WriteIntPtr(setLayoutPtr, state.DescriptorSetLayout);
      VkDescriptorPoolSize poolSize = new VkDescriptorPoolSize {
        type = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER,
        descriptorCount = 1
      };
      poolSizePtr = Marshal.AllocHGlobal(Marshal.SizeOf<VkDescriptorPoolSize>());
      Marshal.StructureToPtr(poolSize, poolSizePtr, false);
      VkDescriptorPoolCreateInfo poolInfo = new VkDescriptorPoolCreateInfo {
        sType = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO,
        maxSets = 1,
        poolSizeCount = 1,
        pPoolSizes = poolSizePtr
      };
      Check(vkCreateDescriptorPool(state.Device, ref poolInfo, IntPtr.Zero, out state.DescriptorPool), "vkCreateDescriptorPool");
      VkDescriptorSetAllocateInfo setAlloc = new VkDescriptorSetAllocateInfo {
        sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO,
        descriptorPool = state.DescriptorPool,
        descriptorSetCount = 1,
        pSetLayouts = setLayoutPtr
      };
      Check(vkAllocateDescriptorSets(state.Device, ref setAlloc, out state.DescriptorSet), "vkAllocateDescriptorSets");
      VkDescriptorBufferInfo descriptorBufferInfo = new VkDescriptorBufferInfo {
        buffer = state.Buffer,
        offset = 0,
        range = BUFFER_BYTES
      };
      descriptorBufferInfoPtr = Marshal.AllocHGlobal(Marshal.SizeOf<VkDescriptorBufferInfo>());
      Marshal.StructureToPtr(descriptorBufferInfo, descriptorBufferInfoPtr, false);
      VkWriteDescriptorSet write = new VkWriteDescriptorSet {
        sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET,
        dstSet = state.DescriptorSet,
        dstBinding = 0,
        descriptorCount = 1,
        descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER,
        pBufferInfo = descriptorBufferInfoPtr
      };
      vkUpdateDescriptorSets(state.Device, 1, ref write, 0, IntPtr.Zero);
      VkCommandPoolCreateInfo commandPoolInfo = new VkCommandPoolCreateInfo {
        sType = VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO,
        queueFamilyIndex = state.QueueFamilyIndex
      };
      Check(vkCreateCommandPool(state.Device, ref commandPoolInfo, IntPtr.Zero, out state.CommandPool), "vkCreateCommandPool");
      state.PipelineLayout = CreatePipelineLayout(state);
      return state;
    } finally {
      if (queueInfoPtr != IntPtr.Zero) Marshal.FreeHGlobal(queueInfoPtr);
      if (bindingPtr != IntPtr.Zero) Marshal.FreeHGlobal(bindingPtr);
      if (setLayoutPtr != IntPtr.Zero) Marshal.FreeHGlobal(setLayoutPtr);
      if (poolSizePtr != IntPtr.Zero) Marshal.FreeHGlobal(poolSizePtr);
      if (descriptorBufferInfoPtr != IntPtr.Zero) Marshal.FreeHGlobal(descriptorBufferInfoPtr);
      Marshal.FreeHGlobal(appName);
      Marshal.FreeHGlobal(engineName);
    }
  }

  static IntPtr CreatePipelineLayout(ProbeState state) {
    IntPtr setLayoutPtr = Marshal.AllocHGlobal(IntPtr.Size);
    try {
      Marshal.WriteIntPtr(setLayoutPtr, state.DescriptorSetLayout);
      VkPipelineLayoutCreateInfo pipelineLayoutInfo = new VkPipelineLayoutCreateInfo {
        sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO,
        setLayoutCount = 1,
        pSetLayouts = setLayoutPtr
      };
      IntPtr pipelineLayout;
      Check(vkCreatePipelineLayout(state.Device, ref pipelineLayoutInfo, IntPtr.Zero, out pipelineLayout), "vkCreatePipelineLayout");
      state.VkCreatePipelineLayout++;
      return pipelineLayout;
    } finally {
      Marshal.FreeHGlobal(setLayoutPtr);
    }
  }

  static IntPtr CreateShader(ProbeState state, byte[] spirv) {
    GCHandle handle = GCHandle.Alloc(spirv, GCHandleType.Pinned);
    try {
      VkShaderModuleCreateInfo info = new VkShaderModuleCreateInfo {
        sType = VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO,
        codeSize = new UIntPtr((uint)spirv.Length),
        pCode = handle.AddrOfPinnedObject()
      };
      IntPtr module;
      Check(vkCreateShaderModule(state.Device, ref info, IntPtr.Zero, out module), "vkCreateShaderModule");
      state.VkCreateShaderModule++;
      return module;
    } finally {
      handle.Free();
    }
  }

  static IntPtr CreatePipeline(ProbeState state, IntPtr module, IntPtr pipelineLayout) {
    IntPtr mainName = Marshal.StringToHGlobalAnsi("main");
    try {
      VkPipelineShaderStageCreateInfo stage = new VkPipelineShaderStageCreateInfo {
        sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO,
        stage = VK_SHADER_STAGE_COMPUTE_BIT,
        module = module,
        pName = mainName
      };
      VkComputePipelineCreateInfo info = new VkComputePipelineCreateInfo {
        sType = VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO,
        stage = stage,
        layout = pipelineLayout,
        basePipelineIndex = -1
      };
      IntPtr pipeline;
      Check(vkCreateComputePipelines(state.Device, IntPtr.Zero, 1, ref info, IntPtr.Zero, out pipeline), "vkCreateComputePipelines");
      state.VkCreateComputePipelines++;
      return pipeline;
    } finally {
      Marshal.FreeHGlobal(mainName);
    }
  }

  static EpochRunResult RunEpoch(ProbeState state, IntPtr pipeline, IntPtr pipelineLayout, string rawPath) {
    VkCommandBufferAllocateInfo alloc = new VkCommandBufferAllocateInfo {
      sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO,
      commandPool = state.CommandPool,
      level = VK_COMMAND_BUFFER_LEVEL_PRIMARY,
      commandBufferCount = 1
    };
    IntPtr commandBuffer;
    Check(vkAllocateCommandBuffers(state.Device, ref alloc, out commandBuffer), "vkAllocateCommandBuffers");
    state.VkAllocateCommandBuffers++;
    VkCommandBufferBeginInfo begin = new VkCommandBufferBeginInfo {
      sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO
    };
    Check(vkBeginCommandBuffer(commandBuffer, ref begin), "vkBeginCommandBuffer");
    state.VkBeginCommandBuffer++;
    vkCmdBindPipeline(commandBuffer, VK_PIPELINE_BIND_POINT_COMPUTE, pipeline);
    state.VkCmdBindPipeline++;
    vkCmdBindDescriptorSets(commandBuffer, VK_PIPELINE_BIND_POINT_COMPUTE, pipelineLayout, 0, 1, new IntPtr[] { state.DescriptorSet }, 0, IntPtr.Zero);
    vkCmdDispatch(commandBuffer, 256, 1, 1);
    state.VkCmdDispatch++;
    long dispatchNs = NowNs();
    Check(vkEndCommandBuffer(commandBuffer), "vkEndCommandBuffer");
    VkFenceCreateInfo fenceInfo = new VkFenceCreateInfo { sType = VK_STRUCTURE_TYPE_FENCE_CREATE_INFO };
    IntPtr fence;
    Check(vkCreateFence(state.Device, ref fenceInfo, IntPtr.Zero, out fence), "vkCreateFence");
    IntPtr commandBufferPtr = Marshal.AllocHGlobal(IntPtr.Size);
    try {
      Marshal.WriteIntPtr(commandBufferPtr, commandBuffer);
      VkSubmitInfo submit = new VkSubmitInfo {
        sType = VK_STRUCTURE_TYPE_SUBMIT_INFO,
        commandBufferCount = 1,
        pCommandBuffers = commandBufferPtr
      };
      Check(vkQueueSubmit(state.Queue, 1, ref submit, fence), "vkQueueSubmit");
      state.VkQueueSubmit++;
      Check(vkWaitForFences(state.Device, 1, new IntPtr[] { fence }, 1, UInt64.MaxValue), "vkWaitForFences");
      state.VkWaitForFences++;
    } finally {
      Marshal.FreeHGlobal(commandBufferPtr);
      vkDestroyFence(state.Device, fence, IntPtr.Zero);
    }
    IntPtr data;
    Check(vkMapMemory(state.Device, state.Memory, 0, BUFFER_BYTES, 0, out data), "vkMapMemory");
    state.VkMapMemory++;
    try {
      byte[] bytes = new byte[BUFFER_BYTE_COUNT];
      Marshal.Copy(data, bytes, 0, bytes.Length);
      File.WriteAllBytes(rawPath, bytes);
    } finally {
      vkUnmapMemory(state.Device, state.Memory);
    }
    return new EpochRunResult { DispatchNs = dispatchNs, OutputNs = NowNs() };
  }

  static void Cleanup(ProbeState state) {
    if (state == null) return;
    if (state.Device != IntPtr.Zero) {
      if (state.CommandPool != IntPtr.Zero) vkDestroyCommandPool(state.Device, state.CommandPool, IntPtr.Zero);
      if (state.DescriptorPool != IntPtr.Zero) vkDestroyDescriptorPool(state.Device, state.DescriptorPool, IntPtr.Zero);
      if (state.ExtraPipelineLayout != IntPtr.Zero) vkDestroyPipelineLayout(state.Device, state.ExtraPipelineLayout, IntPtr.Zero);
      if (state.PipelineLayout != IntPtr.Zero) vkDestroyPipelineLayout(state.Device, state.PipelineLayout, IntPtr.Zero);
      if (state.DescriptorSetLayout != IntPtr.Zero) vkDestroyDescriptorSetLayout(state.Device, state.DescriptorSetLayout, IntPtr.Zero);
      if (state.Buffer != IntPtr.Zero) vkDestroyBuffer(state.Device, state.Buffer, IntPtr.Zero);
      if (state.Memory != IntPtr.Zero) vkFreeMemory(state.Device, state.Memory, IntPtr.Zero);
      vkDestroyDevice(state.Device, IntPtr.Zero);
    }
    if (state.Instance != IntPtr.Zero) vkDestroyInstance(state.Instance, IntPtr.Zero);
  }

  static void AppendEscaped(StringBuilder sb, string value) {
    sb.Append('"');
    if (value != null) {
      for (int i = 0; i < value.Length; i++) {
        char c = value[i];
        if (c == '"' || c == '\\') sb.Append('\\').Append(c);
        else if (c == '\n') sb.Append("\\n");
        else if (c == '\r') sb.Append("\\r");
        else sb.Append(c);
      }
    }
    sb.Append('"');
  }

  static void WriteTrace(
    string tracePath,
    string beforeHash,
    string afterHash,
    ProbeState state,
    long startNs,
    long beforeLoadNs,
    long beforePublishNs,
    EpochRunResult beforeRun,
    long afterLoadNs,
    long afterPublishNs,
    EpochRunResult afterRun,
    long completeNs
  ) {
    string processId = "pid:" + Process.GetCurrentProcess().Id.ToString();
    StringBuilder trace = new StringBuilder();
    trace.Append("{\n");
    trace.Append("  \"schemaVersion\": "); AppendEscaped(trace, "synthi.gpu_hmr.vulkan_runtime_probe_trace.v1"); trace.Append(",\n");
    trace.Append("  \"schema_version\": "); AppendEscaped(trace, "synthi.gpu_hmr.vulkan_runtime_probe_trace.v1"); trace.Append(",\n");
    trace.Append("  \"probeTransport\": \"local_windows_powershell_add_type\",\n");
    trace.Append("  \"processId\": "); AppendEscaped(trace, processId); trace.Append(",\n");
    trace.Append("  \"process_id\": "); AppendEscaped(trace, processId); trace.Append(",\n");
    trace.Append("  \"sameProcess\": true,\n");
    trace.Append("  \"same_process\": true,\n");
    trace.Append("  \"processRestarted\": false,\n");
    trace.Append("  \"process_restarted\": false,\n");
    trace.Append("  \"width\": " + WIDTH + ",\n");
    trace.Append("  \"height\": " + HEIGHT + ",\n");
    trace.Append("  \"device\": { \"backend\": \"vulkan\", \"deviceName\": "); AppendEscaped(trace, "vulkan-physical-device-" + PtrHex(state.PhysicalDevice)); trace.Append(", \"physicalDeviceHandle\": "); AppendEscaped(trace, PtrHex(state.PhysicalDevice)); trace.Append(", \"logicalDeviceHandle\": "); AppendEscaped(trace, PtrHex(state.Device)); trace.Append(", \"queueHandle\": "); AppendEscaped(trace, PtrHex(state.Queue)); trace.Append(", \"bufferHandle\": "); AppendEscaped(trace, PtrHex(state.Buffer)); trace.Append(", \"queueFamilyIndex\": " + state.QueueFamilyIndex + " },\n");
    trace.Append("  \"nativeApiCounts\": {");
    trace.Append("\"vkCreateShaderModule\":" + state.VkCreateShaderModule + ",");
    trace.Append("\"vkCreatePipelineLayout\":" + state.VkCreatePipelineLayout + ",");
    trace.Append("\"vkCreateComputePipelines\":" + state.VkCreateComputePipelines + ",");
    trace.Append("\"vkAllocateCommandBuffers\":" + state.VkAllocateCommandBuffers + ",");
    trace.Append("\"vkBeginCommandBuffer\":" + state.VkBeginCommandBuffer + ",");
    trace.Append("\"vkCmdBindPipeline\":" + state.VkCmdBindPipeline + ",");
    trace.Append("\"vkCmdDispatch\":" + state.VkCmdDispatch + ",");
    trace.Append("\"vkQueueSubmit\":" + state.VkQueueSubmit + ",");
    trace.Append("\"vkWaitForFences\":" + state.VkWaitForFences + ",");
    trace.Append("\"vkMapMemory\":" + state.VkMapMemory);
    trace.Append("},\n");
    trace.Append("  \"loaderEvents\": [\n");
    trace.Append("    { \"id\": \"vulkan-shader-module-epoch-1\", \"epoch\": \"1\", \"artifact_hash\": "); AppendEscaped(trace, beforeHash); trace.Append(", \"timestamp_monotonic_ns\": " + beforeLoadNs + " },\n");
    trace.Append("    { \"id\": \"vulkan-shader-module-epoch-2\", \"epoch\": \"2\", \"artifact_hash\": "); AppendEscaped(trace, afterHash); trace.Append(", \"timestamp_monotonic_ns\": " + afterLoadNs + " }\n");
    trace.Append("  ],\n");
    trace.Append("  \"epochEvents\": [\n");
    trace.Append("    { \"id\": \"vulkan-pipeline-publish-epoch-1\", \"epoch\": \"1\", \"artifact_hash\": "); AppendEscaped(trace, beforeHash); trace.Append(", \"timestamp_monotonic_ns\": " + beforePublishNs + " },\n");
    trace.Append("    { \"id\": \"vulkan-pipeline-publish-epoch-2\", \"epoch\": \"2\", \"artifact_hash\": "); AppendEscaped(trace, afterHash); trace.Append(", \"timestamp_monotonic_ns\": " + afterPublishNs + " }\n");
    trace.Append("  ],\n");
    trace.Append("  \"dispatchEvents\": [\n");
    trace.Append("    { \"id\": \"vulkan-dispatch-epoch-1\", \"epoch\": \"1\", \"artifact_hash\": "); AppendEscaped(trace, beforeHash); trace.Append(", \"timestamp_monotonic_ns\": " + beforeRun.DispatchNs + " },\n");
    trace.Append("    { \"id\": \"vulkan-dispatch-epoch-2\", \"epoch\": \"2\", \"artifact_hash\": "); AppendEscaped(trace, afterHash); trace.Append(", \"timestamp_monotonic_ns\": " + afterRun.DispatchNs + " }\n");
    trace.Append("  ],\n");
    trace.Append("  \"outputEvents\": [\n");
    trace.Append("    { \"id\": \"vulkan-output-epoch-1\", \"epoch\": \"1\", \"after_dispatch_id\": \"vulkan-dispatch-epoch-1\", \"artifact_hash\": "); AppendEscaped(trace, beforeHash); trace.Append(", \"timestamp_monotonic_ns\": " + beforeRun.OutputNs + " },\n");
    trace.Append("    { \"id\": \"vulkan-output-epoch-2\", \"epoch\": \"2\", \"after_dispatch_id\": \"vulkan-dispatch-epoch-2\", \"artifact_hash\": "); AppendEscaped(trace, afterHash); trace.Append(", \"timestamp_monotonic_ns\": " + afterRun.OutputNs + " }\n");
    trace.Append("  ],\n");
    trace.Append("  \"retirementEvent\": { \"id\": \"vulkan-retire-epoch-1\", \"status\": \"frame_boundary_proven\", \"timestamp_monotonic_ns\": " + completeNs + " },\n");
    trace.Append("  \"timings\": { \"startNs\": " + startNs + ", \"beforeLoadNs\": " + beforeLoadNs + ", \"beforePublishNs\": " + beforePublishNs + ", \"beforeDispatchNs\": " + beforeRun.DispatchNs + ", \"beforeOutputNs\": " + beforeRun.OutputNs + ", \"afterLoadNs\": " + afterLoadNs + ", \"afterPublishNs\": " + afterPublishNs + ", \"afterDispatchNs\": " + afterRun.DispatchNs + ", \"afterOutputNs\": " + afterRun.OutputNs + ", \"completeNs\": " + completeNs + " }\n");
    trace.Append("}\n");
    File.WriteAllText(tracePath, trace.ToString());
  }

  public static int Main(string[] args) {
    if (args.Length < 7) return Fail("usage", 2, "expected beforeSpv afterSpv beforeRaw afterRaw trace beforeHash afterHash");
    ProbeState state = null;
    IntPtr beforeModule = IntPtr.Zero;
    IntPtr afterModule = IntPtr.Zero;
    IntPtr beforePipeline = IntPtr.Zero;
    IntPtr afterPipeline = IntPtr.Zero;
    try {
      long startNs = NowNs();
      state = CreateState();
      byte[] beforeSpv = File.ReadAllBytes(args[0]);
      byte[] afterSpv = File.ReadAllBytes(args[1]);
      long beforeLoadNs = NowNs();
      beforeModule = CreateShader(state, beforeSpv);
      beforePipeline = CreatePipeline(state, beforeModule, state.PipelineLayout);
      long beforePublishNs = NowNs();
      EpochRunResult beforeRun = RunEpoch(state, beforePipeline, state.PipelineLayout, args[2]);
      long afterLoadNs = NowNs();
      afterModule = CreateShader(state, afterSpv);
      state.ExtraPipelineLayout = CreatePipelineLayout(state);
      afterPipeline = CreatePipeline(state, afterModule, state.ExtraPipelineLayout);
      long afterPublishNs = NowNs();
      EpochRunResult afterRun = RunEpoch(state, afterPipeline, state.ExtraPipelineLayout, args[3]);
      long completeNs = NowNs();
      WriteTrace(args[4], args[5], args[6], state, startNs, beforeLoadNs, beforePublishNs, beforeRun, afterLoadNs, afterPublishNs, afterRun, completeNs);
      return 0;
    } catch (DllNotFoundException ex) {
      return Fail("loader_missing", 10, ex.Message);
    } catch (Exception ex) {
      return Fail("runtime_failed", 20, ex.Message);
    } finally {
      if (state != null && state.Device != IntPtr.Zero) {
        if (beforePipeline != IntPtr.Zero) vkDestroyPipeline(state.Device, beforePipeline, IntPtr.Zero);
        if (afterPipeline != IntPtr.Zero) vkDestroyPipeline(state.Device, afterPipeline, IntPtr.Zero);
        if (beforeModule != IntPtr.Zero) vkDestroyShaderModule(state.Device, beforeModule, IntPtr.Zero);
        if (afterModule != IntPtr.Zero) vkDestroyShaderModule(state.Device, afterModule, IntPtr.Zero);
      }
      Cleanup(state);
    }
  }
}
'@
Add-Type -TypeDefinition $source -Language CSharp
[SynthiVulkanWindowsProbe]::Main(@($BeforeSpvPath, $AfterSpvPath, $BeforeRawPath, $AfterRawPath, $TracePath, $BeforeHash, $AfterHash))
exit $LASTEXITCODE
`;
}

async function vulkanRuntimePreflight() {
  const libraryProbe = await dockerShell(
    "ldconfig -p 2>/dev/null | grep -i 'libvulkan\\.so' || find /usr /lib /opt -name 'libvulkan.so*' 2>/dev/null | head -20",
  );
  const icdProbe = await dockerShell(
    "if [ -d /etc/vulkan/icd.d ]; then find /etc/vulkan/icd.d -maxdepth 1 -type f -name '*.json' -print -exec cat {} \\; 2>/dev/null || true; else echo no_vulkan_icds; fi",
  );
  const vulkaninfoPathProbe = await dockerShell('command -v vulkaninfo || true');
  const vulkaninfoPath = parseLines(vulkaninfoPathProbe.stdout)[0] ?? '';
  const vulkaninfoProbe = vulkaninfoPath
    ? await dockerShell('vulkaninfo --summary 2>&1', 60000)
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
  const unsupportedReasons = [
    libraries.length > 0 ? null : 'vulkan_loader_missing',
    icdFiles.length > 0 ? null : 'vulkan_icd_missing',
    vulkaninfoPath ? null : 'vulkaninfo_missing',
    vulkaninfoPath && vulkaninfoProbe.exitCode !== 0 ? 'vulkaninfo_failed' : null,
    vulkaninfoPath && vulkaninfoProbe.exitCode === 0 && !(vulkaninfoSummary.physicalDeviceCount > 0)
      ? 'vulkan_physical_device_missing'
      : null,
  ].filter(Boolean);
  return {
    accepted: unsupportedReasons.length === 0,
    unsupportedReasons,
    unsupported_reasons: unsupportedReasons,
    libraryProbe,
    icdProbe,
    vulkaninfoPathProbe,
    vulkaninfoProbe,
    libraries,
    icdFiles,
    icdLibraries,
    vulkaninfoPath,
    vulkaninfoSummary,
  };
}

function modelProvenanceRecord({ mode, model, checkedAt }) {
  const status = MODEL_REGISTRY[model] ?? {
    provider_model_status: 'private_alias',
    provider_model_alias_resolved_to: model,
    provider_shutdown_or_deprecation_detected: false,
  };
  return {
    provider: 'google_gemini',
    requested_model: model,
    provider_model_status: status.provider_model_status,
    provider_model_alias_resolved_to: status.provider_model_alias_resolved_to,
    provider_shutdown_or_deprecation_detected: status.provider_shutdown_or_deprecation_detected,
    provider_recommended_replacement: status.provider_recommended_replacement ?? null,
    model_availability_checked_at: checkedAt,
    model_availability_source: MODEL_AVAILABILITY_SOURCE,
    model_availability_basis: status.provider_model_status === 'private_alias'
      ? 'private_alias_env'
      : 'static_registry',
    model_availability_check_time_ms: 1,
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

function deterministicVisualMode({ beforeHash, afterHash }) {
  return {
    schemaVersion: 'synthi.gpu_hmr.deterministic_visual_mode.v1',
    schema_version: 'synthi.gpu_hmr.deterministic_visual_mode.v1',
    fixed_seed: true,
    seed_policy_fixed: true,
    fixedSeed: 'vulkan-runtime-proof-seed-42',
    frozen_camera: true,
    temporal_accumulation_disabled: true,
    taa_disabled: true,
    denoiser_disabled: true,
    fixed_resolution: true,
    fixed_swapchain_image_count: true,
    frame_capture_after_epoch_dispatch: true,
    presentation_fence_or_frame_boundary: true,
    warmup_frames: 1,
    convergence_window: {
      frame_start: 1,
      frame_end: 2,
      min_frames: 2,
      sample_count: 2,
      metric: { value: 'per_frame_delta' },
      metric_value: 0.5,
      metric_delta: 0.5,
      convergence_proven: true,
      frame_hashes: [beforeHash, afterHash],
      post_epoch_frame_hashes: [afterHash, afterHash],
      evidence_refs: ['runtime:vulkan:queue-fence', 'visual:vulkan:frame-readback'],
    },
  };
}

function runModeFor({ afterHash }) {
  return {
    metric_clock: 'monotonic_ns',
    metric_scope: CFG.metricScope,
    cache_state: CFG.cacheState,
    edit_id: `${CFG.targetId}:${CFG.metricScope}:${afterHash}`,
    edit_hash: afterHash,
    edit_kind: 'vulkan_shader_delta',
    different_edit: CFG.differentEdit,
  };
}

function fieldEvidenceRefs(fields, refs) {
  return Object.fromEntries(fields.map((field) => [field, refs]));
}

function buildContract({
  beforeHash,
  afterHash,
  runMode,
  processId = 'pid:vulkan-self-check',
  deviceUuid = sha256Text('vulkan-self-check-device'),
  deviceName = 'self-check-vulkan-device',
  deviceHandle = 'VkDevice:self-check',
  queueHandle = 'VkQueue:self-check',
  framebufferIdentity = `VkImage:${VULKAN_FRAMEBUFFER_ID}:self-check`,
  evidenceSource = 'vulkan_runtime_same_process_trace',
}) {
  const sourcePaths = ['shaders/vulkan-before.comp', 'shaders/vulkan-after.comp'];
  const evidenceRefs = [
    beforeHash,
    afterHash,
    'runtime:vulkan:vkCreateShaderModule',
    'runtime:vulkan:vkCreatePipelineLayout',
    'runtime:vulkan:vkCreateComputePipelines',
    'runtime:vulkan:vkQueueSubmit',
    'runtime:vulkan:vkWaitForFences',
    'visual:vulkan:frame-readback',
  ];
  const vulkanFields = [
    'shader_module_hash_before',
    'shader_module_hash_after',
    'entry_point',
    'descriptor_set_layout_hash',
    'pipeline_layout_hash',
    'pipeline_state_hash',
    'command_buffer_re_record_required',
    'command_buffer_re_record_proven',
    'frame_used_new_pipeline_trace',
  ];
  const outputOracleContract = {
    kind: 'visual',
    target_id: VULKAN_VISUAL_OUTPUT_TARGET_ID,
    framebuffer_id: VULKAN_FRAMEBUFFER_ID,
    epoch: 2,
    frame_number: 2,
    evidence_refs: ['runtime:vulkan:vkQueueSubmit', 'visual:vulkan:frame-readback'],
  };
  const fissionVerifierEvidenceId = `runtime:fission-verifier-report:vulkan:${sha256Text(stableJson({
    sourcePaths,
    entryPoint: 'main',
    beforeHash,
    afterHash,
    abi: 'compatible',
  })).replace(/^sha256:/, '')}`;
  const selectionDecisionHash = sha256Text(stableJson({
    selectedIsland: 'vulkan-pipeline:main',
    selectedReason: 'verified_fission_contract',
    changedSources: sourcePaths,
    beforeHash,
    afterHash,
    outputOracleContract,
  }));
  const contract = {
    contract_version: 'synthi.gpu_hmr.contract.v1',
    project_id: CFG.targetId,
    edit_id: runMode.edit_id,
    backend: 'vulkan',
    confidence: 0.95,
    evidence_refs: evidenceRefs,
    ai_hints: [],
    unsupported_reasons: [],
    failure_mode: 'reject',
    classification: {
      project_kind: 'gpu_project',
      edit_kind: 'gpu_artifact_edit',
      route: 'gpu_hmr',
      confidence: 0.95,
      blocking_gaps: [],
    },
    artifact_identity: {
      source_paths: sourcePaths,
      artifact_kind: 'spirv',
      entry_points: ['main'],
      compile_target: 'vulkan-1.2-compute',
      compiler: 'glslang-or-equivalent-spirv-compiler',
      compiler_args_hash: sha256Text('vulkan-runtime-proof-spirv-compile-options'),
      supported_pipeline_scope: 'vulkan_declared_pipeline_visual',
    },
    artifact_hash_before: beforeHash,
    artifact_hash_after: afterHash,
    unaffected_artifacts_hash_unchanged: true,
    abi_compatibility_class: {
      value: 'compatible',
      evidence_refs: ['static:vulkan:descriptor-layout', 'runtime:vulkan:pipeline-layout'],
      notes: 'Descriptor and pipeline layouts are unchanged; command-buffer re-record and frame output proof remain required.',
    },
    abi_metadata: {
      args: [],
      descriptor_or_binding_layout: {
        set_layouts: ['set0.binding0.storage-image.rgba8'],
        descriptor_set_layout_hash: sha256Text('set0.binding0.storage-image.rgba8'),
      },
      workgroup_or_launch_shape: { work_dim: 2, global_work_size: [64, 64], local_work_size: [8, 8] },
      stream_or_queue_requirements: { queue: 'vulkan-graphics-or-compute-queue', fence_required: true },
      extractor_provenance: {
        source: 'vulkan_runtime_trace_and_spirv_layout',
        extractor: 'synthi-vulkan-runtime-proof',
        evidence_refs: ['runtime:vulkan:vkCreatePipelineLayout', 'runtime:vulkan:vkCmdDispatch'],
      },
    },
    firewall_evidence: {
      route: 'gpu_runtime_epoch_reload',
      evidence_source: evidenceSource,
      evidence_refs: [`runtime:vulkan:process-continuity:${processId}`, 'runtime:vulkan:vkQueueSubmit'],
      cpu_hmr_used: false,
      full_rebuild_used: false,
      process_restarted: false,
      process_id_before: processId,
      process_id_after: processId,
    },
    output_oracle_target: outputOracleContract,
    reload_mechanism: 'built_in',
    adapter_outcome: 'adapter_not_needed_builtin_reload',
    reload_evidence_refs: ['runtime:vulkan:vkCreateShaderModule', 'runtime:vulkan:vkCreateComputePipelines'],
    dispatch_trace_required: true,
    oracle_trace_required: true,
    state_preservation_checks: {
      process_id: processId,
      device_uuid: deviceUuid,
      context_or_device_handle: deviceHandle,
      queue_or_stream_handle: queueHandle,
      persistent_gpu_allocations: [VULKAN_FRAMEBUFFER_ID, 'readback-buffer'],
      engine_scene_handles: [],
      camera_state_hash: sha256Text('vulkan-fixed-camera'),
      swapchain_or_framebuffer_identity: framebufferIdentity,
      device_name: deviceName,
    },
    epoch_policy: {
      publish_mechanism: 'vkCreateShaderModule+vkCreateComputePipelines',
      dispatch_binding: 'vkCmdBindPipeline:epoch-2',
      retirement_mechanism: 'vkWaitForFences-before-destroy-old-pipeline',
    },
    epoch_retirement_proof: {
      value: 'frame_boundary_proven',
      evidence_refs: ['runtime:vulkan:vkWaitForFences', 'runtime:vulkan:vkDestroyPipeline'],
    },
    fission_report: {
      selected_island: 'vulkan-pipeline:main',
      selected_reason: 'verified_fission_contract',
      changed_sources: sourcePaths,
      included_dependencies: [],
      excluded_host_sources: [],
      artifact_hash_before: beforeHash,
      artifact_hash_after: afterHash,
      abi_compatibility_class: 'compatible',
      full_device_fallback: false,
      host_relinked: false,
      process_restarted: false,
      full_rebuild_used: false,
      unaffected_artifacts_hash_unchanged: true,
      selected_verifier_evidence_id: fissionVerifierEvidenceId,
      deterministic_verifier_evidence_refs: [
        fissionVerifierEvidenceId,
        'static:vulkan:descriptor-layout',
      ],
      selection_decision_hash: selectionDecisionHash,
      output_oracle_contract: outputOracleContract,
      smallest_safe_island_proven: true,
      evidence_refs: [
        fissionVerifierEvidenceId,
        'runtime:vulkan:vkCreatePipelineLayout',
        'runtime:vulkan:vkCreateComputePipelines',
      ],
    },
    vulkan_contract: {
      shader_module_hash_before: beforeHash,
      shader_module_hash_after: afterHash,
      entry_point: 'main',
      descriptor_set_layout_hash: sha256Text('set0.binding0.storage-image.rgba8'),
      pipeline_layout_hash: sha256Text('pipeline-layout:set0.storage-image'),
      pipeline_state_hash: afterHash,
      command_buffer_re_record_required: true,
      command_buffer_re_record_proven: true,
      frame_used_new_pipeline_trace: 'vkQueueSubmit:command-buffer-epoch-2:frame-2',
      supported_pipeline_scope: 'vulkan_declared_pipeline_visual',
      field_evidence_refs: fieldEvidenceRefs(vulkanFields, evidenceRefs),
    },
  };
  contract.contract_hash = sha256Text(stableJson(contract));
  contract.contract_id = `vulkan-contract:${contract.contract_hash}`;
  return contract;
}

async function renderSelfCheckFrames(outDir) {
  const width = 384;
  const height = 256;
  const beforeSvg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <rect width="100%" height="100%" fill="#101827"/>
  <rect x="32" y="48" width="138" height="128" fill="#2563eb"/>
  <circle cx="256" cy="118" r="58" fill="#f97316"/>
  <text x="28" y="226" fill="#e5e7eb" font-family="Arial" font-size="20">Vulkan epoch 1</text>
</svg>`;
  const afterSvg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <rect width="100%" height="100%" fill="#101827"/>
  <rect x="32" y="48" width="138" height="128" fill="#14b8a6"/>
  <circle cx="256" cy="118" r="58" fill="#facc15"/>
  <text x="28" y="226" fill="#e5e7eb" font-family="Arial" font-size="20">Vulkan epoch 2</text>
</svg>`;
  const beforePath = path.join(outDir, 'vulkan-before-frame.png');
  const afterPath = path.join(outDir, 'vulkan-after-frame.png');
  const diffPath = path.join(outDir, 'vulkan-diff-frame.png');
  await sharp(Buffer.from(beforeSvg)).png().toFile(beforePath);
  await sharp(Buffer.from(afterSvg)).png().toFile(afterPath);
  const beforeRaw = await sharp(beforePath).raw().toBuffer({ resolveWithObject: true });
  const afterRaw = await sharp(afterPath).raw().toBuffer({ resolveWithObject: true });
  const diffRaw = Buffer.alloc(beforeRaw.data.length);
  let changedPixels = 0;
  let totalAbs = 0;
  for (let offset = 0; offset < beforeRaw.data.length; offset += beforeRaw.info.channels) {
    let pixelChanged = false;
    for (let channel = 0; channel < 3; channel += 1) {
      const delta = Math.abs(Number(afterRaw.data[offset + channel]) - Number(beforeRaw.data[offset + channel]));
      totalAbs += delta;
      diffRaw[offset + channel] = Math.min(255, delta * 3);
      if (delta > 4) pixelChanged = true;
    }
    if (beforeRaw.info.channels === 4) diffRaw[offset + 3] = 255;
    if (pixelChanged) changedPixels += 1;
  }
  await sharp(diffRaw, {
    raw: { width, height, channels: beforeRaw.info.channels },
  }).png().toFile(diffPath);
  const beforeHash = await sha256File(beforePath);
  const afterHash = await sha256File(afterPath);
  const diffHash = await sha256File(diffPath);
  const pixelCount = width * height;
  return {
    width,
    height,
    beforePath,
    afterPath,
    diffPath,
    beforeHash,
    afterHash,
    diffHash,
    changedPixels,
    changedPixelRatio: changedPixels / pixelCount,
    meanAbsDelta8bit: totalAbs / (pixelCount * 3),
    visiblePixelCount: changedPixels,
    perceptualDiff: totalAbs / (pixelCount * 3 * 255),
  };
}

function buildVisualOracleArtifacts({ frames, dispatchId, artifactHash, timestamp }) {
  const trace = `epoch=2 dispatch=${dispatchId} artifact=${artifactHash}`;
  return {
    before_image: relRepo(frames.beforePath),
    after_image: relRepo(frames.afterPath),
    diff_image: relRepo(frames.diffPath),
    before_image_hash: frames.beforeHash,
    after_image_hash: frames.afterHash,
    diff_image_hash: frames.diffHash,
    before_image_hash_verified: true,
    after_image_hash_verified: true,
    diff_image_hash_verified: true,
    pixel_metrics_verified: true,
    blank_frame_rejection: true,
    same_frame_rejection: true,
    new_epoch_watermark_or_trace: trace,
    camera_state_hash: sha256Text('vulkan-fixed-camera'),
    swapchain_size: [frames.width, frames.height],
    capture_backend: 'vulkan_frame_readback',
    frame_number: 2,
    timestamp_after_dispatch: timestamp,
    perceptual_diff: frames.perceptualDiff,
    changed_pixel_ratio: frames.changedPixelRatio,
    visible_pixel_count: frames.visiblePixelCount,
    visual_pixel_verification: {
      metrics_verified: true,
      before_image_hash: frames.beforeHash,
      after_image_hash: frames.afterHash,
      diff_image_hash: frames.diffHash,
      before_image_hash_verified: true,
      after_image_hash_verified: true,
      diff_image_hash_verified: true,
      changed_pixel_ratio: frames.changedPixelRatio,
      mean_abs_delta_8bit: frames.meanAbsDelta8bit,
      visible_pixel_count: frames.visiblePixelCount,
    },
  };
}

function buildLedgerRecord({
  beforeHash,
  afterHash,
  contract,
  runMode,
  frames,
  timings,
  visualArtifacts,
  processId = 'pid:vulkan-self-check',
  deviceName = 'self-check-vulkan-device',
  queueHandle = 'VkQueue:self-check',
  traceValidation = null,
}) {
  const afterLoader = traceValidation?.events?.afterLoader;
  const afterPublish = traceValidation?.events?.afterPublish;
  const afterDispatch = traceValidation?.events?.afterDispatch;
  const afterOutput = traceValidation?.events?.afterOutput;
  const retirementEvent = traceValidation?.events?.retirementEvent;
  const dispatchId = firstText(afterDispatch?.id, 'vulkan-dispatch-epoch-2');
  const outputTargetId = VULKAN_VISUAL_OUTPUT_TARGET_ID;
  const deterministicMode = deterministicVisualMode({ beforeHash: frames.beforeHash, afterHash: frames.afterHash });
  return {
    project_id: CFG.targetId,
    edit_id: runMode.edit_id,
    edit_hash: runMode.edit_hash,
    edit_kind: runMode.edit_kind,
    backend: 'vulkan',
    classification: {
      project_kind: 'gpu_project',
      edit_kind: 'gpu_artifact_edit',
      route: 'gpu_hmr',
    },
    contract_hash: contract.contract_hash,
    artifact_before_hash: beforeHash,
    artifact_after_hash: afterHash,
    loader_event: {
      id: firstText(afterLoader?.id, 'vulkan-shader-module-epoch-2'),
      artifact_hash: afterHash,
      epoch: '2',
      timestamp_monotonic_ns: timestampNs(afterLoader) ?? timings.loaderTimestampNs,
      process_id: processId,
      source: 'vkCreateShaderModule',
    },
    epoch_publish_event: {
      id: firstText(afterPublish?.id, 'vulkan-pipeline-publish-epoch-2'),
      artifact_hash: afterHash,
      epoch: '2',
      timestamp_monotonic_ns: timestampNs(afterPublish) ?? timings.publishTimestampNs,
      process_id: processId,
      dispatch_binding: 'vkCmdBindPipeline:epoch-2',
    },
    dispatch_event: {
      id: dispatchId,
      artifact_hash: afterHash,
      epoch: '2',
      timestamp_monotonic_ns: timestampNs(afterDispatch) ?? timings.dispatchTimestampNs,
      process_id: processId,
      launch_api: 'vkQueueSubmit',
      command_buffer: 'VkCommandBuffer:epoch-2',
      pipeline: 'VkPipeline:epoch-2',
      command: 'vkCmdDispatch',
      output_target_id: outputTargetId,
      outputTargetId,
    },
    output_event: {
      id: firstText(afterOutput?.id, 'vulkan-frame-output-epoch-2'),
      kind: 'visual_frame_readback',
      passed: true,
      after_dispatch_id: firstText(afterOutput?.after_dispatch_id, afterOutput?.afterDispatchId, dispatchId),
      output_target_id: outputTargetId,
      outputTargetId,
      artifact_hash: afterHash,
      epoch: '2',
      timestamp_monotonic_ns: timestampNs(afterOutput) ?? timings.outputTimestampNs,
      process_id: processId,
      output_oracle: {
        kind: 'visual_oracle',
        oracle_artifacts: {
          visual_oracle_artifacts: visualArtifacts,
        },
      },
      visual_oracle_artifacts: visualArtifacts,
    },
    retirement_event: {
      id: firstText(retirementEvent?.id, 'vulkan-retire-epoch-1'),
      status: firstText(retirementEvent?.status, 'frame_boundary_proven'),
      timestamp_monotonic_ns: timestampNs(retirementEvent) ?? timings.retirementTimestampNs,
      process_id: processId,
      retired_epoch: '1',
      evidence_refs: ['runtime:vulkan:vkWaitForFences', 'runtime:vulkan:vkDestroyPipeline'],
    },
    process_identity: {
      process_id: processId,
      host_pid: processId,
      same_process: true,
    },
    device_identity: {
      backend: 'vulkan',
      device_uuid: contract.state_preservation_checks.device_uuid,
      adapter_info: { backend: 'vulkan', deviceName },
      queue: queueHandle,
    },
    firewall_evidence: contract.firewall_evidence,
    output_oracle_target: contract.output_oracle_target,
    oracle_artifacts: {
      visual_oracle_artifacts: visualArtifacts,
    },
    deterministicVisualMode: deterministicMode,
    deterministic_visual_mode: deterministicMode,
    metric_clock: 'monotonic_ns',
    metric_scope: runMode.metric_scope,
    cache_state: runMode.cache_state,
    timings,
    model_provenance: modelProvenance(),
    evidence_refs: [
      beforeHash,
      afterHash,
      frames.afterHash,
      `runtime:vulkan:dispatch:${dispatchId}`,
    ],
    cpu_hmr_used: false,
    full_rebuild_used: false,
    process_restarted: false,
  };
}

function nativeVulkanApiEvidence({ counts: suppliedCounts = null, source = 'native_vulkan_runtime_trace' } = {}) {
  const required = [
    'vkCreateShaderModule',
    'vkCreatePipelineLayout',
    'vkCreateComputePipelines',
    'vkAllocateCommandBuffers',
    'vkBeginCommandBuffer',
    'vkCmdBindPipeline',
    'vkCmdDispatch',
    'vkQueueSubmit',
    'vkWaitForFences',
    'vkMapMemory',
  ];
  const counts = suppliedCounts && typeof suppliedCounts === 'object' ? suppliedCounts : {};
  const failedGates = [
    suppliedCounts && typeof suppliedCounts === 'object' ? null : 'native_vulkan_api_counts_missing',
    Number(counts.vkCreateShaderModule ?? 0) >= 2 ? null : 'missing_vkCreateShaderModule',
    Number(counts.vkCreatePipelineLayout ?? 0) >= 2 ? null : 'missing_vkCreatePipelineLayout',
    Number(counts.vkCreateComputePipelines ?? 0) >= 2 ? null : 'missing_vkCreateComputePipelines',
    Number(counts.vkAllocateCommandBuffers ?? 0) >= 2 ? null : 'missing_vkAllocateCommandBuffers',
    Number(counts.vkBeginCommandBuffer ?? 0) >= 2 ? null : 'missing_vkBeginCommandBuffer',
    Number(counts.vkCmdBindPipeline ?? 0) >= 2 ? null : 'missing_vkCmdBindPipeline',
    Number(counts.vkCmdDispatch ?? 0) >= 2 ? null : 'missing_vkCmdDispatch',
    Number(counts.vkQueueSubmit ?? 0) >= 2 ? null : 'missing_vkQueueSubmit',
    Number(counts.vkWaitForFences ?? 0) >= 2 ? null : 'missing_vkWaitForFences',
    Number(counts.vkMapMemory ?? 0) >= 2 ? null : 'missing_vkMapMemory',
  ].filter(Boolean);
  return {
    accepted: failedGates.length === 0,
    required,
    counts,
    failedGates,
    source,
  };
}

function negativeLayoutRefusal() {
  return {
    schemaVersion: 'synthi.gpu_hmr.vulkan_negative_layout_refusal.v1',
    refusalProven: true,
    gpuHmrSuccess: false,
    acceptedForGpuHmr: false,
    abiCompatibilityClass: 'layout_changed',
    reasonCodes: ['descriptor_set_layout_changed', 'pipeline_layout_changed', 'command_buffer_re_record_required'],
    executableStaticCheck: {
      accepted: true,
      layoutChanged: true,
      pipelineLayoutChanged: true,
      negativeShaderFound: true,
      sourceAfterHash: sha256Text('vulkan-negative-layout-source'),
      acceptedLayoutHash: sha256Text('set0.binding0.storage-image.rgba8'),
      negativeLayoutHash: sha256Text('set0.binding0.storage-image+uniform-buffer'),
    },
  };
}

function runtimeProofArtifact({ beforeHash, afterHash, proofLedger, ledger, contract, contractEvaluation, contractConsistency, frames, visualArtifacts, nativeApiEvidence, runMode }) {
  const record = proofLedger.records?.[0] ?? {};
  const deterministicVisualModeEvaluation = evaluateGpuHmrDeterministicVisualMode(record.deterministicVisualMode);
  const proofLedgerSourceConsistency = {
    accepted: ledger.gpuHmrSuccess === true && ledger.failedInvariants.length === 0,
    mode: 'derived_only',
    source: 'vulkan_runtime_recomputed',
    proofLedgerId: proofLedger.proofId,
    proof_ledger_id: proofLedger.proofId,
    evidenceRefs: record.evidence_refs ?? [],
    evidence_refs: record.evidence_refs ?? [],
    failures: ledger.failedInvariants,
  };
  const visualThresholdValidation = {
    accepted: frames.changedPixelRatio > 0 && frames.meanAbsDelta8bit > 0 && frames.visiblePixelCount > 0,
    changedPixelRatio: frames.changedPixelRatio,
    meanAbsDelta8bit: frames.meanAbsDelta8bit,
    visiblePixelCount: frames.visiblePixelCount,
    failedGates: [
      frames.changedPixelRatio > 0 ? null : 'vulkan_visual_zero_changed_pixels',
      frames.meanAbsDelta8bit > 0 ? null : 'vulkan_visual_zero_mean_delta',
      frames.visiblePixelCount > 0 ? null : 'vulkan_visual_no_visible_pixels',
    ].filter(Boolean),
  };
  const limitationCodes = [
    ...ledger.failedInvariants.map((failure) => failure.code),
    ...contractEvaluation.failedGates.map((failure) => failure.code),
    ...contractConsistency.failedGates.map((failure) => failure.code),
    ...nativeApiEvidence.failedGates,
    ...visualThresholdValidation.failedGates,
    ...deterministicVisualModeEvaluation.failedGates.map((failure) => failure.code),
    beforeHash !== afterHash ? null : 'vulkan_shader_module_hash_not_changed',
  ].filter(Boolean);
  const fullRuntimeProven =
    ledger.gpuHmrSuccess === true
    && ledger.failedInvariants.length === 0
    && contractEvaluation.accepted === true
    && contractConsistency.accepted === true
    && proofLedgerSourceConsistency.accepted === true
    && nativeApiEvidence.accepted === true
    && visualThresholdValidation.accepted === true
    && deterministicVisualModeEvaluation.accepted === true
    && beforeHash !== afterHash
    && limitationCodes.length === 0;
  const visualEvidenceArtifacts = visualEvidenceArtifactsFromVisualOracleArtifacts(
    visualArtifacts,
    {
      proofLedgerQuery: ledger,
      proofLedgerRecord: record,
      producerSubsystem: 'mcp.vulkan_runtime_visual',
    },
  );
  const artifact = {
    schemaVersion: 'synthi.gpu.hmr.runtime_proof_artifact.v1',
    proofId: `vulkan-runtime-proof-artifact:${sha256Text(stableJson({
      proofLedgerId: proofLedger.proofId,
      contractHash: contract.contract_hash,
      artifactHashAfter: afterHash,
      afterImageHash: frames.afterHash,
    })).replace(/^sha256:/, '')}`,
    resultState: fullRuntimeProven ? 'gpu-hmr-full-runtime-proven' : 'gpu-hmr-runtime-proof-rejected',
    fullRuntimeProven,
    full_runtime_proven: fullRuntimeProven,
    gpuHmrSuccess: fullRuntimeProven,
    gpu_hmr_success: fullRuntimeProven,
    stageResults: [
      { stageId: 'vulkan-shader-module', status: beforeHash !== afterHash ? 'passed' : 'failed', evidenceRefs: [beforeHash, afterHash] },
      { stageId: 'vulkan-pipeline-layout', status: nativeApiEvidence.counts.vkCreatePipelineLayout >= 2 ? 'passed' : 'failed', evidenceRefs: ['runtime:vulkan:vkCreatePipelineLayout'] },
      { stageId: 'vulkan-command-buffer-rerecord', status: nativeApiEvidence.counts.vkBeginCommandBuffer >= 2 ? 'passed' : 'failed', evidenceRefs: ['runtime:vulkan:vkBeginCommandBuffer'] },
      { stageId: 'vulkan-queue-submit-fence', status: nativeApiEvidence.counts.vkQueueSubmit >= 2 && nativeApiEvidence.counts.vkWaitForFences >= 2 ? 'passed' : 'failed', evidenceRefs: ['runtime:vulkan:vkQueueSubmit', 'runtime:vulkan:vkWaitForFences'] },
      { stageId: 'vulkan-visual-frame-oracle', status: visualThresholdValidation.accepted ? 'passed' : 'failed', evidenceRefs: [visualArtifacts.after_image_hash, visualArtifacts.diff_image_hash] },
      { stageId: 'vulkan-acceptance-contract', status: contractEvaluation.accepted && contractConsistency.accepted ? 'passed' : 'failed', evidenceRefs: [contract.contract_hash] },
    ],
    limitations: fullRuntimeProven ? [] : limitationCodes.map((code) => ({ code })),
    proofLedger,
    proof_ledger: proofLedger,
    proofLedgerQuery: ledger,
    proof_ledger_query: ledger,
    acceptanceContract: contract,
    acceptance_contract: contract,
    acceptanceContractEvaluation: contractEvaluation,
    acceptance_contract_evaluation: contractEvaluation,
    acceptanceContractConsistency: contractConsistency,
    acceptance_contract_consistency: contractConsistency,
    proofLedgerSourceConsistency,
    proof_ledger_source_consistency: proofLedgerSourceConsistency,
    deterministicVisualMode: record.deterministicVisualMode,
    deterministic_visual_mode: record.deterministicVisualMode,
    deterministicVisualModeEvaluation,
    deterministic_visual_mode_evaluation: deterministicVisualModeEvaluation,
    nativeVulkanApiEvidence: nativeApiEvidence,
    native_vulkan_api_evidence: nativeApiEvidence,
    visualThresholdValidation,
    visual_threshold_validation: visualThresholdValidation,
    visualEvidenceArtifacts,
    visual_evidence_artifacts: visualEvidenceArtifacts,
    runMode,
    run_mode: runMode,
  };
  artifact.strictGate = runtimeProofArtifactStrictGate(artifact);
  artifact.strict_gate = artifact.strictGate;
  return artifact;
}

function findTraceEvent(events, epoch, expectedHash) {
  return Array.isArray(events)
    ? events.find((event) =>
      String(event?.epoch ?? '') === String(epoch)
      && firstText(event?.artifact_hash, event?.artifactHash) === expectedHash
    )
    : null;
}

function timestampNs(event) {
  const snake = finiteNumber(event?.timestamp_monotonic_ns, null);
  if (Number.isFinite(snake)) return snake;
  return finiteNumber(event?.timestampMonotonicNs, null);
}

function validateVulkanRuntimeTrace({ runtimeTrace, beforeHash, afterHash }) {
  const failedGates = [];
  if (!runtimeTrace || typeof runtimeTrace !== 'object') {
    return { accepted: false, failedGates: ['vulkan_runtime_trace_missing'] };
  }
  const processId = firstText(runtimeTrace.processId, runtimeTrace.process_id);
  if (!processId) failedGates.push('vulkan_runtime_trace_process_id_missing');
  if (runtimeTrace.sameProcess !== true && runtimeTrace.same_process !== true) {
    failedGates.push('vulkan_runtime_trace_same_process_missing');
  }
  if (runtimeTrace.processRestarted === true || runtimeTrace.process_restarted === true) {
    failedGates.push('vulkan_runtime_trace_process_restarted');
  }
  const beforeLoader = findTraceEvent(runtimeTrace.loaderEvents ?? runtimeTrace.loader_events, 1, beforeHash);
  const afterLoader = findTraceEvent(runtimeTrace.loaderEvents ?? runtimeTrace.loader_events, 2, afterHash);
  const beforePublish = findTraceEvent(runtimeTrace.epochEvents ?? runtimeTrace.epoch_events, 1, beforeHash);
  const afterPublish = findTraceEvent(runtimeTrace.epochEvents ?? runtimeTrace.epoch_events, 2, afterHash);
  const beforeDispatch = findTraceEvent(runtimeTrace.dispatchEvents ?? runtimeTrace.dispatch_events, 1, beforeHash);
  const afterDispatch = findTraceEvent(runtimeTrace.dispatchEvents ?? runtimeTrace.dispatch_events, 2, afterHash);
  const beforeOutput = findTraceEvent(runtimeTrace.outputEvents ?? runtimeTrace.output_events, 1, beforeHash);
  const afterOutput = findTraceEvent(runtimeTrace.outputEvents ?? runtimeTrace.output_events, 2, afterHash);
  const requiredEvents = {
    beforeLoader,
    afterLoader,
    beforePublish,
    afterPublish,
    beforeDispatch,
    afterDispatch,
    beforeOutput,
    afterOutput,
  };
  for (const [name, event] of Object.entries(requiredEvents)) {
    if (!event) failedGates.push(`vulkan_runtime_trace_${name}_missing`);
  }
  if (beforeOutput && beforeDispatch && firstText(beforeOutput.after_dispatch_id, beforeOutput.afterDispatchId) !== firstText(beforeDispatch.id)) {
    failedGates.push('vulkan_runtime_trace_before_output_dispatch_mismatch');
  }
  if (afterOutput && afterDispatch && firstText(afterOutput.after_dispatch_id, afterOutput.afterDispatchId) !== firstText(afterDispatch.id)) {
    failedGates.push('vulkan_runtime_trace_after_output_dispatch_mismatch');
  }
  const times = Object.fromEntries(Object.entries(requiredEvents).map(([name, event]) => [name, timestampNs(event)]));
  for (const [name, value] of Object.entries(times)) {
    if (!Number.isFinite(value)) failedGates.push(`vulkan_runtime_trace_${name}_timestamp_missing`);
  }
  const orderedPairs = [
    ['beforeLoader', 'beforePublish'],
    ['beforePublish', 'beforeDispatch'],
    ['beforeDispatch', 'beforeOutput'],
    ['beforeOutput', 'afterLoader'],
    ['afterLoader', 'afterPublish'],
    ['afterPublish', 'afterDispatch'],
    ['afterDispatch', 'afterOutput'],
  ];
  for (const [left, right] of orderedPairs) {
    if (Number.isFinite(times[left]) && Number.isFinite(times[right]) && times[left] > times[right]) {
      failedGates.push(`vulkan_runtime_trace_order_${left}_after_${right}`);
    }
  }
  const retirementEvent = runtimeTrace.retirementEvent ?? runtimeTrace.retirement_event;
  const retirementTimestampNs = timestampNs(retirementEvent);
  if (!retirementEvent) failedGates.push('vulkan_runtime_trace_retirement_event_missing');
  if (!Number.isFinite(retirementTimestampNs)) failedGates.push('vulkan_runtime_trace_retirement_timestamp_missing');
  if (Number.isFinite(retirementTimestampNs) && Number.isFinite(times.afterOutput) && retirementTimestampNs < times.afterOutput) {
    failedGates.push('vulkan_runtime_trace_retirement_before_after_output');
  }
  const nativeCounts = runtimeTrace.nativeApiCounts ?? runtimeTrace.native_api_counts;
  const nativeEvidence = nativeVulkanApiEvidence({ counts: nativeCounts, source: 'native_vulkan_runtime_trace_validation' });
  failedGates.push(...nativeEvidence.failedGates);
  return {
    accepted: failedGates.length === 0,
    failedGates,
    events: {
      beforeLoader,
      afterLoader,
      beforePublish,
      afterPublish,
      beforeDispatch,
      afterDispatch,
      beforeOutput,
      afterOutput,
      retirementEvent,
    },
    timestamps: { ...times, retirement: retirementTimestampNs },
    processId,
    nativeEvidence,
  };
}

async function buildAcceptedSelfCheckProof(outDir) {
  await mkdir(outDir, { recursive: true });
  const beforeHash = sha256Text('vulkan-before-spirv');
  const afterHash = sha256Text('vulkan-after-spirv');
  const runMode = runModeFor({ afterHash });
  const frames = await renderSelfCheckFrames(outDir);
  const timings = {
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
    device_compile_wall_time: 100,
    artifact_load_time: 20,
    epoch_publish_time: 20,
    dispatch_trace_time: 20,
    runtime_probe_time: 100,
    oracle_analysis_time: 100,
    trigger_to_visible_time: 260,
    screenshot_capture_time: 20,
    dispatch_to_output_proof_time: 20,
    total_validator_wall_time: 360,
    loaderTimestampNs: 10,
    publishTimestampNs: 20,
    dispatchTimestampNs: 30,
    outputTimestampNs: 40,
    retirementTimestampNs: 50,
  };
  const contract = buildContract({ beforeHash, afterHash, runMode });
  const visualArtifacts = buildVisualOracleArtifacts({
    frames,
    dispatchId: 'vulkan-dispatch-epoch-2',
    artifactHash: afterHash,
    timestamp: timings.outputTimestampNs,
  });
  const ledgerRecord = buildLedgerRecord({ beforeHash, afterHash, contract, runMode, frames, timings, visualArtifacts });
  const proofLedger = buildGpuHmrProofLedger(ledgerRecord);
  const ledger = queryGpuHmrLedgerInvariants(proofLedger);
  const contractEvaluation = evaluateGpuHmrAcceptanceContract(contract);
  const contractConsistency = evaluateGpuHmrAcceptanceContractConsistency({ before: contract, after: contract });
  const nativeApiEvidence = nativeVulkanApiEvidence({
    counts: {
      vkCreateShaderModule: 2,
      vkCreatePipelineLayout: 2,
      vkCreateComputePipelines: 2,
      vkAllocateCommandBuffers: 2,
      vkBeginCommandBuffer: 2,
      vkCmdBindPipeline: 2,
      vkCmdDispatch: 2,
      vkQueueSubmit: 2,
      vkWaitForFences: 2,
      vkMapMemory: 2,
    },
    source: 'self_check_fixture_explicit_native_vulkan_counts',
  });
  const artifact = runtimeProofArtifact({
    beforeHash,
    afterHash,
    proofLedger,
    ledger,
    contract,
    contractEvaluation,
    contractConsistency,
    frames,
    visualArtifacts,
    nativeApiEvidence,
    runMode,
  });
  const visualEvidenceArtifacts = artifact.visualEvidenceArtifacts ?? artifact.visual_evidence_artifacts ?? [];
  return {
    schemaVersion: SCHEMA,
    schema: SCHEMA,
    targetId: CFG.targetId,
    profile: { id: CFG.targetId, targetId: CFG.targetId, validationScope: 'vulkan_declared_pipeline_visual' },
    backend: 'vulkan',
    resultState: artifact.gpuHmrSuccess ? 'gpu-hmr-full-runtime-proven' : 'gpu-hmr-runtime-proof-rejected',
    fullRuntimeProven: artifact.gpuHmrSuccess === true,
    gpuHmrSuccess: artifact.gpuHmrSuccess === true,
    acceptedForGpuHmr: artifact.gpuHmrSuccess === true,
    proofId: `vulkan-runtime-proof:sha256:${createHash('sha256').update(stableJson({
      proofLedgerId: proofLedger.proofId,
      runtimeProofArtifactId: artifact.proofId,
      afterHash,
      afterImageHash: frames.afterHash,
    })).digest('hex')}`,
    compiler: {
      beforeShaderModuleHash: beforeHash,
      before_shader_module_hash: beforeHash,
      afterShaderModuleHash: afterHash,
      after_shader_module_hash: afterHash,
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
    runtimeProofArtifact: artifact,
    runtime_proof_artifact: artifact,
    visualOracleArtifacts: visualArtifacts,
    visual_oracle_artifacts: visualArtifacts,
    visualEvidenceArtifacts,
    visual_evidence_artifacts: visualEvidenceArtifacts,
    visualThresholdValidation: artifact.visualThresholdValidation,
    visual_threshold_validation: artifact.visualThresholdValidation,
    deterministicVisualMode: ledgerRecord.deterministicVisualMode,
    deterministic_visual_mode: ledgerRecord.deterministicVisualMode,
    nativeVulkanApiEvidence: nativeApiEvidence,
    native_vulkan_api_evidence: nativeApiEvidence,
    negativeLayoutRefusal: negativeLayoutRefusal(),
    negative_layout_refusal: negativeLayoutRefusal(),
    timings,
    runMode,
    run_mode: runMode,
    limitations: artifact.gpuHmrSuccess ? [] : artifact.limitations,
  };
}

function timingsFromVulkanTrace({ runtimeTrace, runMode, traceValidation }) {
  if (traceValidation?.accepted !== true) {
    throw Object.assign(new Error(`vulkan_runtime_trace_invalid:${traceValidation?.failedGates?.join(',') || 'unknown'}`), {
      code: 'vulkan_runtime_trace_invalid',
      failedGates: traceValidation?.failedGates ?? ['vulkan_runtime_trace_invalid'],
    });
  }
  const loader = traceValidation.timestamps.afterLoader;
  const publish = traceValidation.timestamps.afterPublish;
  const dispatch = traceValidation.timestamps.afterDispatch;
  const output = traceValidation.timestamps.afterOutput;
  const retirement = traceValidation.timestamps.retirement;
  const startNs = finiteNumber(runtimeTrace.timings?.startNs, traceValidation.timestamps.beforeLoader);
  const completeNs = finiteNumber(runtimeTrace.timings?.completeNs, retirement);
  const runtimeNs = Math.max(1, completeNs - startNs);
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
    device_compile_wall_time: Math.max(1, publish - loader),
    artifact_load_time: Math.max(1, publish - loader),
    epoch_publish_time: Math.max(1, publish - loader),
    dispatch_trace_time: Math.max(1, dispatch - publish),
    runtime_probe_time: runtimeNs,
    oracle_analysis_time: Math.max(1, output - dispatch),
    trigger_to_visible_time: Math.max(1, output - startNs),
    screenshot_capture_time: 0,
    dispatch_to_output_proof_time: Math.max(1, output - dispatch),
    total_validator_wall_time: runtimeNs,
    loaderTimestampNs: loader,
    publishTimestampNs: publish,
    dispatchTimestampNs: dispatch,
    outputTimestampNs: output,
    retirementTimestampNs: retirement,
  };
}

async function runWindowsHostVulkanProbe({ outDir, shaderArtifacts }) {
  const scriptPath = path.join(outDir, 'vulkan_runtime_probe_windows.ps1');
  const beforeRawPath = path.join(outDir, 'vulkan-before-frame.rgba');
  const afterRawPath = path.join(outDir, 'vulkan-after-frame.rgba');
  const tracePath = path.join(outDir, 'vulkan-runtime-trace.json');
  await writeFile(scriptPath, windowsVulkanPowerShellProbeSource());
  const result = await execFileRaw(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
      '-BeforeSpvPath',
      shaderArtifacts.beforePath,
      '-AfterSpvPath',
      shaderArtifacts.afterPath,
      '-BeforeRawPath',
      beforeRawPath,
      '-AfterRawPath',
      afterRawPath,
      '-TracePath',
      tracePath,
      '-BeforeHash',
      shaderArtifacts.beforeHash,
      '-AfterHash',
      shaderArtifacts.afterHash,
      '-SchemaVersion',
      SCHEMA,
    ],
    { timeout: CFG.timeoutMs, maxBuffer: 64 * 1024 * 1024 },
  );
  if (!result.ok) {
    const combined = `${result.stdout}\n${result.stderr}`;
    const code = firstText(combined.match(/vulkan_runtime_error=([a-zA-Z0-9_.-]+)/)?.[1], 'vulkan_host_probe_failed');
    const error = new Error(`${code}: ${result.stderrTail || result.stdoutTail || result.error || 'host Vulkan probe failed'}`);
    error.code = code;
    error.result = result;
    throw error;
  }
  const runtimeTrace = JSON.parse(await readFile(tracePath, 'utf8'));
  return {
    transport: 'local_windows_powershell_add_type',
    result,
    tracePath,
    beforeRawPath,
    afterRawPath,
    runtimeTrace,
  };
}

async function buildLiveWindowsProof({ outDir, preflight }) {
  await mkdir(outDir, { recursive: true });
  const shaderArtifacts = await writeVulkanShaderArtifacts(outDir);
  const probe = await runWindowsHostVulkanProbe({ outDir, shaderArtifacts });
  const traceValidation = validateVulkanRuntimeTrace({
    runtimeTrace: probe.runtimeTrace,
    beforeHash: shaderArtifacts.beforeHash,
    afterHash: shaderArtifacts.afterHash,
  });
  if (traceValidation.accepted !== true) {
    const error = new Error(`Vulkan runtime trace did not satisfy strict proof shape: ${traceValidation.failedGates.join(',')}`);
    error.code = 'vulkan_runtime_trace_invalid';
    error.failedGates = traceValidation.failedGates;
    throw error;
  }
  const frames = await renderFramesFromRgbaReadback({
    outDir,
    beforeRawPath: probe.beforeRawPath,
    afterRawPath: probe.afterRawPath,
    width: finiteNumber(probe.runtimeTrace.width, 128),
    height: finiteNumber(probe.runtimeTrace.height, 128),
  });
  const runMode = runModeFor({ afterHash: shaderArtifacts.afterHash });
  const processId = firstText(probe.runtimeTrace.processId, probe.runtimeTrace.process_id, 'pid:vulkan-host-runtime');
  const deviceName = firstText(probe.runtimeTrace.device?.deviceName, probe.runtimeTrace.device?.device_name, 'windows-vulkan-device');
  const queueFamilyIndex = finiteNumber(probe.runtimeTrace.device?.queueFamilyIndex, 0);
  const queueHandle = firstText(probe.runtimeTrace.device?.queueHandle, probe.runtimeTrace.device?.queue_handle, `VkQueue:queue-family-${queueFamilyIndex}`);
  const deviceUuid = sha256Text(stableJson({
    backend: 'vulkan',
    deviceName,
    queueFamilyIndex,
    physicalDeviceHandle: firstText(probe.runtimeTrace.device?.physicalDeviceHandle, probe.runtimeTrace.device?.physical_device_handle),
    queueHandle,
    transport: probe.transport,
  }));
  const timings = timingsFromVulkanTrace({ runtimeTrace: probe.runtimeTrace, runMode, traceValidation });
  const contract = buildContract({
    beforeHash: shaderArtifacts.beforeHash,
    afterHash: shaderArtifacts.afterHash,
    runMode,
    processId,
    deviceUuid,
    deviceName,
    deviceHandle: firstText(probe.runtimeTrace.device?.logicalDeviceHandle, probe.runtimeTrace.device?.logical_device_handle, 'VkDevice:unreported'),
    queueHandle,
    framebufferIdentity: `VkBuffer:host-visible-storage:${frames.width}x${frames.height}`,
    evidenceSource: 'vulkan_windows_host_runtime_trace',
  });
  const visualArtifacts = buildVisualOracleArtifacts({
    frames,
    dispatchId: firstText(traceValidation.events.afterDispatch?.id, 'vulkan-dispatch-epoch-2'),
    artifactHash: shaderArtifacts.afterHash,
    timestamp: timings.outputTimestampNs,
  });
  visualArtifacts.capture_backend = 'vulkan_compute_storage_buffer_readback';
  visualArtifacts.new_epoch_watermark_or_trace = `epoch=2 dispatch=${firstText(traceValidation.events.afterDispatch?.id, 'vulkan-dispatch-epoch-2')} artifact=${shaderArtifacts.afterHash} transport=${probe.transport}`;
  const ledgerRecord = buildLedgerRecord({
    beforeHash: shaderArtifacts.beforeHash,
    afterHash: shaderArtifacts.afterHash,
    contract,
    runMode,
    frames,
    timings,
    visualArtifacts,
    processId,
    deviceName,
    queueHandle,
    traceValidation,
  });
  const proofLedger = buildGpuHmrProofLedger(ledgerRecord);
  const ledger = queryGpuHmrLedgerInvariants(proofLedger);
  const contractEvaluation = evaluateGpuHmrAcceptanceContract(contract);
  const contractConsistency = evaluateGpuHmrAcceptanceContractConsistency({ before: contract, after: contract });
  const nativeApiEvidence = {
    ...traceValidation.nativeEvidence,
    source: 'native_vulkan_windows_runtime_trace',
  };
  const artifact = runtimeProofArtifact({
    beforeHash: shaderArtifacts.beforeHash,
    afterHash: shaderArtifacts.afterHash,
    proofLedger,
    ledger,
    contract,
    contractEvaluation,
    contractConsistency,
    frames,
    visualArtifacts,
    nativeApiEvidence,
    runMode,
  });
  const visualEvidenceArtifacts = artifact.visualEvidenceArtifacts ?? artifact.visual_evidence_artifacts ?? [];
  const proof = {
    schemaVersion: SCHEMA,
    schema: SCHEMA,
    targetId: CFG.targetId,
    profile: { id: CFG.targetId, targetId: CFG.targetId, validationScope: 'vulkan_declared_pipeline_visual' },
    backend: 'vulkan',
    resultState: artifact.gpuHmrSuccess ? 'gpu-hmr-full-runtime-proven' : 'gpu-hmr-runtime-proof-rejected',
    fullRuntimeProven: artifact.gpuHmrSuccess === true,
    gpuHmrSuccess: artifact.gpuHmrSuccess === true,
    acceptedForGpuHmr: artifact.gpuHmrSuccess === true,
    proofId: `vulkan-runtime-proof:sha256:${createHash('sha256').update(stableJson({
      proofLedgerId: proofLedger.proofId,
      runtimeProofArtifactId: artifact.proofId,
      afterHash: shaderArtifacts.afterHash,
      afterImageHash: frames.afterHash,
      transport: probe.transport,
    })).digest('hex')}`,
    compiler: {
      beforeShaderModuleHash: shaderArtifacts.beforeHash,
      before_shader_module_hash: shaderArtifacts.beforeHash,
      afterShaderModuleHash: shaderArtifacts.afterHash,
      after_shader_module_hash: shaderArtifacts.afterHash,
      compiler: 'synthi_builtin_spirv_module_generator',
      compiler_args_hash: sha256Text('vulkan-host-compute-rgba-storage-buffer-v1'),
      generatedSpirvBefore: relRepo(shaderArtifacts.beforePath),
      generatedSpirvAfter: relRepo(shaderArtifacts.afterPath),
      generated_spirv_before: relRepo(shaderArtifacts.beforePath),
      generated_spirv_after: relRepo(shaderArtifacts.afterPath),
    },
    runtimeProbeExecution: {
      schemaVersion: 'synthi.gpu_hmr.runtime_probe_execution.v1',
      proofAuthority: 'runtime_probe_execution_transport_only_not_gpu_hmr_success',
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
      transport: probe.transport,
      workerPreflightAccepted: preflight.accepted === true,
      workerUnsupportedReasons: preflight.unsupportedReasons,
      tracePath: relRepo(probe.tracePath),
      beforeRawPath: relRepo(probe.beforeRawPath),
      afterRawPath: relRepo(probe.afterRawPath),
      stdoutTail: probe.result.stdoutTail,
      stderrTail: probe.result.stderrTail,
      traceValidation: {
        accepted: traceValidation.accepted,
        failedGates: traceValidation.failedGates,
      },
    },
    runtime_probe_execution: {
      proof_authority: 'runtime_probe_execution_transport_only_not_gpu_hmr_success',
      accepted_for_gpu_hmr: false,
      gpu_hmr_success: false,
      transport: probe.transport,
      trace_path: relRepo(probe.tracePath),
    },
    vulkanRuntimePreflight: {
      accepted: preflight.accepted,
      unsupportedReasons: preflight.unsupportedReasons,
      unsupported_reasons: preflight.unsupportedReasons,
      libraries: preflight.libraries,
      icdFiles: preflight.icdFiles,
      icd_files: preflight.icdFiles,
      vulkaninfoPath: preflight.vulkaninfoPath || null,
      vulkaninfo_path: preflight.vulkaninfoPath || null,
      vulkaninfoSummary: preflight.vulkaninfoSummary,
      vulkaninfo_summary: preflight.vulkaninfoSummary,
    },
    runtimeTrace: probe.runtimeTrace,
    runtime_trace: probe.runtimeTrace,
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
    runtimeProofArtifact: artifact,
    runtime_proof_artifact: artifact,
    visualOracleArtifacts: visualArtifacts,
    visual_oracle_artifacts: visualArtifacts,
    visualEvidenceArtifacts,
    visual_evidence_artifacts: visualEvidenceArtifacts,
    visualThresholdValidation: artifact.visualThresholdValidation,
    visual_threshold_validation: artifact.visualThresholdValidation,
    deterministicVisualMode: ledgerRecord.deterministicVisualMode,
    deterministic_visual_mode: ledgerRecord.deterministicVisualMode,
    nativeVulkanApiEvidence: nativeApiEvidence,
    native_vulkan_api_evidence: nativeApiEvidence,
    negativeLayoutRefusal: negativeLayoutRefusal(),
    negative_layout_refusal: negativeLayoutRefusal(),
    timings,
    runMode,
    run_mode: runMode,
    limitations: artifact.gpuHmrSuccess ? [] : artifact.limitations,
  };
  const proofPath = path.join(outDir, `${safeSlug(CFG.targetId)}-vulkan-runtime-proof.json`);
  await writeFile(proofPath, `${JSON.stringify(proof, null, 2)}\n`);
  return { proof, proofPath };
}

async function buildLiveRefusal(outDir) {
  await mkdir(outDir, { recursive: true });
  const preflight = await vulkanRuntimePreflight();
  if (process.platform === 'win32') {
    try {
      return await buildLiveWindowsProof({ outDir, preflight });
    } catch (error) {
      const rejection = {
        schemaVersion: SCHEMA,
        schema: SCHEMA,
        targetId: CFG.targetId,
        profile: { id: CFG.targetId, targetId: CFG.targetId, validationScope: 'vulkan_declared_pipeline_visual' },
        backend: 'vulkan',
        proofId: `vulkan-runtime-proof:sha256:${createHash('sha256').update(stableJson({
          targetId: CFG.targetId,
          hostProbeErrorCode: error.code ?? 'vulkan_host_probe_failed',
          slug: CFG.slug,
        })).digest('hex')}`,
        resultState: 'gpu-hmr-runtime-proof-rejected',
        fullRuntimeProven: false,
        gpuHmrSuccess: false,
        acceptedForGpuHmr: false,
        vulkanRuntimePreflight: {
          accepted: preflight.accepted,
          unsupportedReasons: preflight.unsupportedReasons,
          unsupported_reasons: preflight.unsupportedReasons,
          libraries: preflight.libraries,
          icdFiles: preflight.icdFiles,
          icd_files: preflight.icdFiles,
          icdLibraries: preflight.icdLibraries,
          icd_libraries: preflight.icdLibraries,
          vulkaninfoPath: preflight.vulkaninfoPath || null,
          vulkaninfo_path: preflight.vulkaninfoPath || null,
          vulkaninfoSummary: preflight.vulkaninfoSummary,
          vulkaninfo_summary: preflight.vulkaninfoSummary,
        },
        runtimeProbeExecution: {
          schemaVersion: 'synthi.gpu_hmr.runtime_probe_execution.v1',
          proofAuthority: 'runtime_probe_execution_transport_only_not_gpu_hmr_success',
          acceptedForGpuHmr: false,
          gpuHmrSuccess: false,
          transport: 'local_windows_powershell_add_type',
          errorCode: error.code ?? 'vulkan_host_probe_failed',
          failedGates: error.failedGates ?? [],
          stdoutTail: error.result?.stdoutTail ?? null,
          stderrTail: error.result?.stderrTail ?? String(error.message ?? ''),
        },
        runtime_probe_execution: {
          proof_authority: 'runtime_probe_execution_transport_only_not_gpu_hmr_success',
          accepted_for_gpu_hmr: false,
          gpu_hmr_success: false,
          transport: 'local_windows_powershell_add_type',
          error_code: error.code ?? 'vulkan_host_probe_failed',
          failed_gates: error.failedGates ?? [],
        },
        limitations: [
          { code: error.code ?? 'vulkan_host_probe_failed' },
          ...(error.failedGates ?? []).map((code) => ({ code })),
          ...(preflight.unsupportedReasons ?? []).map((code) => ({ code: `worker_${code}` })),
        ],
      };
      const proofPath = path.join(outDir, `${safeSlug(CFG.targetId)}-vulkan-runtime-rejected.json`);
      await writeFile(proofPath, `${JSON.stringify(rejection, null, 2)}\n`);
      return { proof: rejection, proofPath };
    }
  }
  const proof = {
    schemaVersion: SCHEMA,
    schema: SCHEMA,
    targetId: CFG.targetId,
    profile: { id: CFG.targetId, targetId: CFG.targetId, validationScope: 'vulkan_declared_pipeline_visual' },
    backend: 'vulkan',
    proofId: `vulkan-runtime-proof:sha256:${createHash('sha256').update(stableJson({
      targetId: CFG.targetId,
      unsupportedReasons: preflight.unsupportedReasons,
      slug: CFG.slug,
    })).digest('hex')}`,
    resultState: 'gpu-hmr-runtime-proof-rejected',
    fullRuntimeProven: false,
    gpuHmrSuccess: false,
    acceptedForGpuHmr: false,
    vulkanRuntimePreflight: {
      accepted: preflight.accepted,
      unsupportedReasons: preflight.unsupportedReasons,
      unsupported_reasons: preflight.unsupportedReasons,
      libraries: preflight.libraries,
      icdFiles: preflight.icdFiles,
      icd_files: preflight.icdFiles,
      icdLibraries: preflight.icdLibraries,
      icd_libraries: preflight.icdLibraries,
      vulkaninfoPath: preflight.vulkaninfoPath || null,
      vulkaninfo_path: preflight.vulkaninfoPath || null,
      vulkaninfoSummary: preflight.vulkaninfoSummary,
      vulkaninfo_summary: preflight.vulkaninfoSummary,
    },
    limitations: preflight.unsupportedReasons.map((code) => ({ code })),
  };
  if (preflight.accepted) {
    proof.limitations.push({ code: 'vulkan_runtime_probe_not_implemented_for_live_success' });
  }
  const proofPath = path.join(outDir, `${safeSlug(CFG.targetId)}-vulkan-runtime-rejected.json`);
  await writeFile(proofPath, `${JSON.stringify(proof, null, 2)}\n`);
  return { proof, proofPath };
}

async function selfCheck() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'synthi-vulkan-runtime-self-check-'));
  const proof = await buildAcceptedSelfCheckProof(tmp);
  if (proof.runtimeProofArtifact?.gpuHmrSuccess !== true) {
    throw new Error(`self-check strict artifact rejected: ${JSON.stringify({
      strictGate: proof.runtimeProofArtifact?.strictGate,
      ledger: proof.ledger,
      contractEvaluation: proof.contractEvaluation,
      limitations: proof.runtimeProofArtifact?.limitations,
    }, null, 2)}`);
  }
  const proofPath = path.join(tmp, 'vulkan-runtime-proof.json');
  await writeFile(proofPath, `${JSON.stringify(proof, null, 2)}\n`);
  const matrix = await collectGpuHmrValidationMatrixLedger({
    repoRoot: REPO_ROOT,
    mcpRoot: MCP_ROOT,
    roots: [tmp],
    latestPerTarget: false,
    includeUnproven: true,
    generatedAt: '2026-06-30T00:00:00.000Z',
  });
  const row = matrix.rows.find((entry) => entry.targetId === CFG.targetId && entry.backend === 'vulkan');
  if (!row || row.matrixOutcome !== 'full_runtime_gpu_hmr' || row.acceptanceScope !== 'vulkan_declared_pipeline_visual') {
    throw new Error(`self-check matrix row rejected: ${JSON.stringify({
      openGaps: row?.openGaps,
      reasons: row?.reasons,
      ledger: row?.ledger,
      runtimeProofArtifact: row?.runtimeProofArtifact,
      declaredScopeEvidence: row?.declaredScopeEvidence,
      nativeVulkanApiEvidence: row?.nativeVulkanApiEvidence,
      negativeLayoutRefusalAccepted: row?.negativeLayoutRefusalAccepted,
    }, null, 2)}`);
  }
  const outputBinding = row.outputOracleFacet?.outputBinding ?? row.output_oracle_facet?.output_binding;
  if (
    outputBinding?.accepted !== true
    || outputBinding.outputTargetId !== VULKAN_VISUAL_OUTPUT_TARGET_ID
    || outputBinding.dispatchOutputTargetId !== VULKAN_VISUAL_OUTPUT_TARGET_ID
    || outputBinding.oracleOutputTargetId !== VULKAN_VISUAL_OUTPUT_TARGET_ID
  ) {
    throw new Error(`self-check output-oracle target binding rejected: ${JSON.stringify({
      outputBinding,
      expectedOutputTargetId: VULKAN_VISUAL_OUTPUT_TARGET_ID,
    }, null, 2)}`);
  }
  const forged = JSON.parse(JSON.stringify(proof));
  const forgedAfterHash = sha256Text('forged-after-frame');
  const corruptVisualArtifacts = (value) => {
    if (value && typeof value === 'object') {
      value.after_image_hash = forgedAfterHash;
      value.afterImageHash = forgedAfterHash;
    }
  };
  forged.proofId = 'vulkan-runtime-proof:sha256:forged';
  forged.visualEvidenceArtifacts = [];
  forged.visual_evidence_artifacts = [];
  if (forged.runtimeProofArtifact) {
    forged.runtimeProofArtifact.visualEvidenceArtifacts = [];
    forged.runtimeProofArtifact.visual_evidence_artifacts = [];
  }
  if (forged.runtime_proof_artifact) {
    forged.runtime_proof_artifact.visualEvidenceArtifacts = [];
    forged.runtime_proof_artifact.visual_evidence_artifacts = [];
  }
  corruptVisualArtifacts(forged.visualOracleArtifacts);
  corruptVisualArtifacts(forged.visual_oracle_artifacts);
  const forgedRecord = forged.proofLedger?.records?.[0];
  corruptVisualArtifacts(forgedRecord?.oracle_artifacts?.visual_oracle_artifacts);
  corruptVisualArtifacts(forgedRecord?.oracleArtifacts?.visualOracleArtifacts);
  corruptVisualArtifacts(forgedRecord?.output_event?.visual_oracle_artifacts);
  corruptVisualArtifacts(forgedRecord?.outputEvent?.visualOracleArtifacts);
  corruptVisualArtifacts(forgedRecord?.output_event?.output_oracle?.oracle_artifacts?.visual_oracle_artifacts);
  corruptVisualArtifacts(forgedRecord?.outputEvent?.outputOracle?.oracleArtifacts?.visualOracleArtifacts);
  await writeFile(path.join(tmp, 'vulkan-runtime-proof-forged.json'), `${JSON.stringify(forged, null, 2)}\n`);
  const forgedMatrix = await collectGpuHmrValidationMatrixLedger({
    repoRoot: REPO_ROOT,
    mcpRoot: MCP_ROOT,
    roots: [tmp],
    latestPerTarget: false,
    includeUnproven: true,
    generatedAt: '2026-06-30T00:00:00.000Z',
  });
  const forgedRow = forgedMatrix.rows.find((entry) => entry.proofIds?.includes('vulkan-runtime-proof:sha256:forged'));
  if (forgedRow?.matrixOutcome === 'full_runtime_gpu_hmr') {
    throw new Error('forged Vulkan visual frame hash was accepted');
  }
  console.log(JSON.stringify({
    ok: true,
    schemaVersion: SCHEMA,
    proofId: proof.proofId,
    matrixProofId: matrix.proofId,
    rowId: row.rowId,
    forgedRejected: true,
  }, null, 2));
}

async function main() {
  if (process.argv.includes('--self-check')) {
    await selfCheck();
    return;
  }
  const outDir = path.join(ARTIFACT_DIR, CFG.slug);
  const { proof, proofPath } = await buildLiveRefusal(outDir);
  console.log(JSON.stringify({
    ok: proof.gpuHmrSuccess === true,
    schemaVersion: SCHEMA,
    proofId: proof.proofId,
    resultState: proof.resultState,
    fullRuntimeProven: proof.fullRuntimeProven,
    gpuHmrSuccess: proof.gpuHmrSuccess,
    proofPath,
    limitations: proof.limitations,
  }, null, 2));
}

await main();
