import { expect, test } from "@playwright/test";

// Demo mode generates one coherent record stream on every topic (there's no Kafka in the
// e2e setup; the real-broker path is covered by backend/tests/test_peek.py).
test("Live data: the whole pipeline at a glance, then each step by clicking on the canvas", async ({ page }) => {
  await page.goto("/?pipeline=SWpipeline");
  await expect(page.getByTestId("node-XmlToJson")).toBeVisible();

  // One toggle: the overview opens, the canvas comes alive.
  await page.getByTestId("live-toggle").click();
  await expect(page.getByTestId("live-overview")).toBeVisible();
  for (const stage of ["XmlToJson", "Base64Decoder"]) {
    await expect(page.getByTestId(`overview-${stage}`)).toContainText("Running");
  }
  await expect(page.getByTestId("overview-dataset:raw.xml")).toContainText("Flowing");
  await expect(page.getByTestId("flow-XmlToJson->dataset:SWpipeline.XmlToJson.out")).toHaveCount(1);
  await expect(page.getByTestId("activity-XmlToJson")).toContainText(/\d+ in → \d+ out\/min/);
  await expect(page.getByTestId("activity-dataset:packets.decoded")).toContainText("Flowing");

  // Clicking a transformer shows its input next to its output.
  await page.getByTestId("node-XmlToJson").click();
  const xml = page.getByTestId("transform-XmlToJson");
  await expect(xml).toContainText("raw.xml");
  await expect(xml).toContainText("SWpipeline.XmlToJson.out");
  await xml.locator(".pair-transformed .pair-line").first().click();
  await expect(xml.locator(".diff")).toContainText("XML → JSON");

  // Base64Decoder decodes `data` and drops records that aren't UTF-8 text.
  await page.getByTestId("node-Base64Decoder").click();
  const b64 = page.getByTestId("transform-Base64Decoder");
  await expect(b64.locator(".pair-transformed .pair-changes").first()).toHaveText("data");
  await expect(b64.locator(".pair-dropped").first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("activity-Base64Decoder")).toContainText("dropped");

  // Clicking a connection shows the dataset it carries; empty canvas goes back to the overview.
  await page.getByTestId("rf__edge-dataset:SWpipeline.XmlToJson.out->Base64Decoder").click({ force: true });
  await expect(page.getByTestId("feed-SWpipeline.XmlToJson.out")).toContainText("SWpipeline.XmlToJson.out");
  await expect(page.getByTestId("feed-status-SWpipeline.XmlToJson.out")).toContainText("Flowing");
  await page.locator(".react-flow__pane").click({ position: { x: 30, y: 30 } });
  await expect(page.getByTestId("live-overview")).toBeVisible();

  await page.getByTestId("live-toggle").click();
  await expect(page.getByTestId("activity-dataset:packets.decoded")).toHaveCount(0);
  await expect(page.locator(".edge-flow")).toHaveCount(0);
});
