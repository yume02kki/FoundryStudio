// Runs last (files run alphabetically on one worker): it pushes tags and commits to the demo
// repos, which would change what the other tests render.
import { expect, test } from "@playwright/test";
import { demo } from "./helpers";

// Polling mode (the default 10 s interval): no webhooks, no reloads.
test("a new tag and a new processor show up live; the picked version is saved as the Ref", async ({ page }) => {
  await page.goto("/?pipeline=PacketPipeline");
  await expect(page.getByTestId("node-Decode")).toBeVisible();
  await expect(page.getByTestId("card-Decode")).toBeVisible();
  await page.evaluate(() => ((window as unknown as { __noReload: boolean }).__noReload = true));
  await expect(page.getByTestId("update-Decode")).toHaveCount(0);

  // A node pinned to a tag shows an update badge when a newer tag is pushed (within ~15 s).
  // (Without a Ref a node follows its default branch, so it's always on the latest.)
  await page.getByTestId("node-Decode").click();
  await page.getByTestId("inspector-ref").selectOption("v1.0.0");
  demo("tag", "decodingprocessor", "v1.1.0");
  await expect(page.getByTestId("update-Decode")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("update-Decode").click();
  await page.getByTestId("version-picker").getByRole("button", { name: /v1\.1\.0/ }).click();
  await expect(page.getByTestId("node-Decode")).toContainText("v1.1.0");
  await expect(page.getByTestId("update-Decode")).toHaveCount(0);

  // A new repo with a processor.yaml appears as a card.
  demo("add", "Deduplicate", "Packets", "Packets", "Drops repeated guids");
  await expect(page.getByTestId("card-Deduplicate")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("card-Deduplicate")).toContainText("Packets");

  // Save writes the Ref.
  await page.getByTestId("save").click();
  await expect(page.getByTestId("saved")).toBeVisible();
  const saved = await (await page.request.get("/api/pipelines/PacketPipeline")).json();
  expect(saved.manifest).toContain("    Repo: https://gitlab.com/foundry-platform/operators/decodingprocessor.git\n    Ref: v1.1.0\n");

  expect(await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload)).toBe(true);
});
