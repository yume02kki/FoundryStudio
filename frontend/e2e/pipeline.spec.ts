import { expect, test } from "@playwright/test";
import { dropCard, handle, wire } from "./helpers";

const MISMATCH =
  "Relation 'XmlToJson -> OutputSink': type mismatch — XmlToJson emits EncodedPackets but OutputSink expects Packets";

test("AC1: loading SWpipeline draws InputSink -> XmlToJson -> Base64Decoder -> OutputSink with typed ports", async ({
  page,
}) => {
  await page.goto("/?pipeline=SWpipeline&source=deployed");

  for (const node of ["InputSink", "XmlToJson", "Base64Decoder", "OutputSink"]) {
    await expect(page.getByTestId(`node-${node}`)).toBeVisible();
  }
  const schemas: [string, "in" | "out", string][] = [
    ["InputSink", "out", "XmlPackets"],
    ["XmlToJson", "in", "XmlPackets"],
    ["XmlToJson", "out", "EncodedPackets"],
    ["Base64Decoder", "in", "EncodedPackets"],
    ["Base64Decoder", "out", "Packets"],
    ["OutputSink", "in", "Packets"],
  ];
  for (const [node, port, schema] of schemas) {
    const p = page.getByTestId(`port-${node}-${port}`);
    await expect(p).toHaveAttribute("data-schema", schema);
    await expect(p).toContainText(schema);
  }
  await expect(page.getByTestId("port-InputSink-in")).toHaveCount(0);
  await expect(page.getByTestId("port-OutputSink-out")).toHaveCount(0);

  const edges = page.locator(".react-flow__edge");
  await expect(edges).toHaveCount(3);
  for (const id of ["InputSink->XmlToJson", "XmlToJson->Base64Decoder", "Base64Decoder->OutputSink"]) {
    await expect(page.getByTestId(`rf__edge-${id}`)).toHaveCount(1);
  }
  // No topic labels on edges, and no pipeline settings panel.
  await expect(page.locator(".edge-label")).toHaveCount(0);
  await expect(page.getByTestId("inspector")).toContainText("Select a node or an edge");

  await expect(page.getByTestId("validation-status")).toContainText("valid");
});

test("AC3: wiring InputSink -> XmlToJson -> OutputSink is refused with deploy.py's message", async ({ page }) => {
  await page.goto("/?new=1");
  await expect(page.getByTestId("node-InputSink")).toBeVisible();

  // Fill in the sinks' ontologies.
  await page.getByTestId("node-InputSink").click();
  await page.getByTestId("source-ontology").selectOption("XmlPackets");
  await page.getByTestId("node-OutputSink").click();
  await page.getByTestId("output-ontology").selectOption("Packets");
  await expect(page.getByTestId("port-OutputSink-in")).toHaveAttribute("data-schema", "Packets");

  // Drag the XmlToJson card from the asset browser onto the canvas.
  const box = (await page.getByTestId("canvas").boundingBox())!;
  await dropCard(page, "XmlToJson", box.width / 2, box.height / 2 + 120);
  await expect(page.getByTestId("node-XmlToJson")).toBeVisible();
  await expect(page.getByTestId("port-XmlToJson-in")).toHaveAttribute("data-schema", "XmlPackets");
  await expect(page.getByTestId("port-XmlToJson-out")).toHaveAttribute("data-schema", "EncodedPackets");

  // InputSink -> XmlToJson is accepted; the compatible port lights up while dragging.
  await wire(page, handle(page, "InputSink", "out"), handle(page, "XmlToJson", "in"), async () => {
    await expect(page.getByTestId("port-XmlToJson-in")).toHaveClass(/port-compatible/);
    await expect(page.getByTestId("port-OutputSink-in")).toHaveClass(/port-incompatible/);
  });
  await expect(page.getByTestId("rf__edge-InputSink->XmlToJson")).toHaveCount(1);

  // XmlToJson -> OutputSink is refused: tooltip while hovering, deploy.py's message on drop.
  await wire(page, handle(page, "XmlToJson", "out"), handle(page, "OutputSink", "in"), async () => {
    await expect(page.getByTestId("port-OutputSink-in")).toHaveClass(/port-incompatible/);
    await expect(page.getByTestId("drag-tooltip")).toHaveText(
      "XmlToJson emits EncodedPackets but OutputSink expects Packets",
    );
  });
  await expect(page.getByTestId("connection-refused")).toContainText(MISMATCH);
  await expect(page.getByTestId("rf__edge-XmlToJson->OutputSink")).toHaveCount(0);
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);
});

test("clicking a connection shows and edits its Kafka connection settings", async ({ page }) => {
  await page.goto("/?pipeline=SWpipeline&source=deployed");
  await expect(page.getByTestId("node-XmlToJson")).toBeVisible();
  // Let the canvas finish its fit-to-view animation, or a click can land beside the edge.
  await expect(page.getByTestId("validation-status")).toContainText("valid");
  await page.waitForTimeout(400);
  const inspector = page.getByTestId("inspector");

  // Source -> transformer: the InputSink's own settings.
  await page.getByTestId("rf__edge-InputSink->XmlToJson").click({ force: true });
  await expect(page.getByTestId("edge-topic")).toHaveValue("raw.xml");
  await expect(page.getByTestId("edge-brokers")).toHaveValue("upstream-kafka:9092");
  await expect(page.getByTestId("edge-secretref")).toHaveValue("upstream-kafka-creds");

  // Transformer -> transformer: the shared internal-topic settings.
  await page.getByTestId("rf__edge-XmlToJson->Base64Decoder").click({ force: true });
  await expect(page.getByTestId("edge-topic")).toHaveValue("SWpipeline.XmlToJson.out");
  await expect(inspector).toContainText("shared by all internal topics");
  await expect(page.getByTestId("edge-brokers")).toHaveValue("kafka-internal:9092");
  await page.getByTestId("edge-brokers").fill("kafka-internal-2:9092");

  // Transformer -> Output: the OutputSink's settings.
  await page.getByTestId("rf__edge-Base64Decoder->OutputSink").click({ force: true });
  await expect(page.getByTestId("edge-brokers")).toHaveValue("downstream-kafka:9092");

  // The edit lands in the manifest (Defaults.InternalDatasets.ConnectionSettings).
  await expect(page.getByTestId("validation-status")).toContainText("valid");
  await page.getByTestId("deploy").click();
  await expect(page.locator(".manifest-preview")).toContainText("Brokers: kafka-internal-2:9092");
  await expect(page.locator(".manifest-preview")).toContainText("Brokers: upstream-kafka:9092");
});
