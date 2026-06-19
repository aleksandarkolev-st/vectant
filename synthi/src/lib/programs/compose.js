/**
 * @fileoverview Minimal, dependency-free mapper from a `docker-compose.yml` into
 * the shared NormalizedProgramConfig (Slice 1 — real programs). `docker compose up`
 * reads the file itself, so we do NOT parse the full YAML: we confirm it is a compose
 * file, reject obvious host-escape requests (text scan, mirroring devcontainer.js),
 * and best-effort scrape published host ports for an initial App-tab hint. The live
 * runtime-port monitor is the authoritative source of a container's published ports.
 */

import { parseProgramManifest, ProgramManifestError } from './manifest';

// Text-scan host-escape guard: docker socket, privileged services, absolute-path
// bind mounts (`- /host:/ctr`), or any /var/run reference. Named volumes
// (`- vol:/data`) and port mappings (`- "8080:80"`) do NOT start with `/`, so they
// are not flagged.
const HOST_ESCAPE_RE = /docker\.sock|^\s*privileged:\s*true|-\s*\/(?:[^:\n]*):|\/var\/run/im;

/** Best-effort host-port scrape from `ports:` list items (live monitor is authoritative). */
function scrapeComposePorts(raw) {
  const out = [];
  const re = /^\s*-\s*"?(?:\d{1,3}(?:\.\d{1,3}){3}:)?(\d{1,5}):\d{1,5}"?\s*$/gm;
  let m;
  while ((m = re.exec(raw))) {
    const p = parseInt(m[1], 10);
    if (p >= 1 && p <= 65535 && !out.includes(p)) out.push(p);
  }
  return out;
}

/**
 * @param {string} raw - docker-compose.yml contents
 * @param {{ containerRuntime?: boolean }} [options]
 * @returns {{ config: import('./manifest').NormalizedProgramConfig|null, source: string }}
 * @throws {ProgramManifestError} when the input is not a compose file or requests host access
 */
export function importComposeFile(raw, { containerRuntime = false } = {}) {
  const text = String(raw || '');
  if (!/^\s*services:/m.test(text)) {
    throw new ProgramManifestError('invalid_manifest', 'Not a recognizable compose file', 'services');
  }
  if (HOST_ESCAPE_RE.test(text)) {
    throw new ProgramManifestError('host_escape', 'compose requests host access', 'volumes');
  }
  if (!containerRuntime) {
    return { config: null, source: 'docker-compose.yml' };
  }

  const ports = scrapeComposePorts(text);
  const config = parseProgramManifest({
    packageId: 'compose-project',
    version: '0.0.0',
    displayName: 'Compose project',
    runtimeType: 'container',
    launch: 'docker compose up',
    ports,
    permissions: ports.length ? ['program.launch', 'ports.expose', 'network.outbound'] : ['program.launch'],
  });
  config.source = 'docker-compose.yml';
  return { config, source: 'docker-compose.yml' };
}
