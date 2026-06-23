import { describe, expect, it } from 'vitest';
import { WORKSPACE_MOUNT_TARGET, workspaceMountFlags } from '../workspaceMount';

describe('workspaceMountFlags', () => {
  it('binds the workspace into the container and sets it as the working dir', () => {
    expect(workspaceMountFlags()).toBe('-v "$PWD":/workspace -w /workspace');
  });

  it('uses the universal /workspace mount target', () => {
    expect(WORKSPACE_MOUNT_TARGET).toBe('/workspace');
    expect(workspaceMountFlags()).toContain(WORKSPACE_MOUNT_TARGET);
  });
});
