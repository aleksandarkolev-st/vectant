import { expect, test } from "@playwright/test";
import path from "path";
import { pathToFileURL } from "url";

const desktopShellUrl = pathToFileURL(
  path.resolve("backend/vectant-local-support-app/desktop/ui/index.html"),
).toString();

test.describe("local support desktop shell", () => {
  test("shows a security-first desktop control surface without faking connection state", async ({ page }) => {
    await page.goto(desktopShellUrl);

    await expect(page.getByRole("heading", { name: "Vectant Local Support" })).toBeVisible();
    await expect(page.getByText("You control what Vectant can see.")).toBeVisible();
    await expect(page.getByText("Workspace selection is not consent.")).toBeVisible();
    await expect(page.getByText("Disconnected", { exact: true })).toBeVisible();
    await expect(page.getByText("No workspace selected")).toBeVisible();
    await expect(page.getByRole("button", { name: "Disconnect" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Revoke session approvals" })).toBeDisabled();

    await page.getByRole("button", { name: "Approvals", exact: true }).click();
    await expect(page.getByText("No live approval request")).toBeVisible();
    await expect(page.getByText("Zero bytes sent")).toBeVisible();
    await expect(page.getByText(".env and credential stores")).toBeVisible();

    await page.getByRole("button", { name: "Ports", exact: true }).click();
    await expect(page.getByText("No ports approved")).toBeVisible();
    await expect(page.getByText("Browser only")).toBeVisible();
    await expect(page.getByText("AI page body reading")).toBeVisible();

    await page.getByRole("button", { name: "Activity", exact: true }).click();
    await expect(page.getByText("History is empty")).toBeVisible();
    await expect(page.getByText("Raw bodies excluded")).toBeVisible();
    await expect(page.getByRole("button", { name: "Export scrubbed history" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Delete local history" })).toBeDisabled();

    await page.getByRole("button", { name: "Overview", exact: true }).click();
    await page.getByRole("button", { name: "Pause" }).click();
    await expect(page.getByText("Paused", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Resume" })).toBeVisible();
  });

  test("renders sanitized desktop IPC state without exposing local secrets", async ({ page }) => {
    await page.addInitScript(() => {
      window.__TAURI__ = {
        core: {
          invoke: async (command, args) => {
            if (command !== "local_support_ipc") throw new Error("unexpected command");
            if (args.command === "session.status") {
              return {
                connected: true,
                paused: false,
                session: {
                  account_id: "acct_demo",
                  workspace_id: "wk_demo",
                  device_fingerprint: "sha256:1111111111111111",
                  mode: "Balanced review before send",
                },
                approvals: [{ request_id: "req_file_review" }],
                ports: [{ port: 5173, preview_host: "br-local-p5173.vectant-preview.dev", preview_token: "raw-token-must-not-render" }],
                activity: [{ summary: "Blocked .env locally. Nothing was sent." }],
              };
            }
            if (args.command === "session.pause") {
              return {
                connected: true,
                paused: true,
                session: { account_id: "acct_demo", workspace_id: "wk_demo" },
                approvals: [],
                ports: [],
                activity: [{ summary: "Session paused by local user." }],
              };
            }
            return { connected: true, paused: false, session: { account_id: "acct_demo", workspace_id: "wk_demo" } };
          },
        },
      };
    });

    await page.goto(desktopShellUrl);

    await expect(page.getByText("Connected", { exact: true })).toBeVisible();
    await expect(page.getByText("Desktop IPC connected. Renderer received sanitized state only.")).toBeVisible();
    await expect(page.getByText("acct_demo")).toBeVisible();
    await expect(page.getByText("wk_demo").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Disconnect" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Revoke session approvals" })).toBeEnabled();

    await page.getByRole("button", { name: "Approvals", exact: true }).click();
    await expect(page.getByText("1 approval request pending")).toBeVisible();
    await expect(page.getByText("Review required")).toBeVisible();

    await page.getByRole("button", { name: "Ports", exact: true }).click();
    await expect(page.getByText("1 browser preview port approved")).toBeVisible();
    await expect(page.getByText("127.0.0.1:5173 via br-local-p5173.vectant-preview.dev")).toBeVisible();
    await expect(page.getByText("raw-token-must-not-render")).toHaveCount(0);

    await page.getByRole("button", { name: "Activity", exact: true }).click();
    await expect(page.getByText("1 local event recorded")).toBeVisible();
    await expect(page.getByText("Blocked .env locally. Nothing was sent.")).toBeVisible();

    await page.getByRole("button", { name: "Overview", exact: true }).click();
    await page.getByRole("button", { name: "Pause" }).click();
    await expect(page.getByText("Paused", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Activity", exact: true }).click();
    await expect(page.getByText("Session paused by local user.")).toBeVisible();
  });
});
