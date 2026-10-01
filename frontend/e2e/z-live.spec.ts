// Runs last (files run alphabetically on one worker): it pushes tags and commits to the demo
// repos, which would change what the other tests render.
import { expect, test } from "@playwright/test";
import { demo } from "./helpers";

// Polling mode (the default 10 s interval): no webhooks, no reloads.
test("AC4-6: new tag and new transformer show up live; deploy, history, rollback", async ({ page }) => {
  await page.goto("/?pipeline=SWpipeline");
  await expect(page.getByTestId("node-Base64Decoder")).toBeVisible();
  await expect(page.getByTestId("card-Base64Decoder")).toBeVisible();
  await page.evaluate(() => ((window as unknown as { __noReload: boolean }).__noReload = true));
  await expect(page.getByTestId("update-Base64Decoder")).toHaveCount(0);

  // AC4: a node pinned to a tag shows an update badge when a newer tag is pushed (within ~15 s).
  // (Without a Ref a node follows its default branch, so it's always on the latest.)
  await page.getByTestId("node-Base64Decoder").click();
  await page.getByTestId("inspector-ref").selectOption("Base64Decoder/v0.4.2");
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

  // AC6: Deploy saves the change (the new Ref) and records a new deploy; an older one can be run again.
  await page.getByTestId("deploy").click();
  await page.getByTestId("deploy-confirm").click();
  await expect(page.getByTestId("deploy-outcome")).toContainText(/Deployed SWpipeline as 000\d-/);
  const rows = page.getByTestId("deploy-history").locator("tbody tr");
  expect(await rows.count()).toBeGreaterThanOrEqual(2);
  await expect(rows.first()).toContainText("current");
  const older = (await rows.nth(1).locator("td").first().textContent())!;
  page.once("dialog", (d) => void d.accept());
  await page.getByTestId(`rollback-${older}`).click();
  await expect(page.getByTestId("deploy-outcome")).toContainText(`back to ${older}`);
  await expect(rows.first()).toContainText(`rollback of ${older}`);
  await expect(page.getByTestId("deploy-chip")).toContainText("rolled back");

  expect(await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload)).toBe(true);
});
