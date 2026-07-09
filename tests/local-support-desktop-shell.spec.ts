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
});
