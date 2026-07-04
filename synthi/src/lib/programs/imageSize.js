/**
 * @fileoverview Deterministic image-size gate for community-app images. Uses
 * daemon-free `crane manifest` (metadata only — no pull) to sum the compressed
 * registry footprint (config + layer blob sizes) and compare it to a configurable
 * limit. A multi-arch index carries no `layers`, so it is resolved to one platform
 * first. The exec `runner(subcommand, args)` is injectable so tests never shell
 * out; the default mirrors reHoster.js (host-native crane). Fail-closed: any error
 * (crane missing, unknown ref, bad JSON, unsizable index) → ok:false so the
 * orchestrator rejects rather than publishing something it could not measure.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const GIB = 1024 * 1024 * 1024;
/** Default cap on the compressed registry footprint (generous — catches abuse, not real apps). */
const DEFAULT_LIMIT_BYTES = 4 * GIB;
const DEFAULT_PLATFORM = process.env.PROGRAM_IMAGE_PLATFORM || 'linux/amd64';

/** Env-configurable limit; falls back to the default on unset/invalid. */
function defaultLimitBytes() {
  const raw = parseInt(process.env.PROGRAM_IMAGE_MAX_BYTES || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_LIMIT_BYTES;
}

/** Default runner: host-native crane (lesson #27), same binary as reHoster. */
async function defaultRunner(subcommand, args) {
  return execFileAsync(process.env.CRANE_BIN || 'crane', [subcommand, ...args], { maxBuffer: 16 * 1024 * 1024 });
}

/** Sum config + layer blob sizes of a single-platform manifest. Throws if it isn't one. */
function sizeFromManifest(manifest) {
  if (!Array.isArray(manifest.layers)) {
    throw new Error('manifest has no layers (unresolved multi-arch index)');
  }
  const configSize = manifest.config && typeof manifest.config.size === 'number' ? manifest.config.size : 0;
  return manifest.layers.reduce((n, l) => n + (typeof l.size === 'number' ? l.size : 0), configSize);
}

/**
 * Measure the compressed size of an image by ref/digest via `crane manifest`.
 * @returns {Promise<number>} total bytes (config + layers) for the resolved platform.
 */
async function measureImageSize(imageRef, { runner, platform }) {
  const { stdout } = await runner('manifest', [imageRef]);
  const manifest = JSON.parse(stdout); // throws on bad JSON → caller fails closed
  if (!Array.isArray(manifest.layers) && Array.isArray(manifest.manifests)) {
    // Multi-arch index: resolve to one platform's manifest, then size that.
    const { stdout: resolved } = await runner('manifest', ['--platform', platform, imageRef]);
    return sizeFromManifest(JSON.parse(resolved));
  }
  return sizeFromManifest(manifest);
}

/**
 * Evaluate an image against the size limit. Fail-closed: any error → ok:false.
 * @returns {Promise<{ ok: boolean, summary: { limitBytes: number, sizeBytes?: number, error?: string } }>}
 */
export async function evaluateImageSize(imageRef, { limitBytes = defaultLimitBytes(), runner = defaultRunner, platform = DEFAULT_PLATFORM } = {}) {
  try {
    const sizeBytes = await measureImageSize(imageRef, { runner, platform });
    return { ok: sizeBytes <= limitBytes, summary: { limitBytes, sizeBytes } };
  } catch (err) {
    return { ok: false, summary: { limitBytes, error: String(err?.message || err) } };
  }
}
