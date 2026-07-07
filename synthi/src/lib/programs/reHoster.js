/**
 * @fileoverview Re-host an approved community image into our Artifact Registry,
 * pinned by digest, using daemon-free `crane copy` (lesson #27). The exec
 * `runner(subcommand, args)` is injectable so tests never shell out. After
 * re-host the published manifest is rewritten to reference the AR digest — so
 * installers always run exactly what we reviewed, never the publisher's mutable
 * tag (anti review-then-swap).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Default runner: host-native crane (lesson #27). */
async function defaultRunner(subcommand, args) {
  return execFileAsync(process.env.CRANE_BIN || 'crane', [subcommand, ...args], { maxBuffer: 16 * 1024 * 1024 });
}

/** Build the AR repo path for a community image (env-driven, like defaultPrograms). */
export function communityImageTarget({ publisher, packageId }, cfg = {}) {
  const host = cfg.host || process.env.VECTANT_AR_HOST;
  const project = cfg.project || process.env.VECTANT_AR_PROJECT;
  const repo = cfg.repo || process.env.VECTANT_AR_REPO || 'community';
  if (!host || !project) throw new Error('Artifact Registry target not configured (VECTANT_AR_HOST/PROJECT)');
  return `${host}/${project}/${repo}/${publisher}/${packageId}`;
}

/**
 * Copy SRC → target and return the target pinned by its resolved digest.
 * @returns {Promise<{ ref: string, digest: string }>}
 */
export async function reHostImage(sourceImageRef, target, { runner = defaultRunner } = {}) {
  await runner('copy', [sourceImageRef, target]);
  const { stdout } = await runner('digest', [target]);
  const digest = String(stdout).trim();
  if (!/^sha256:[0-9a-f]{8,}$/i.test(digest)) {
    throw new Error(`crane digest returned an unexpected value: ${digest}`);
  }
  return { ref: `${target}@${digest}`, digest };
}

/** Return a copy of `config` with `srcRef` replaced by `arRef` in launch + install. */
export function pinManifestImage(config, srcRef, arRef) {
  if (!srcRef || !arRef) return config;
  const replace = (s) => (typeof s === 'string' ? s.split(srcRef).join(arRef) : s);
  return {
    ...config,
    launch: replace(config.launch),
    install: Array.isArray(config.install) ? config.install.map(replace) : config.install,
  };
}
