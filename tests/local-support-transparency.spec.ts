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

  test("exports scrubbed history and deletes local activity", async ({ page }) => {
    await page.goto(`${baseURL}/local-support`);
    await page.getByRole("tab", { name: "Activity" }).click();

    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export scrubbed history" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("vectant-local-support-history-sess_7K9.json");

    const stream = await download.createReadStream();
    if (!stream) throw new Error("Expected exported history download stream");
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const exported = JSON.parse(Buffer.concat(chunks).toString("utf8"));

    expect(exported).toMatchObject({
      export_type: "scrubbed_activity_history",
      raw_bodies_included: false,
      session_id: "sess_7K9",
    });
    expect(exported.events).toHaveLength(5);
    expect(JSON.stringify(exported)).not.toContain("DATABASE_URL=");
    await expect(page.getByText("5 scrubbed events exported")).toBeVisible();

    await page.getByRole("button", { name: "Delete local history" }).click();
    await expect(page.getByText("Local activity history deleted for this mock session.")).toBeVisible();
    await expect(page.getByText("Paired browser session with fingerprint")).toHaveCount(0);
  });
});
