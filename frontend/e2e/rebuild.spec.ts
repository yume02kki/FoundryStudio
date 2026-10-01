import { expect, test, type Page } from "@playwright/test";
import { dropCard, handle, wire } from "./helpers";

async function fillSink(page: Page, prefix: "source" | "output", values: Record<string, string>) {
  for (const [field, value] of Object.entries(values)) {
    const el = page.getByTestId(`${prefix}-${field}`);
    if ((await el.evaluate((e) => e.tagName)) === "SELECT") await el.selectOption(value);
    else await el.fill(value);
  }
}

test("AC2: SWpipeline rebuilt from scratch is byte-identical and deploys as already up to date", async ({ page }) => {
  const deployed = await (await page.request.get("/api/pipelines/SWpipeline?source=deployed")).json();

  await page.goto("/?new=1");
  await page.getByTestId("pipeline-name").fill("SWpipeline");

  const box = (await page.getByTestId("canvas").boundingBox())!;
  await page.getByTestId("card-version-XmlToJson").selectOption("XmlToJson/v0.4.2");
  await dropCard(page, "XmlToJson", box.width * 0.35, box.height / 2 + 120);
  await page.getByTestId("card-version-Base64Decoder").selectOption("Base64Decoder/v0.4.2");
  await dropCard(page, "Base64Decoder", box.width * 0.62, box.height / 2 + 120);

  await page.getByTestId("node-InputSink").click();
  await fillSink(page, "source", {
    topic: "raw.xml",
    ontology: "XmlPackets",
    brokers: "upstream-kafka:9092",
    protocol: "SASL_SSL",
    mechanism: "SCRAM-SHA-512",
    secretref: "upstream-kafka-creds",
    group: "swpipeline",
  });
  await page.getByTestId("node-OutputSink").click();
  await fillSink(page, "output", {
    topic: "packets.decoded",
    ontology: "Packets",
    brokers: "downstream-kafka:9092",
    protocol: "SASL_SSL",
    mechanism: "SCRAM-SHA-512",
    secretref: "downstream-kafka-creds",
  });

  // Wire in an arbitrary order: the written manifest doesn't depend on it.
  await wire(page, handle(page, "Base64Decoder", "out"), handle(page, "OutputSink", "in"));
  await wire(page, handle(page, "InputSink", "out"), handle(page, "XmlToJson", "in"));
  await wire(page, handle(page, "XmlToJson", "out"), handle(page, "Base64Decoder", "in"));
  await expect(page.locator(".react-flow__edge")).toHaveCount(3);
  await expect(page.getByTestId("validation-status")).toContainText("valid");

  await page.getByTestId("deploy").click();
  await expect(page.locator(".manifest-preview")).toHaveText(deployed.manifest, { useInnerText: false });
  await page.getByTestId("deploy-confirm").click();
  await expect(page.getByTestId("deploy-result")).toContainText("already up to date");
});
