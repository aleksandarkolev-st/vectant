import { expect, test } from "@playwright/test";

const baseURL = process.env.VECTANT_TEST_BASE_URL || "http://127.0.0.1:3000";

test.describe("local support transparency page", () => {
  test("answers the core security transparency questions", async ({ page }) => {
    await page.goto(`${baseURL}/local-support`);

    await expect(page.getByRole("heading", { name: "Vectant Local Support" })).toBeVisible();
    await expect(page.getByText("Available locally is not the same as sent.")).toBeVisible();
    await expect(page.getByText("AI page reading remains off")).toBeVisible();
    await expect(page.getByText("Update required below 0.1.0")).toBeVisible();
    await expect(page.getByText("Your organization allows browser preview")).toBeVisible();
    await expect(page.getByText("Vectant AI page reading")).toBeVisible();
    await expect(page.getByText("Blocked by organization").first()).toBeVisible();
    await expect(page.getByText("Activity retention")).toBeVisible();
    await expect(page.getByText("30 days, raw bodies never stored")).toBeVisible();
    await expect(page.getByText("Workspace selection")).toBeVisible();
    await expect(page.getByText("Installation is not consent.")).toBeVisible();
    await expect(page.getByText("Workspace: not selected. Account: not paired. Session: not paired.")).toBeVisible();
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
    await expect(page.getByText("Auto-send, broad repo upload, persistent approvals")).toBeVisible();
    await page.getByRole("button", { name: "Revoke session approvals" }).click();
    await expect(page.getByText("Session approvals revoked. Future sends require review.")).toBeVisible();

    await page.getByRole("button", { name: "Pause" }).click();
    await expect(page.getByText("Paused")).toBeVisible();

    await page.getByRole("button", { name: "Disconnect", exact: true }).click();
    await expect(page.getByText("Disconnected")).toBeVisible();

    await page.getByRole("tab", { name: "Release gate" }).click();
    await expect(page.getByText("Release blocker evidence")).toBeVisible();
    await expect(page.getByText("Mapped", { exact: true })).toBeVisible();
    await expect(page.getByRole("table").getByText("Signed installer/update")).toBeVisible();
    await expect(page.getByText("CI required").first()).toBeVisible();
    await expect(page.getByText("Red-team scenarios")).toBeVisible();
    await expect(page.getByText("Malicious website localhost attack")).toBeVisible();
    await expect(page.getByText("Confused-deputy approval flow")).toBeVisible();
    await expect(page.getByText("UX acceptance prompts")).toBeVisible();
    await expect(page.getByText("What workspace is connected?")).toBeVisible();
    await expect(page.getByText("How do you delete local activity history?")).toBeVisible();
  });

  test("exports scrubbed history and deletes local activity", async ({ page }) => {
    await page.goto(`${baseURL}/local-support`);
    await page.getByRole("tab", { name: "Activity" }).click();

    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export scrubbed history" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("vectant-local-support-history-not_paired.json");

    const stream = await download.createReadStream();
    if (!stream) throw new Error("Expected exported history download stream");
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const exported = JSON.parse(Buffer.concat(chunks).toString("utf8"));

    expect(exported).toMatchObject({
      export_type: "scrubbed_activity_history",
      raw_bodies_included: false,
      session_id: "not_paired",
    });
    expect(exported.events).toHaveLength(0);
    expect(JSON.stringify(exported)).not.toContain("DATABASE_URL=");
    await expect(page.getByText("0 scrubbed events exported")).toBeVisible();

    await page.getByRole("button", { name: "Delete local history" }).click();
    await expect(page.getByText("Local activity history deleted.")).toBeVisible();
    await expect(page.getByText("Paired browser session with fingerprint")).toHaveCount(0);
  });
});
