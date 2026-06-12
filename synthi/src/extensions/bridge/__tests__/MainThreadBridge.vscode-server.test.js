import { describe, expect, it, vi } from 'vitest';
import { MainThreadBridge } from '../MainThreadBridge.js';

describe('MainThreadBridge VS Code Server install routing', () => {
  it('uploads local VSIX bytes instead of treating private extensions as marketplace IDs', async () => {
    const bridge = new MainThreadBridge();
    bridge.installExtensionOnServer = vi.fn(async (id, vsixBase64) => ({ success: true, extensionId: id, vsixBase64 }));
    bridge.installMarketplaceExtensionOnServer = vi.fn();

    const result = await bridge._installOnVSCodeServerFromInfo({
      id: 'private.local-extension',
      installSource: 'vsix',
      vsixBase64: 'UEsDBAo=',
    });

    expect(result.success).toBe(true);
    expect(bridge.installExtensionOnServer).toHaveBeenCalledWith('private.local-extension', 'UEsDBAo=');
    expect(bridge.installMarketplaceExtensionOnServer).not.toHaveBeenCalled();
  });

  it('uses marketplace install for marketplace extensions', async () => {
    const bridge = new MainThreadBridge();
    bridge.installExtensionOnServer = vi.fn();
    bridge.installMarketplaceExtensionOnServer = vi.fn(async (id) => ({ success: true, extensionId: id }));

    const result = await bridge._installOnVSCodeServerFromInfo({
      id: 'dbaeumer.vscode-eslint',
      installSource: 'marketplace',
    });

    expect(result.success).toBe(true);
    expect(bridge.installMarketplaceExtensionOnServer).toHaveBeenCalledWith('dbaeumer.vscode-eslint');
    expect(bridge.installExtensionOnServer).not.toHaveBeenCalled();
  });

  it('uploads downloaded VSIX bytes for marketplace extensions when available', async () => {
    const bridge = new MainThreadBridge();
    bridge.installExtensionOnServer = vi.fn(async (id, vsixBase64) => ({ success: true, extensionId: id, vsixBase64 }));
    bridge.installMarketplaceExtensionOnServer = vi.fn();

    const result = await bridge._installOnVSCodeServerFromInfo({
      id: 'GitHub.vscode-pull-request-github',
      installSource: 'marketplace',
      vsixBase64: 'UEsDBAo=',
    });

    expect(result.success).toBe(true);
    expect(bridge.installExtensionOnServer).toHaveBeenCalledWith('GitHub.vscode-pull-request-github', 'UEsDBAo=');
    expect(bridge.installMarketplaceExtensionOnServer).not.toHaveBeenCalled();
  });

  it('fails with an actionable reason when a restored local VSIX has no bytes', async () => {
    const bridge = new MainThreadBridge();
    bridge.installExtensionOnServer = vi.fn();
    bridge.installMarketplaceExtensionOnServer = vi.fn();

    await expect(bridge._installOnVSCodeServerFromInfo({
      id: 'private.local-extension',
      installSource: 'vsix',
    })).rejects.toThrow('Local VSIX bytes are unavailable');

    expect(bridge.installExtensionOnServer).not.toHaveBeenCalled();
    expect(bridge.installMarketplaceExtensionOnServer).not.toHaveBeenCalled();
  });
});
