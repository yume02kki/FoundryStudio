import { expect, test } from "@playwright/test";

// Demo mode generates one coherent record stream on every topic (there's no Kafka in the
// e2e setup; the real-broker path is covered by backend/tests/test_peek.py).
test("Live data shows each transformer's input next to its output", async ({ page }) => {
  await page.goto("/?pipeline=SWpipeline&source=deployed");
  await expect(page.getByTestId("node-InputSink")).toBeVisible();

  await page.getByTestId("tab-live").click();
  await page.getByTestId("feeds-start").click();

  // Defaults to the first transformer: raw.xml in, the generated internal topic out.
  const xml = page.getByTestId("transform-XmlToJson");
  await expect(xml).toContainText("raw.xml");
  await expect(xml).toContainText("SWpipeline.XmlToJson.out");
  await expect(xml.locator(".pair-transformed").first()).toBeVisible();
  await xml.locator(".pair-transformed .pair-line").first().click();
  await expect(xml.locator(".diff")).toContainText("XML → JSON");
  await expect(page.getByTestId("activity-XmlToJson")).toContainText("Flowing");

  // Clicking a node on the canvas switches to it. Base64Decoder decodes `data` and drops
  // records that aren't UTF-8 text.
  await page.getByTestId("node-Base64Decoder").click();
  const b64 = page.getByTestId("transform-Base64Decoder");
  await expect(b64).toContainText("packets.decoded");
  await expect(b64.locator(".pair-transformed .pair-changes").first()).toHaveText("data");
  await expect(b64.locator(".pair-dropped").first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("transform-stats-Base64Decoder")).toContainText(/[1-9]\d* dropped/);

  // The sinks show their own topic.
  await page.getByTestId("stage-OutputSink").click();
  await expect(page.getByTestId("feed-status-OutputSink")).toContainText("Flowing");

  await page.getByTestId("feeds-stop").click();
  await expect(page.getByTestId("activity-OutputSink")).toHaveCount(0);
});
