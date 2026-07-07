/**
 * @fileoverview trivy CVE scan wrapper for community-app images. The exec
 * `runner` is injectable so unit tests never shell out; the default runner uses
 * host-native trivy.exe with cache + temp on the roomy drive (lesson #28).
 * Output is reduced to a redacted summary (severity counts + decisive CVE ids,
 * no file paths) so it is safe to persist + show in the admin queue.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const SEVERITY_ORDER = ['UNKNOWN', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const DEFAULT_THRESHOLD = process.env.PROGRAM_SCAN_THRESHOLD || 'HIGH';

/** Default runner: host-native trivy.exe, DB + temp forced to D: (lesson #28). */
async function defaultRunner(imageRef) {
  const cacheDir = process.env.TRIVY_CACHE_DIR || 'D:\\trivy-cache';
  return execFileAsync(
    process.env.TRIVY_BIN || 'trivy',
    ['image', '--quiet', '--format', 'json', '--timeout', '9m', '--cache-dir', cacheDir, imageRef],
    { maxBuffer: 64 * 1024 * 1024 },
  );
}

/** Reduce trivy JSON to a redacted summary against `threshold`. */
export function summarizeTrivy(stdout, threshold = DEFAULT_THRESHOLD) {
  const counts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, UNKNOWN: 0 };
  const decisiveCves = [];
  const minIdx = SEVERITY_ORDER.indexOf(String(threshold).toUpperCase());
  const data = JSON.parse(stdout); // throws on bad JSON → caller fails closed
  for (const result of data.Results || []) {
    for (const v of result.Vulnerabilities || []) {
      const sev = String(v.Severity || 'UNKNOWN').toUpperCase();
      if (counts[sev] == null) counts[sev] = 0;
      counts[sev] += 1;
      if (SEVERITY_ORDER.indexOf(sev) >= minIdx && v.VulnerabilityID) {
        if (!decisiveCves.includes(v.VulnerabilityID)) decisiveCves.push(v.VulnerabilityID);
      }
    }
  }
  return { threshold: String(threshold).toUpperCase(), severityCounts: counts, decisiveCves };
}

/**
 * Scan an image by ref/digest. Fail-closed: any error → ok:false.
 * @returns {Promise<{ ok: boolean, summary: object }>}
 */
export async function scanImage(imageRef, { threshold = DEFAULT_THRESHOLD, runner = defaultRunner } = {}) {
  try {
    const { stdout } = await runner(imageRef);
    const summary = summarizeTrivy(stdout, threshold);
    return { ok: summary.decisiveCves.length === 0, summary };
  } catch (err) {
    return { ok: false, summary: { threshold: String(threshold).toUpperCase(), error: String(err?.message || err) } };
  }
}
