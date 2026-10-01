import { expect, test } from "@playwright/test";

// Demo mode generates sample traffic for the sink topics (there's no Kafka in the e2e setup;
// the real-broker path is covered by backend/tests/test_peek.py).
test("Live data shows messages flowing on the Source and Output topics", async ({ page }) => {
  await page.goto("/?pipeline=SWpipeline&source=deployed");
  await expect(page.getByTestId("node-InputSink")).toBeVisible();

  await page.getByTestId("tab-live").click();
  await page.getByTestId("feeds-start").click();

  for (const sink of ["InputSink", "OutputSink"]) {
    await expect(page.getByTestId(`feed-status-${sink}`)).toContainText("Flowing");
    await expect(page.getByTestId(`feed-${sink}`).locator(".msg-check.good").first()).toBeVisible();
    await expect(page.getByTestId(`activity-${sink}`)).toContainText("Flowing");
  }
  await expect(page.getByTestId("feed-InputSink")).toContainText("raw.xml");
  await expect(page.getByTestId("feed-OutputSink")).toContainText("packets.decoded");

  // Expanding a message shows its schema check and the payload.
  await page.getByTestId("feed-OutputSink").locator(".msg-line").first().click();
  await expect(page.getByTestId("feed-OutputSink").locator(".msg-check-detail")).toHaveText("matches Packets");

  await page.getByTestId("feeds-stop").click();
  await expect(page.getByTestId("activity-InputSink")).toHaveCount(0);
});
