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
          expect.objectContaining({
            key: "Content-Security-Policy",
            value: expect.stringContaining("frame-ancestors 'none'"),
          }),
        ]),
      );
      expect(csp).not.toContain("frame-ancestors 'self'");
    }
  });
});
