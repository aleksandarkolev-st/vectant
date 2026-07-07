import { describe, expect, it, vi } from 'vitest';
import { scanImage, summarizeTrivy } from '../imageScanner';

const trivyJson = (vulns) => JSON.stringify({
  Results: [{ Target: 'img', Vulnerabilities: vulns }],
});

describe('summarizeTrivy', () => {
  it('counts by severity and lists decisive (>= threshold) CVEs', () => {
    const out = summarizeTrivy(trivyJson([
      { VulnerabilityID: 'CVE-1', Severity: 'CRITICAL', PkgName: 'a' },
      { VulnerabilityID: 'CVE-2', Severity: 'HIGH', PkgName: 'b' },
      { VulnerabilityID: 'CVE-3', Severity: 'LOW', PkgName: 'c' },
    ]), 'HIGH');
    expect(out.severityCounts).toMatchObject({ CRITICAL: 1, HIGH: 1, LOW: 1 });
    expect(out.decisiveCves).toEqual(expect.arrayContaining(['CVE-1', 'CVE-2']));
    expect(out.decisiveCves).not.toContain('CVE-3');
  });

  it('is empty for a clean image', () => {
    const out = summarizeTrivy(trivyJson([]), 'HIGH');
    expect(out.decisiveCves).toEqual([]);
    expect(out.severityCounts).toEqual({ CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, UNKNOWN: 0 });
  });
});

describe('scanImage', () => {
  it('passes a clean image and returns the resolved digest', async () => {
    const runner = vi.fn().mockResolvedValue({ stdout: trivyJson([]) });
    const res = await scanImage('reg.io/me/tool@sha256:abc', { threshold: 'HIGH', runner });
    expect(res.ok).toBe(true);
    expect(res.summary.decisiveCves).toEqual([]);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('fails (ok=false) when a CVE meets/exceeds the threshold', async () => {
    const runner = vi.fn().mockResolvedValue({
      stdout: trivyJson([{ VulnerabilityID: 'CVE-9', Severity: 'CRITICAL', PkgName: 'x' }]),
    });
    const res = await scanImage('reg.io/me/tool:1', { threshold: 'HIGH', runner });
    expect(res.ok).toBe(false);
    expect(res.summary.decisiveCves).toContain('CVE-9');
  });

  it('fails closed when trivy errors or emits unparseable output', async () => {
    const runner = vi.fn().mockRejectedValue(new Error('trivy crashed'));
    const res = await scanImage('reg.io/me/tool:1', { threshold: 'HIGH', runner });
    expect(res.ok).toBe(false);
    expect(res.summary.error).toBeTruthy();
  });

  it('does not leak file paths/secrets — summary is counts + ids only', async () => {
    const runner = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ Results: [{ Target: '/home/secret/path', Vulnerabilities: [
        { VulnerabilityID: 'CVE-7', Severity: 'CRITICAL', PkgPath: '/etc/shadow' },
      ] }] }),
    });
    const res = await scanImage('reg.io/me/tool:1', { threshold: 'HIGH', runner });
    expect(JSON.stringify(res.summary)).not.toContain('/home/secret');
    expect(JSON.stringify(res.summary)).not.toContain('/etc/shadow');
  });
});
