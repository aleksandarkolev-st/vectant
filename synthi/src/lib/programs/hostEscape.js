/**
 * @fileoverview Shared host-escape ruleset. Single source of truth for the
 * denylist that both the devcontainer importer and the community-submission
 * hard gates apply — reject docker.sock / host bind mounts / privileged /
 * --cap-add / --security-opt / --device. NOTE: this is defense-in-depth, not a
 * containment guarantee — the real isolation is the installer's Sysbox runtime.
 */

/** Privilege/host-access flags that are never allowed in a program command. */
export const HOST_ESCAPE_FLAG_RE = /(^|\s)(--privileged|--cap-add|--security-opt|--device)(=|\s|$)/i;

/** The docker daemon socket / host runtime dir, however referenced. */
export const DOCKER_SOCK_RE = /docker\.sock|\/var\/run\/docker/i;

/**
 * A `-v` / `--volume` whose SOURCE is an absolute host path (starts with `/`).
 * The legitimate workspace mount `-v "$PWD":/workspace` is NOT matched: after
 * the (optional) quote the source begins with `$`, not `/`.
 */
export const HOST_BIND_MOUNT_RE = /(^|\s)(-v|--volume)(\s+|=)["']?\/[^"'\s]/i;

/**
 * Scan a shell command string for any host-escape pattern.
 * @param {string} text
 * @returns {string|null} the matched offending substring, or null if clean.
 */
export function findCommandHostEscape(text) {
  if (typeof text !== 'string' || !text) return null;
  for (const re of [DOCKER_SOCK_RE, HOST_ESCAPE_FLAG_RE, HOST_BIND_MOUNT_RE]) {
    const m = re.exec(text);
    if (m) return m[0].trim();
  }
  return null;
}
