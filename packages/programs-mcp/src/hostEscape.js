/**
 * @fileoverview Host-escape ruleset — a standalone copy of the denylist the
 * Vectant backend enforces in synthi/src/lib/programs/hostEscape.js. Duplicated
 * here (rather than imported) because this MCP package ships independently of the
 * Next app. It is ADVISORY in this context: it lets an authoring agent catch a
 * host-escaping command early. The authoritative, fail-closed enforcement is the
 * backend hard gate + review pipeline at publish time. Keep in sync with the
 * backend copy — reject docker.sock / host bind mounts / privileged / --cap-add /
 * --security-opt / --device.
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
