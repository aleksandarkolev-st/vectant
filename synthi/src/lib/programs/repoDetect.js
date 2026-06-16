/**
 * @fileoverview Repo auto-detection (Slice 1 — real programs): map the
 * highest-precedence container artifact found in a workspace into the shared
 * NormalizedProgramConfig. Precedence: docker-compose → devcontainer (with an
 * image/build) → Dockerfile. Gated on the server-truthful `containerRuntime`
 * capability so it is inert when no container runtime exists.
 */

import { importComposeFile } from './compose';
import { importDockerfile } from './dockerfile';
import { importDevcontainer } from './devcontainer';

/**
 * @param {{ files?: Record<string,string>, containerRuntime?: boolean, name?: string }} args
 *   files: repo-root filename → contents (only the candidate files need be present).
 * @returns {{ config: import('./manifest').NormalizedProgramConfig, source: string } | null}
 */
export function detectRepoProgram({ files = {}, containerRuntime = false, name = 'repo' } = {}) {
  if (!containerRuntime) return null;

  const compose = files['docker-compose.yml'] || files['compose.yaml'] || files['compose.yml'];
  if (compose) {
    const { config } = importComposeFile(compose, { containerRuntime });
    if (config) return { config, source: 'docker-compose.yml' };
  }

  const dc = files['.devcontainer/devcontainer.json'] || files['.devcontainer.json'] || files['devcontainer.json'];
  if (dc) {
    const { config } = importDevcontainer(dc, { containerRuntime });
    if (config?.runtimeType === 'container') return { config, source: 'devcontainer.json' };
  }

  const dockerfile = files.Dockerfile;
  if (dockerfile) {
    const { config } = importDockerfile(dockerfile, { name, containerRuntime });
    if (config) return { config, source: 'Dockerfile' };
  }

  return null;
}
