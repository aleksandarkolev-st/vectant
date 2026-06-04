import { describe, expect, it } from "vitest";
import {
  createSynthiViteReactSourceIdentityPlugin,
  transformJsxSourceIdentity,
} from "../../src/browser/source_identity.js";

describe("SSR-safe source identity transform", () => {
  it("injects stable source ids into intrinsic JSX elements", async () => {
    const input = [
      "export function App() {",
      "  return <main><button className=\"primary\">Save</button><input aria-label=\"Email\" /></main>;",
      "}",
    ].join("\n");

    const first = await transformJsxSourceIdentity({
      code: input,
      filePath: "/repo/src/App.jsx",
      root: "/repo",
    });
    const second = await transformJsxSourceIdentity({
      code: input,
      filePath: "/repo/src/App.jsx",
      root: "/repo",
    });

    expect(first.code).toContain("data-synthi-source-id");
    expect(first.tokens.map((token) => token.tag)).toEqual(["main", "button", "input"]);
    expect(first.tokens[0]).toEqual(expect.objectContaining({
      file: "src/App.jsx",
      line: 2,
    }));
    expect(first.code).toBe(second.code);
    expect(first.tokens.map((token) => token.token)).toEqual(second.tokens.map((token) => token.token));
  });

  it("skips custom components instead of assuming prop forwarding", async () => {
    const result = await transformJsxSourceIdentity({
      code: "export const App = () => <Button><span>Label</span></Button>;",
      filePath: "/repo/src/App.tsx",
      root: "/repo",
    });

    expect(result.code).not.toContain("<Button data-synthi-source-id");
    expect(result.code).toContain("<span data-synthi-source-id");
    expect(result.stats.skipped_custom_components).toBe(1);
  });

  it("strips source ids for production builds", async () => {
    const result = await transformJsxSourceIdentity({
      code: "export const App = () => <button data-synthi-source-id=\"s_existing\">Save</button>;",
      filePath: "/repo/src/App.jsx",
      mode: "strip",
    });

    expect(result.code).not.toContain("data-synthi-source-id");
    expect(result.stats.stripped).toBe(1);
  });

  it("exposes a Vite-compatible pre transform without browser-side mutation", async () => {
    const seen: string[] = [];
    const plugin = createSynthiViteReactSourceIdentityPlugin({
      root: "/repo",
      onTokens: (_file, tokens) => seen.push(...tokens.map((token) => token.token)),
    });

    const result = await plugin.transform("export const App = () => <button>Save</button>;", "/repo/src/App.jsx");

    expect(plugin.name).toBe("synthi:vite-react-source-identity");
    expect(plugin.enforce).toBe("pre");
    expect(result?.code).toContain("data-synthi-source-id");
    expect(seen).toHaveLength(1);
  });
});
