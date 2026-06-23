/**
 * @fileoverview Shared helper: bind-mount the per-workspace dir into a program
 * container so the program reads/writes the SAME `/workspace` files as the editor.
 *
 * `"$PWD"` resolves to the workspace repo dir at launch time — the program launch
 * runs with cwd = the workspace dir in both the Sysbox runtime pod
 * (`createRuntimePodProgram`) and the local hybrid runtime (`execInRuntime`), so the
 * one mechanism works identically in both. The target is the universal `/workspace`
 * path the existing devcontainer/Dockerfile mappers already use.
 */

/** The in-container mount target — the universal workspace path. */
export const WORKSPACE_MOUNT_TARGET = '/workspace';

/**
 * Docker `run` flags that bind the workspace into the container and cd into it.
 * Reused by the default container recipes and the devcontainer/Dockerfile mappers
 * so every container program sees the workspace files consistently.
 *
 * @returns {string} `-v "$PWD":/workspace -w /workspace`
 */
export function workspaceMountFlags() {
  return `-v "$PWD":${WORKSPACE_MOUNT_TARGET} -w ${WORKSPACE_MOUNT_TARGET}`;
}
