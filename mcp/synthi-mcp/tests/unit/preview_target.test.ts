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
