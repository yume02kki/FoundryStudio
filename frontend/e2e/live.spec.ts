import { expect, test } from "@playwright/test";
import { demo } from "./helpers";

// Polling mode (the default 10 s interval): no webhooks, no reloads.
test("AC4-6: new tag, new transformer and merge request CI show up live", async ({ page }) => {
  await page.goto("/?pipeline=SWpipeline&source=deployed");
  await expect(page.getByTestId("node-Base64Decoder")).toBeVisible();
  await expect(page.getByTestId("card-Base64Decoder")).toBeVisible();
  await page.evaluate(() => ((window as unknown as { __noReload: boolean }).__noReload = true));
  await expect(page.getByTestId("update-Base64Decoder")).toHaveCount(0);

  // AC4: pushing Base64Decoder/v0.4.3 shows the update badge within ~15 s.
  demo("tag", "Base64Decoder", "v0.4.3");
  await expect(page.getByTestId("update-Base64Decoder")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("update-Base64Decoder").click();
  await page.getByTestId("version-picker").getByRole("button", { name: /v0\.4\.3/ }).click();
  await expect(page.getByTestId("node-Base64Decoder")).toContainText("v0.4.3");
  await expect(page.getByTestId("update-Base64Decoder")).toHaveCount(0);

  // AC5: a new transformer folder with a transformer.yaml appears as a card.
  demo("add", "Deduplicate", "Packets", "Packets", "Drops repeated guids");
  await expect(page.getByTestId("card-Deduplicate")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("card-Deduplicate")).toContainText("Packets");

  // AC6: Deploy opens a merge request; its CI status follows along.
  await page.getByTestId("deploy").click();
  await page.getByTestId("deploy-confirm").click();
  await expect(page.getByTestId("deploy-result")).toContainText("Merge request opened");
  await expect(page.getByTestId("mr-chip")).toContainText("!1");
  await expect(page.getByTestId("mr-chip")).toContainText("CI running");
  demo("ci", "1", "failed");
  await expect(page.getByTestId("mr-chip")).toContainText("CI failed", { timeout: 15_000 });
  demo("ci", "1", "success");
  await expect(page.getByTestId("mr-chip")).toContainText("CI passed", { timeout: 15_000 });

  expect(await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload)).toBe(true);
});
