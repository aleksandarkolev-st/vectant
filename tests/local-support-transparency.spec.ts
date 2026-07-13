import { expect, test } from "@playwright/test";

const baseURL = process.env.VECTANT_TEST_BASE_URL;
if (!baseURL) throw new Error("VECTANT_TEST_BASE_URL is required for Local Support browser tests.");

test.describe("local support transparency page", () => {
  test("answers the core security transparency questions", async ({ page }) => {
    await page.goto(`${baseURL}/local-support`);

    await expect(page.getByRole("heading", { name: "Vectant Local Support" })).toBeVisible();
    await expect(page.getByText("Available locally is not the same as sent.")).toBeVisible();
    await expect(page.getByText("AI and support page access", { exact: true })).toBeVisible();
    await expect(page.getByText("Blocked in MVP").first()).toBeVisible();
    await expect(page.getByText(/Update required below 0\.1\.0|Not reported/).first()).toBeVisible();
    await expect(page.getByText("Browser preview is available only through an explicit session-scoped loopback grant. AI and support-agent page reads remain blocked in the MVP.")).toBeVisible();
    await expect(page.getByText("Vectant AI page reading")).toBeVisible();
    await expect(page.getByText("Blocked in MVP")).toHaveCount(3);
    await expect(page.getByText("Activity retention")).toBeVisible();
    await expect(page.getByText(/30 days|Not reported/).first()).toBeVisible();
    await expect(page.getByText("Raw bodies are never stored in cloud audit")).toBeVisible();
    await expect(page.getByText("Workspace selection")).toBeVisible();
    await expect(page.getByText("Installation is not consent.")).toBeVisible();
    await expect(page.getByText("Workspace: No workspace selected. Account: Not paired. Session: Not paired.")).toBeVisible();
    await expect(page.getByText("Disconnected")).toBeVisible();
    await expect(page.getByText("No live approval request")).toBeVisible();

    await page.getByRole("tab", { name: "Inventory" }).click();
    await expect(page.getByText("No live local support records yet.")).toBeVisible();
    await expect(page.getByText("Sent to Vectant")).toHaveCount(0);

    await page.getByRole("tab", { name: "Ports" }).click();
    await expect(page.getByText("No local ports are approved.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Revoke port approval" })).toHaveCount(0);

    await page.getByRole("tab", { name: "Permission mode" }).click();
    await expect(page.getByRole("cell", { name: "Balanced mode" })).toBeVisible();
    await expect(page.getByRole("cell", { name: "Manual mode" })).toBeVisible();
    await expect(page.getByRole("cell", { name: "Fast Support" })).toBeVisible();
    await expect(page.getByText(/Secrets, workspace writes, commands, .*persistent approvals/).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Revoke session approvals" })).toBeDisabled();
    await expect(page.getByText("This page will not fake a revoke.")).toBeVisible();

    await expect(page.getByRole("button", { name: "Disconnect", exact: true })).toBeDisabled();
    await expect(page.getByText("Disconnected")).toBeVisible();

    await expect(page.getByRole("tab", { name: "Release gate" })).toHaveCount(0);
  });

  test("does not fake history export or delete without a connected local app", async ({ page }) => {
    await page.goto(`${baseURL}/local-support`);
    await page.getByRole("tab", { name: "Activity" }).click();

    await expect(page.getByRole("button", { name: "Export current scrubbed view" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Delete local history" })).toBeDisabled();
    await expect(page.getByText("This page will not fake local storage actions.")).toBeVisible();
    await expect(page.getByText("Paired browser session with fingerprint")).toHaveCount(0);
  });

  test("creates and displays a live one-time pairing challenge", async ({ page }) => {
    let pairingRequest;
    await page.route("**/api/local-support/policy", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ enabled: true, policy_version: "2026.07.05" }),
      });
    });
    await page.route("**/api/local-support/pairing", async (route) => {
      pairingRequest = JSON.parse(route.request().postData() || "{}");
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          decision: "pairing_challenge_created",
          code: "ABCD2345WXYZ",
          fingerprint: "1a2b-3c4d-5e6f",
          expires_in_seconds: 120,
          raw_body_included: false,
          bytes_sent: 0,
        }),
      });
    });
    await page.goto(`${baseURL}/local-support`);

    await page.getByRole("button", { name: "Start pairing" }).click();

    expect(pairingRequest.workspace_id).toBe("wk_pending_local_selection");
    await expect(page.getByText("ABCD2345WXYZ", { exact: true })).toBeVisible();
    await expect(page.getByText("Expires in 2 minutes", { exact: true })).toBeVisible();
    await expect(page.getByText("1a2b-3c4d-5e6f", { exact: true })).toBeVisible();
    await expect(page.getByText("Confirm only if this fingerprint appears in the desktop app.")).toBeVisible();
  });

  test("refreshes durable transparency state without reloading the page", async ({ page }) => {
    let stateReads = 0;
    await page.route("**/api/local-support/policy", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ enabled: true, policy_version: "2026.07.05" }),
      });
    });
    await page.route("**/api/local-support/transparency-state", async (route) => {
      stateReads += 1;
      const connected = stateReads > 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          decision: "transparency_state_ready",
          session: connected
            ? {
                connected: true,
                paused: false,
                account_id: "acct_live",
                session_id: "sess_live_12345678",
                device_fingerprint: "sha256:1111111111111111",
              }
            : { connected: false, session_id: "not_paired" },
          workspace: connected
            ? { workspace_id: "wk_live_12345678", display: "Live relay workspace" }
            : { workspace_id: "not_selected", display: "No workspace selected" },
          inventory: [],
          sent_payloads: [],
          blocked_items: [],
          activity: [],
          ports: [],
          export_metadata: { raw_bodies_included: false, audit_chain_verified: false },
        }),
      });
    });

    await page.goto(`${baseURL}/local-support`);
    await expect(page.getByText("Workspace: No workspace selected. Account: Not paired. Session: Not paired.")).toBeVisible();

    await expect(page.getByText("Workspace: Live relay workspace. Account: acct_live. Session: sess_live_12345678."))
      .toBeVisible({ timeout: 6_000 });
    await expect(page.getByText("Connected").first()).toBeVisible();
    expect(stateReads).toBeGreaterThan(1);
  });

  test("renders cloud-shaped inventory rows without crashing", async ({ page }) => {
    await page.route("**/api/local-support/policy", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ enabled: true, policy_version: "2026.07.05" }),
      });
    });
    await page.route("**/api/local-support/transparency-state", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          decision: "transparency_state_ready",
          session: { connected: false, session_id: "not_paired" },
          workspace: { workspace_id: "not_selected", display: "No workspace selected" },
          inventory: [{ target: "workspace/src/app.jsx", state: "approval_required", classification: "source_code" }],
          sent_payloads: [], blocked_items: [], activity: [], ports: [],
        }),
      });
    });

    await page.goto(`${baseURL}/local-support`);
    await page.getByRole("tab", { name: "Inventory" }).click();
    await expect(page.getByText("workspace/src/app.jsx")).toBeVisible();
    await expect(page.getByText("Review required")).toBeVisible();
  });

  test("enables and downgrades bounded Fast Support for a connected workspace", async ({ page }) => {
    await page.route("**/api/local-support/policy", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          enabled: true,
          policy_version: "2026.07.05",
          mvp: { fast_support_enabled: true, fast_support_ttl_minutes: 30 },
        }),
      });
    });
    await page.route("**/api/local-support/transparency-state", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          decision: "transparency_state_ready",
          session: {
            connected: true,
            paused: false,
            account_id: "acct_live",
            session_id: "sess_live_12345678",
            permission_mode: "Balanced mode",
          },
          workspace: { workspace_id: "wk_live_12345678", display: "vectant-app" },
          inventory: [], sent_payloads: [], blocked_items: [], activity: [], ports: [],
        }),
      });
    });
    await page.route("**/api/local-support/transparency-action", async (route) => {
      const body = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          decision: "local_control_action_applied",
          action: body.action,
          user_visible_message: body.action === "enable_fast_support"
            ? "Fast Support enabled for this workspace for up to 30 minutes."
            : "Fast Support disabled.",
        }),
      });
    });

    await page.goto(`${baseURL}/local-support`);
    await page.getByRole("tab", { name: "Permission mode" }).click();
    await page.getByRole("button", { name: "Enable Fast Support" }).click();
    await expect(page.getByRole("status")).toContainText("Fast Support is active for this session");
    await expect(page.getByRole("button", { name: "Switch to Balanced" })).toBeVisible();
    await page.getByRole("button", { name: "Switch to Balanced" }).click();
    await expect(page.getByRole("button", { name: "Enable Fast Support" })).toBeVisible();
  });
});
