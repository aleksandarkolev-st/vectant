import { describe, expect, it } from "vitest";
import { resolveBrowserPreviewTarget } from "../../src/browser/preview_target.js";
import type { BrowserTab } from "../../src/browser/types.js";

const tabs: BrowserTab[] = [
  { tab_id: "workspace", url: "http://localhost:3000/workspace/demo", title: "Synthi workspace", active: true },
  { tab_id: "preview", url: "http://localhost:5174/", title: "App preview", active: false },
  { tab_id: "external", url: "https://example.com/", title: "External", active: false },
];

describe("browser preview target selection", () => {
  it("selects a loopback preview tab without hardcoding the preview port", () => {
    const result = resolveBrowserPreviewTarget(tabs, {
      workspace_url: "http://localhost:3000/workspace/demo",
    }, {});

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected preview target");
    expect(result.tab.tab_id).toBe("preview");
    expect(result.origin).toBe("http://localhost:5174");
    expect(result.reason).toBe("loopback_workspace_preview");
  });

  it("uses an explicit workspace preview URL when the workspace is not loopback", () => {
    const result = resolveBrowserPreviewTarget([
      { tab_id: "workspace", url: "https://app.synthi.example/workspace/demo", title: "Workspace", active: true },
      { tab_id: "preview", url: "https://preview-abc.internal.example/", title: "Preview", active: false },
    ], {
      workspace_url: "https://app.synthi.example/workspace/demo",
      preview_url: "https://preview-abc.internal.example/",
    }, {});

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected preview target");
    expect(result.tab.tab_id).toBe("preview");
    expect(result.reason).toBe("workspace_preview_url");
  });

  it("prefers the supplied proxied preview path over stale tabs on the same proxy origin", () => {
    const result = resolveBrowserPreviewTarget([
      { tab_id: "workspace", url: "http://localhost:3000/workspace/demo", title: "Workspace", active: false },
      { tab_id: "stale", url: "http://localhost:1234/port/5173/", title: "Old preview", active: true },
      { tab_id: "current", url: "http://localhost:1234/port/36021/", title: "Current preview", active: false },
    ], {
      workspace_url: "http://localhost:3000/workspace/demo",
      preview_url: "http://localhost:1234/port/36021/",
      preferred_url: "http://localhost:1234/port/36021/",
    }, {});

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected preview target");
    expect(result.tab.tab_id).toBe("current");
    expect(result.reason).toBe("preferred_url");
  });

  it("keeps the selected proxied preview when the app navigates below the preview path", () => {
    const result = resolveBrowserPreviewTarget([
      { tab_id: "workspace", url: "http://localhost:3000/workspace/demo", title: "Workspace", active: false },
      { tab_id: "stale", url: "http://localhost:1234/port/5173/settings", title: "Old preview", active: true },
      { tab_id: "current", url: "http://localhost:1234/port/36021/dashboard", title: "Current preview", active: false },
    ], {
      workspace_url: "http://localhost:3000/workspace/demo",
      preview_url: "http://localhost:1234/port/36021/",
    }, {});

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected preview target");
    expect(result.tab.tab_id).toBe("current");
    expect(result.reason).toBe("workspace_preview_url_path");
  });

  it("does not auto-select arbitrary third-party tabs", () => {
    const result = resolveBrowserPreviewTarget([
      { tab_id: "workspace", url: "https://app.synthi.example/workspace/demo", title: "Workspace", active: true },
      { tab_id: "external", url: "https://example.com/", title: "External", active: false },
    ], {
      workspace_url: "https://app.synthi.example/workspace/demo",
    }, {});

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      error: "preview_target_not_found",
    }));
  });
});
