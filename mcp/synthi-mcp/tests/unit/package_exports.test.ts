import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("package exports", () => {
  it("exposes the Vite React source identity adapter as a stable developer subpath", () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      exports?: Record<string, unknown>;
    };

    expect(pkg.exports).toEqual(expect.objectContaining({
      ".": expect.objectContaining({
        import: "./dist/index.js",
        types: "./dist/index.d.ts",
      }),
      "./source-identity": expect.objectContaining({
        import: "./dist/browser/source_identity.js",
        types: "./dist/browser/source_identity.d.ts",
      }),
    }));
  });
});
