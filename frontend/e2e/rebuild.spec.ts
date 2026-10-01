import { expect, test } from "@playwright/test";
import { dropCard, dropDataset, handle, wire } from "./helpers";

const RAW = "dataset:raw.xml";
const MID = "dataset:SWpipeline.XmlToJson.out";
const OUT = "dataset:packets.decoded";

test("AC2: SWpipeline rebuilt from scratch is byte-identical, and deploys", async ({ page }) => {
  const saved = await (await page.request.get("/api/pipelines/SWpipeline")).json();

  await page.goto("/?new=1");
  await page.getByTestId("pipeline-name").fill("SWpipeline");
  const box = (await page.getByTestId("canvas").boundingBox())!;
  // Cards add transformers without a Ref (default branch), like the saved manifest.
  await dropDataset(page, "packets.decoded", box.width * 0.9, box.height / 2);
  await dropCard(page, "Base64Decoder", box.width * 0.62, box.height / 2 + 140);
  await dropDataset(page, "SWpipeline.XmlToJson.out", box.width * 0.5, box.height / 2 - 140);
  await dropCard(page, "XmlToJson", box.width * 0.3, box.height / 2 + 140);
  await dropDataset(page, "raw.xml", box.width * 0.08, box.height / 2);

  // Wire in an arbitrary order: the written manifest doesn't depend on it.
  await wire(page, handle(page, "Base64Decoder", "out"), handle(page, OUT, "in"));
  await wire(page, handle(page, MID, "out"), handle(page, "Base64Decoder", "in"));
  await wire(page, handle(page, RAW, "out"), handle(page, "XmlToJson", "in"));
  await wire(page, handle(page, "XmlToJson", "out"), handle(page, MID, "in"));
  await expect(page.locator(".react-flow__edge")).toHaveCount(4);
  await expect(page.getByTestId("validation-status")).toContainText("valid");

  await page.getByTestId("deploy").click();
  await expect(page.locator(".manifest-preview")).toHaveText(saved.manifest, { useInnerText: false });

  // Deploy saves first, then runs deploy.py (the demo target records the deploy without Docker).
  await page.getByTestId("deploy-confirm").click();
  await expect(page.getByTestId("deploy-outcome")).toContainText(/Deployed SWpipeline as 0001-|unchanged since deploy/);
  await expect(page.getByTestId("deploy-log")).toContainText("would run: docker compose -p foundry-swpipeline");
  await expect(page.getByTestId("deploy-history")).toContainText("0001-");
  await page.getByTestId("deploy-confirm").click();
  await expect(page.getByTestId("deploy-outcome")).toContainText("unchanged since deploy 0001-");
});
