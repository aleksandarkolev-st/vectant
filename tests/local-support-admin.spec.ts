import { expect, test } from "@playwright/test";

const baseURL = process.env.VECTANT_TEST_BASE_URL;
if (!baseURL) throw new Error("VECTANT_TEST_BASE_URL is required for Local Support browser tests.");

test("operators load live state, update policy, and revoke a session", async ({ page }) => {
  const requests: Array<Record<string, unknown>> = [];
  await page.route("**/api/local-support/admin/state**", async (route) => {
    const request = route.request();
    expect(request.headers()["x-vectant-admin-token"]).toBe("admin-secret");
    if (request.method() === "POST") {
      requests.push(request.postDataJSON());
      await route.fulfill({ json: { decision: "policy_updated", bytes_sent: 0 } });
      return;
    }
    await route.fulfill({
      json: {
        decision: "admin_state_ready",
        policy: {
          enabled: true,
          org_id: "org_acme",
          global_enabled: true,
          org_disabled: false,
          pairing_disabled: false,
          preview_disabled: false,
          agent_access_disabled: true,
          min_app_version: "0.1.0",
          vulnerable_versions: [],
          retention_days: 30,
        },
        paired_devices: [{ device_id: "dev_123", app_version: "0.1.0", approved_ports_count: 1 }],
        active_sessions: [{ session_id: "sess_123", app_version: "0.1.0", approved_ports_count: 1 }],
        security_alerts: [{ event_id: "evt_1", event_type: "bad_origin", severity: "high", alert_route: "security_ops" }],
      },
    });
  });

  await page.goto(`${baseURL}/local-support/admin`);
  await page.getByLabel("Operations token").fill("admin-secret");
  await page.getByLabel("Organization scope (blank = global)").fill("org_acme");
  await page.getByRole("button", { name: "Load" }).click();

  await expect(page.getByText("dev_123")).toBeVisible();
  await expect(page.getByText("bad_origin")).toBeVisible();
  await page.getByText("Preview disabled").click();
  await page.getByRole("button", { name: "Apply policy" }).click();
  await expect.poll(() => requests.some((body) => body.action === "update_policy" && body.org_id === "org_acme" && body.preview_disabled === true)).toBe(true);

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Revoke" }).nth(1).click();
  await expect.poll(() => requests.some((body) => body.target_type === "session" && body.target_id === "sess_123")).toBe(true);
});
