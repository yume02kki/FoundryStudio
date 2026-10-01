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
  // Only the transformer-to-transformer edge carries a generated (internal) topic label.
  await expect(page.getByTestId("topic-XmlToJson->Base64Decoder")).toHaveText("SWpipeline.XmlToJson.out");
  await expect(page.locator(".edge-label")).toHaveCount(1);

  await expect(page.getByTestId("validation-status")).toHaveText(/^✓\s*Valid/);
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
