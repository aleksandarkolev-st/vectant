import { describe, expect, it } from "vitest";

import nextConfig from "../../../next.config.mjs";

describe("local support route headers", () => {
  it("prevents local support UI and API routes from being framed", async () => {
    const headers = await nextConfig.headers();
    const localSupport = headers.find((entry) => entry.source === "/local-support");
    const apiLocalSupport = headers.find((entry) => entry.source === "/api/local-support/:path*");

    for (const entry of [localSupport, apiLocalSupport]) {
      expect(entry).toBeTruthy();
      const csp = entry.headers.find((header) => header.key === "Content-Security-Policy")?.value;
      expect(entry.headers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: "X-Frame-Options", value: "DENY" }),
          expect.objectContaining({ key: "X-Content-Type-Options", value: "nosniff" }),
          expect.objectContaining({ key: "Referrer-Policy", value: "no-referrer" }),
          expect.objectContaining({ key: "Cache-Control", value: "no-store" }),
          expect.objectContaining({
            key: "Content-Security-Policy",
            value: expect.stringContaining("frame-ancestors 'none'"),
          }),
        ]),
      );
      expect(csp).not.toContain("frame-ancestors 'self'");
    }
  });

  it("keeps Turbopack dependency aliases portable on Windows", () => {
    const yjsAlias = nextConfig.turbopack?.resolveAlias?.yjs;

    expect(yjsAlias).toContain("node_modules/yjs/dist/yjs.mjs");
    expect(yjsAlias).not.toMatch(/^[A-Za-z]:/);
    expect(yjsAlias).not.toContain("\\");
  });
});
