import { afterEach, describe, expect, it } from "vitest";

import { GET } from "./route";

const OLD_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...OLD_ENV };
});

describe("local support policy route", () => {
  it("shows disabled state when policy is not enabled", async () => {
    delete process.env.VECTANT_LOCAL_SUPPORT_ENABLED;

    const response = await GET();
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.enabled).toBe(false);
    expect(json.user_visible_message).toContain("disabled");
  });

  it("shows org kill switch and minimum version when enabled but org-blocked", async () => {
    process.env.VECTANT_LOCAL_SUPPORT_ENABLED = "true";
    process.env.VECTANT_LOCAL_SUPPORT_ORG_DISABLED = "true";
    process.env.VECTANT_LOCAL_SUPPORT_MIN_APP_VERSION = "0.4.0";

    const response = await GET();
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toMatchObject({
      enabled: false,
      global_enabled: true,
      org_kill_switch: true,
      min_app_version: "0.4.0",
    });
  });
});
