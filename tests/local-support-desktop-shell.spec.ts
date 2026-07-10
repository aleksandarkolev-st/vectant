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
    await expect(page.getByText("Sensitive files stay blocked locally.")).toBeVisible();
    await expect(page.getByText("Disconnected", { exact: true })).toBeVisible();
    await expect(page.getByText("No workspace selected")).toBeVisible();
    await expect(page.getByRole("button", { name: "Disconnect" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Revoke session approvals" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Pause" })).toBeDisabled();
    await page.getByRole("button", { name: "Choose workspace" }).click();
    await expect(page.getByText("Workspace picker needs the paired desktop daemon. No local paths were exposed.")).toBeVisible();
    await page.getByRole("button", { name: "Pair session" }).click();
    await expect(page.getByText("Pairing needs a cloud challenge and local confirmation. No session was trusted.")).toBeVisible();

    await page.getByRole("tab", { name: "Overview", exact: true }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("tab", { name: "First run", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByText("Set up Local Support")).toBeVisible();
    await expect(page.getByText("No bytes sent in this view")).toBeVisible();
    await expect(page.getByText("Choose one workspace", { exact: true })).toBeVisible();
    await expect(page.getByText("Confirm pairing fingerprint")).toBeVisible();
    await expect(page.getByText("No folder is selected. This screen sends no workspace bytes while disconnected.")).toBeVisible();

    await page.getByRole("tab", { name: "Approvals", exact: true }).click();
    await expect(page.getByText("No live approval request")).toBeVisible();
    await expect(page.getByText("Zero bytes sent")).toBeVisible();
    await expect(page.getByText(".env and credential stores")).toBeVisible();
    await expect(page.getByRole("button", { name: "Open approval review" })).toBeDisabled();

    await page.getByRole("tab", { name: "Ports", exact: true }).click();
    await expect(page.getByText("No ports approved")).toBeVisible();
    await expect(page.getByText("Browser only")).toBeVisible();
    await expect(page.getByText("AI page body reading")).toBeVisible();
    await expect(page.getByRole("button", { name: "Review port approval" })).toBeDisabled();

    await page.getByRole("tab", { name: "Activity", exact: true }).click();
    await expect(page.getByText("History is empty")).toBeVisible();
    await expect(page.getByText("Raw bodies excluded")).toBeVisible();
    await expect(page.getByRole("button", { name: "Export scrubbed history" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Delete local history" })).toBeDisabled();

    await page.getByRole("tab", { name: "Overview", exact: true }).click();
    await expect(page.getByText("Disconnected", { exact: true })).toBeVisible();
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
            if (args.command === "workspace.pick") {
              return {
                connected: false,
                paused: false,
                session: {
                  account_id: "not paired",
                  workspace_id: "wk_selected",
                  device_fingerprint: "sha256:1111111111111111",
                  mode: "Balanced review before send",
                },
                approvals: [],
                ports: [],
                activity: [{ summary: "Workspace selected locally. No files were sent." }],
              };
            }
            if (args.command === "pairing.start") {
              return {
                connected: true,
                paused: false,
                session: {
                  account_id: "acct_demo",
                  workspace_id: "wk_selected",
                  device_fingerprint: "sha256:1111111111111111",
                  mode: "Balanced review before send",
                },
                approvals: [{ request_id: "req_file_review" }],
                ports: [{ port: 5173, preview_host: "br-local-p5173.vectant-preview.dev", preview_token: "raw-token-must-not-render" }],
                activity: [{ summary: "Pairing fingerprint confirmed locally." }],
              };
            }
            if (args.command === "approval.file.review") {
              return {
                connected: true,
                paused: false,
                session: {
                  account_id: "acct_demo",
                  workspace_id: "wk_selected",
                  device_fingerprint: "sha256:1111111111111111",
                  mode: "Balanced review before send",
                },
                approvals: [{ request_id: "req_file_review" }],
                ports: [{ port: 5173, preview_host: "br-local-p5173.vectant-preview.dev", preview_token: "raw-token-must-not-render" }],
                activity: [{ summary: "Opened local file approval review. Content stayed local." }],
              };
            }
            if (args.command === "approval.port.review") {
              return {
                connected: true,
                paused: false,
                session: {
                  account_id: "acct_demo",
                  workspace_id: "wk_selected",
                  device_fingerprint: "sha256:1111111111111111",
                  mode: "Balanced review before send",
                },
                approvals: [{ request_id: "req_file_review" }],
                ports: [{ port: 5173, preview_host: "br-local-p5173.vectant-preview.dev", preview_token: "raw-token-must-not-render" }],
                activity: [{ summary: "Opened browser-only port approval review. Preview token stayed hidden." }],
              };
            }
            if (args.command === "session.pause") {
              return {
                connected: true,
                paused: true,
                session: { account_id: "acct_demo", workspace_id: "wk_selected" },
                approvals: [],
                ports: [],
                activity: [{ summary: "Session paused by local user." }],
              };
            }
            if (args.command === "history.export") {
              return {
                connected: true,
                paused: false,
                session: { account_id: "acct_demo", workspace_id: "wk_demo" },
                approvals: [],
                ports: [{ port: 5173, preview_host: "br-local-p5173.vectant-preview.dev" }],
                activity: [{ summary: "Exported scrubbed history locally." }],
              };
            }
            if (args.command === "history.delete") {
              return {
                connected: true,
                paused: false,
                session: { account_id: "acct_demo", workspace_id: "wk_demo" },
                approvals: [],
                ports: [],
                activity: [{ summary: "Deleted local activity history." }],
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
    await expect(page.getByText("acct_demo", { exact: true })).toBeVisible();
    await expect(page.getByText("wk_demo", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Disconnect" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Revoke session approvals" })).toBeEnabled();
    await page.getByRole("button", { name: "Choose workspace" }).click();
    await page.getByRole("tab", { name: "Activity", exact: true }).click();
    await expect(page.getByText("Workspace selected locally. No files were sent.")).toBeVisible();
    await page.getByRole("tab", { name: "Overview", exact: true }).click();
    await page.getByRole("button", { name: "Pair session" }).click();
    await page.getByRole("tab", { name: "Activity", exact: true }).click();
    await expect(page.getByText("Pairing fingerprint confirmed locally.")).toBeVisible();
    await page.getByRole("tab", { name: "Overview", exact: true }).click();
    await expect(page.getByText("raw-token-must-not-render")).toHaveCount(0);

    await page.getByRole("tab", { name: "First run", exact: true }).click();
    await expect(page.getByText("Live sanitized state")).toBeVisible();
    await expect(page.getByText("Workspace wk_selected is selected for this support session only.")).toBeVisible();
    await expect(page.getByText("Sanitized IPC reports account acct_demo and device sha256:1111111111111111.")).toBeVisible();
    await expect(page.getByText("1 preview port approved for browser-only loopback access.")).toBeVisible();
    await expect(page.getByText("raw-token-must-not-render")).toHaveCount(0);

    await page.getByRole("tab", { name: "Approvals", exact: true }).click();
    await expect(page.getByText("1 approval request pending")).toBeVisible();
    await expect(page.getByText("Review required")).toBeVisible();
    await expect(page.getByRole("button", { name: "Open approval review" })).toBeEnabled();
    await page.getByRole("button", { name: "Open approval review" }).click();
    await page.getByRole("tab", { name: "Activity", exact: true }).click();
    await expect(page.getByText("Opened local file approval review. Content stayed local.")).toBeVisible();

    await page.getByRole("tab", { name: "Ports", exact: true }).click();
    await expect(page.getByText("1 browser preview port approved")).toBeVisible();
    await expect(page.getByText("127.0.0.1:5173 via br-local-p5173.vectant-preview.dev")).toBeVisible();
    await expect(page.getByRole("button", { name: "Review port approval" })).toBeEnabled();
    await page.getByRole("button", { name: "Review port approval" }).click();
    await page.getByRole("tab", { name: "Activity", exact: true }).click();
    await expect(page.getByText("Opened browser-only port approval review. Preview token stayed hidden.")).toBeVisible();
    await expect(page.getByText("raw-token-must-not-render")).toHaveCount(0);

    await page.getByRole("tab", { name: "Activity", exact: true }).click();
    await expect(page.getByText("1 local event recorded")).toBeVisible();
    await expect(page.getByText("Opened browser-only port approval review. Preview token stayed hidden.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Export scrubbed history" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Delete local history" })).toBeEnabled();
    await page.getByRole("button", { name: "Export scrubbed history" }).click();
    await expect(page.getByText("Exported scrubbed history locally.")).toBeVisible();

    await page.getByRole("tab", { name: "Overview", exact: true }).click();
    await page.getByRole("button", { name: "Pause" }).click();
    await expect(page.getByText("Paused", { exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "Activity", exact: true }).click();
    await expect(page.getByText("Session paused by local user.")).toBeVisible();
  });

  test("renders the real daemon approval summary shape", async ({ page }) => {
    await page.addInitScript(() => {
      window.__TAURI__ = {
        core: {
          invoke: async () => ({
            connected: true,
            paused: false,
            session: {
              account_id: "acct_live",
              workspace_id: "wk_live",
              device_fingerprint: "sha256:2222222222222222",
            },
            approvals: { pending_count: 2, content_included: false },
            ports: [],
            activity: [],
          }),
        },
      };
    });

    await page.goto(desktopShellUrl);
    await page.getByRole("tab", { name: "Approvals", exact: true }).click();

    await expect(page.getByText("2 approval requests pending")).toBeVisible();
    await expect(page.getByRole("button", { name: "Open approval review" })).toBeEnabled();
  });

  test("shows a native-selected workspace without exposing its absolute path", async ({ page }) => {
    await page.addInitScript(() => {
      window.__TAURI__ = {
        core: {
          invoke: async () => ({
            connected: false,
            paused: true,
            session: {
              account_id: "not paired",
              workspace_id: "wk_private",
              device_fingerprint: "sha256:3333333333333333",
            },
            workspace: {
              selected: true,
              display: "vectant-app",
              root_hash: "sha256:4444444444444444",
              root_path_included: false,
            },
            approvals: { pending_count: 0, content_included: false },
            ports: [],
            activity: [{ summary: "Workspace selected locally. No files were sent." }],
          }),
        },
      };
    });

    await page.goto(desktopShellUrl);
    await page.getByRole("tab", { name: "First run", exact: true }).click();

    await expect(page.getByText("Workspace vectant-app is selected for this support session only.")).toBeVisible();
    await expect(page.getByText("C:\\Users\\private\\vectant-app")).toHaveCount(0);
    await expect(page.getByText("Disconnected", { exact: true })).toBeVisible();
  });

  test("keeps controls reachable in a narrow desktop window", async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 700 });
    await page.goto(desktopShellUrl);

    const viewport = await page.evaluate(() => ({
      contentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    }));

    expect(viewport.contentWidth).toBeLessThanOrEqual(viewport.viewportWidth);
    await expect(page.getByRole("button", { name: "Choose workspace" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Activity", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Disconnect" })).toBeVisible();
  });
});
