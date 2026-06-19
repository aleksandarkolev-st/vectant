/**
 * @fileoverview Mapper from a repo-root `Dockerfile` into the shared
 * NormalizedProgramConfig (Slice 1 — real programs): `docker build` then
 * `docker run`, with declared ports scraped from EXPOSE lines (the live runtime
 * port monitor still surfaces the actual published ports).
 */

import { parseProgramManifest } from './manifest';

function scrapeExposePorts(raw) {
  const out = [];
  const re = /^\s*EXPOSE\s+(.+)$/gim;
  let m;
  while ((m = re.exec(raw))) {
    for (const tok of m[1].split(/\s+/)) {
      const p = parseInt(tok, 10);
      if (p >= 1 && p <= 65535 && !out.includes(p)) out.push(p);
    }
  }
  return out;
}

function slugifyTag(name) {
  const s = String(name || 'app').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  return /^[a-z0-9]/.test(s) ? s : 'app';
}

/**
 * @param {string} raw - Dockerfile contents
 * @param {{ name?: string, containerRuntime?: boolean }} [options]
 * @returns {{ config: import('./manifest').NormalizedProgramConfig|null, source: string }}
 */
export function importDockerfile(raw, { name = 'app', containerRuntime = false } = {}) {
  const text = String(raw || '');
  if (!/^\s*FROM\s+/im.test(text)) {
    return { config: null, source: 'Dockerfile' };
  }
  if (!containerRuntime) {
    return { config: null, source: 'Dockerfile' };
  }

  const ports = scrapeExposePorts(text);
  const tag = slugifyTag(name);
  const portFlags = ports.map((p) => `-p ${p}:${p}`).join(' ');
  const config = parseProgramManifest({
    packageId: tag,
    version: '0.0.0',
    displayName: name,
    runtimeType: 'container',
    install: [`docker build -t ${tag} .`],
    launch: `docker run --rm ${portFlags ? `${portFlags} ` : ''}${tag}`.trim(),
    ports,
    permissions: ports.length ? ['program.launch', 'ports.expose', 'network.outbound'] : ['program.launch'],
  });
  config.source = 'Dockerfile';
  return { config, source: 'Dockerfile' };
}
