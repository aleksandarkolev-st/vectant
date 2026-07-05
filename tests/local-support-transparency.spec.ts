import { expect, test } from "@playwright/test";

const baseURL = process.env.VECTANT_TEST_BASE_URL || "http://127.0.0.1:3000";

test.describe("local support transparency page", () => {
  test("answers the core security transparency questions", async ({ page }) => {
    await page.goto(`${baseURL}/local-support`);

    await expect(page.getByRole("heading", { name: "Vectant Local Support" })).toBeVisible();
    await expect(page.getByText("Available locally is not the same as sent.")).toBeVisible();
    await expect(page.getByText("AI page reading remains off")).toBeVisible();

    await page.getByRole("tab", { name: "Inventory" }).click();
    await expect(page.getByText(".env")).toBeVisible();
    await expect(page.getByText("Blocked locally")).toHaveCount(2);
    await expect(page.getByText("Sent to Vectant")).toBeVisible();

    await page.getByRole("tab", { name: "Ports" }).click();
    await expect(page.getByText("localhost:5173")).toBeVisible();
    await expect(page.getByText("GET, HEAD, OPTIONS")).toBeVisible();
    await expect(page.getByRole("cell", { name: "Off" }).first()).toBeVisible();

    await page.getByRole("button", { name: "Pause" }).click();
    await expect(page.getByText("Paused")).toBeVisible();

    await page.getByRole("button", { name: "Disconnect" }).click();
    await expect(page.getByText("Disconnected")).toBeVisible();
  });
});
