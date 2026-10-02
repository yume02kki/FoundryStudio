import { expect, test } from "@playwright/test";
import { dropCard, dropDataset, handle, wire } from "./helpers";

const IN = "dataset:Input";
const MID = "dataset:ConvertedPackets";
const OUT = "dataset:Output";

test("PacketPipeline rebuilt from scratch is byte-identical", async ({ page }) => {
  const original = await (await page.request.get("/api/pipelines/PacketPipeline")).json();

  await page.goto("/?new=1");
  await page.getByTestId("pipeline-name").fill("EnrichmentPipeline");
  const box = (await page.getByTestId("canvas").boundingBox())!;
  // Cards add transforms without a Ref (default branch), like the saved manifest.
  await dropDataset(page, "PacketPipeline", "Output", box.width * 0.9, box.height / 2);
  await dropCard(page, "Isp", box.width * 0.68, box.height / 2 + 140);
  await dropCard(page, "Decode", box.width * 0.68, box.height / 2 - 140);
  await dropDataset(page, "PacketPipeline", "ConvertedPackets", box.width * 0.48, box.height / 2);
  await dropCard(page, "XmlToJson", box.width * 0.28, box.height / 2 + 140);
  await dropDataset(page, "PacketPipeline", "Input", box.width * 0.08, box.height / 2);

  // Wire in an arbitrary order: the written manifest doesn't depend on it.
  await wire(page, handle(page, "Isp", "out"), handle(page, OUT, "in"));
  await wire(page, handle(page, MID, "out"), handle(page, "Decode", "in"));
  await wire(page, handle(page, IN, "out"), handle(page, "XmlToJson", "in"));
  await wire(page, handle(page, "Decode", "out"), handle(page, OUT, "in"));
  await wire(page, handle(page, MID, "out"), handle(page, "Isp", "in"));
  await wire(page, handle(page, "XmlToJson", "out"), handle(page, MID, "in"));
  await expect(page.locator(".react-flow__edge")).toHaveCount(6);
  await expect(page.getByTestId("validation-status")).toContainText("valid");

  await page.getByTestId("save").click();
  await expect(page.getByTestId("saved")).toBeVisible();
  const rebuilt = await (await page.request.get("/api/pipelines/EnrichmentPipeline")).json();
  expect(rebuilt.manifest).toBe(original.manifest);
});
