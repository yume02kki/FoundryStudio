import { expect, test } from "@playwright/test";

// Demo mode generates one coherent record stream on every topic (there's no Kafka in the
// e2e setup; the real-broker path is covered by backend/tests/test_peek.py).
test("Live data: the whole pipeline at a glance, then each step by clicking on the canvas", async ({ page }) => {
  await page.goto("/?pipeline=PacketPipeline");
  await expect(page.getByTestId("node-XmlToJson")).toBeVisible();

  // One toggle: the overview opens, the canvas comes alive.
  await page.getByTestId("live-toggle").click();
  await expect(page.getByTestId("live-overview")).toBeVisible();
  for (const stage of ["XmlToJson", "Decode", "Isp"]) {
    await expect(page.getByTestId(`overview-${stage}`)).toContainText("Running");
  }
  await expect(page.getByTestId("overview-dataset:Input")).toContainText("Flowing");
  await expect(page.getByTestId("flow-XmlToJson->dataset:ConvertedPackets")).toHaveCount(1);
  await expect(page.getByTestId("activity-XmlToJson")).toContainText(/\d+ in → \d+ out\/min/);
  await expect(page.getByTestId("activity-dataset:Output")).toContainText("Flowing");

  // Clicking a transform shows its input next to its output.
  await page.getByTestId("node-XmlToJson").click();
  const xml = page.getByTestId("transform-XmlToJson");
  await expect(xml).toContainText("Input");
  await expect(xml).toContainText("ConvertedPackets");
  await xml.locator(".pair-transformed .pair-line").first().click();
  await expect(xml.locator(".diff")).toContainText("XML → JSON");

  // Decode decodes `data` and drops records that aren't UTF-8 text.
  await page.getByTestId("node-Decode").click();
  const decode = page.getByTestId("transform-Decode");
  await expect(decode.locator(".pair-transformed .pair-changes").first()).toContainText("data");
  await expect(decode.locator(".pair-dropped").first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("activity-Decode")).toContainText("dropped");

  // Clicking a connection shows the dataset it carries, under its real topic; empty canvas goes back to the overview.
  await page.getByTestId("rf__edge-dataset:ConvertedPackets->Decode").click({ force: true });
  await expect(page.getByTestId("feed-ConvertedPackets")).toContainText("enrichment.packets");
  await expect(page.getByTestId("feed-status-ConvertedPackets")).toContainText("Flowing");
  await page.locator(".react-flow__pane").click({ position: { x: 30, y: 30 } });
  await expect(page.getByTestId("live-overview")).toBeVisible();

  await page.getByTestId("live-toggle").click();
  await expect(page.getByTestId("activity-dataset:Output")).toHaveCount(0);
  await expect(page.locator(".edge-flow")).toHaveCount(0);
});
