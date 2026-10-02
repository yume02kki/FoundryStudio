import { expect, test } from "@playwright/test";
import { dropCard, dropDataset, handle, wire } from "./helpers";

const IN = "dataset:Input";
const MID = "dataset:ConvertedPackets";
const OUT = "dataset:Output";

test("PacketPipeline draws Input -> XmlToJson -> ConvertedPackets -> Decode, Isp -> Output", async ({ page }) => {
  await page.goto("/?pipeline=PacketPipeline");

  for (const node of ["XmlToJson", "Decode", "Isp", IN, MID, OUT]) {
    await expect(page.getByTestId(`node-${node}`)).toBeVisible();
  }
  const schemas: [string, "in" | "out", string][] = [
    [IN, "out", "XmlPackets"],
    ["XmlToJson", "in", "XmlPackets"],
    ["XmlToJson", "out", "Packets"],
    [MID, "in", "Packets"],
    ["Decode", "in", "Packets"],
    ["Isp", "out", "EnrichedPackets"],
    [OUT, "in", "EnrichedPackets"],
  ];
  for (const [node, port, schema] of schemas) {
    await expect(page.getByTestId(`port-${node}-${port}`)).toHaveAttribute("data-schema", schema);
  }
  await expect(page.getByTestId("profile-Input")).toHaveText("kafka/prod");
  await expect(page.getByTestId("topic-Output")).toHaveText("packets.enriched");

  await expect(page.locator(".react-flow__edge")).toHaveCount(6);
  for (const id of [`${IN}->XmlToJson`, `XmlToJson->${MID}`, `${MID}->Decode`, `${MID}->Isp`, `Decode->${OUT}`, `Isp->${OUT}`]) {
    await expect(page.getByTestId(`rf__edge-${id}`)).toHaveCount(1);
  }
  await expect(page.getByTestId("inspector")).toContainText("Select a node or an edge");
  await expect(page.getByTestId("validation-status")).toContainText("manifest.py: valid");
});

test("wiring a dataset of the wrong schema is refused with manifest.py's message; one In per transform", async ({ page }) => {
  await page.goto("/?new=1");
  await expect(page.getByTestId("canvas")).toBeVisible();
  const box = (await page.getByTestId("canvas").boundingBox())!;

  await dropDataset(page, "PacketPipeline", "Input", box.width * 0.15, box.height / 2);
  await dropDataset(page, "PacketPipeline", "Output", box.width * 0.75, box.height / 2);
  await dropCard(page, "XmlToJson", box.width * 0.4, box.height / 2 + 120);
  for (const node of [IN, OUT, "XmlToJson"]) await expect(page.getByTestId(`node-${node}`)).toBeVisible();
  await expect(page.getByTestId("port-XmlToJson-in")).toHaveAttribute("data-schema", "XmlPackets");

  // Input -> XmlToJson is accepted; the compatible port lights up while dragging.
  await wire(page, handle(page, IN, "out"), handle(page, "XmlToJson", "in"), async () => {
    await expect(page.getByTestId("port-XmlToJson-in")).toHaveClass(/port-compatible/);
    await expect(page.getByTestId(`port-${OUT}-in`)).toHaveClass(/port-incompatible/);
  });
  await expect(page.getByTestId(`rf__edge-${IN}->XmlToJson`)).toHaveCount(1);

  // XmlToJson -> Output is refused: tooltip while hovering, manifest.py's message on drop.
  await wire(page, handle(page, "XmlToJson", "out"), handle(page, OUT, "in"), async () => {
    await expect(page.getByTestId(`port-${OUT}-in`)).toHaveClass(/port-incompatible/);
    await expect(page.getByTestId("drag-tooltip")).toHaveText("XmlToJson writes Packets but Output carries EnrichedPackets");
  });
  await expect(page.getByTestId("connection-refused")).toContainText(
    "Transforms.XmlToJson.Out: XmlToJson writes Packets but Output carries EnrichedPackets",
  );
  await page.locator(".toast .icon-btn").first().click();
  await expect(page.getByTestId(`rf__edge-XmlToJson->${OUT}`)).toHaveCount(0);

  // A transform reads one dataset: a second XmlPackets dataset can't feed XmlToJson too.
  await page.getByTestId("tab-datasets").click();
  await page.getByTestId("add-dataset").click();
  await page.getByTestId("new-dataset-name").fill("Replay");
  await page.getByTestId("new-dataset-topic").fill("raw.xml.replay");
  await page.getByTestId("new-dataset-schema").selectOption("XmlPackets");
  await page.getByTestId("new-dataset-add").click();
  await page.getByTestId("tab-transformers").click();
  await expect(page.getByTestId("node-dataset:Replay")).toBeVisible();
  await page.getByTestId("node-dataset:Replay").dragTo(page.getByTestId("canvas"), { targetPosition: { x: box.width * 0.15, y: box.height / 2 + 160 } });
  await wire(page, handle(page, "dataset:Replay", "out"), handle(page, "XmlToJson", "in"));
  await expect(page.getByTestId("connection-refused").filter({ hasText: "XmlToJson already reads Input; a transform reads one dataset" })).toHaveCount(1);
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);
  await dropCard(page, "Isp", box.width * 0.55, box.height / 2 - 150);

  // Transforms only connect through a dataset.
  await wire(page, handle(page, "XmlToJson", "out"), handle(page, "Isp", "in"));
  await expect(page.getByTestId("connection-refused").filter({ hasText: "transforms connect through a dataset" })).toHaveCount(1);
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);
});

test("a connection shows its topic, consumer group and profile; dataset edits are saved to the manifest", async ({ page }) => {
  await page.goto("/?pipeline=PacketPipeline");
  await expect(page.getByTestId("node-XmlToJson")).toBeVisible();
  // Let the canvas finish its fit-to-view animation, or a click can land beside the edge.
  await expect(page.getByTestId("validation-status")).toContainText("valid");
  await page.waitForTimeout(400);

  await page.getByTestId(`rf__edge-${IN}->XmlToJson`).click({ force: true });
  await expect(page.getByTestId("edge-topic")).toHaveValue("raw.xml");
  await expect(page.getByTestId("edge-group")).toHaveValue("EnrichmentPipeline.XmlToJson");
  await expect(page.getByTestId("profile-settings")).toContainText("kafka-internal:9092");

  await page.getByTestId(`node-${OUT}`).click();
  await page.getByTestId("dataset-topic").fill("packets.enriched.v2");
  await page.getByTestId("dataset-profile").selectOption("kafka/load");
  await expect(page.getByTestId("profile-settings")).toContainText("kafka-load:9092");
  await expect(page.getByTestId("dirty")).toBeVisible();

  await page.getByTestId("save").click();
  await expect(page.getByTestId("saved")).toBeVisible();
  const saved = await (await page.request.get("/api/pipelines/PacketPipeline")).json();
  expect(saved.manifest).toContain("    Config: kafka/load\n    DataSchema: EnrichedPackets\n    Topic: packets.enriched.v2\n");
  expect(saved.manifest).not.toContain("Brokers"); // profiles stay in the configs repo

  // Put it back for the other tests.
  await page.getByTestId("dataset-topic").fill("packets.enriched");
  await page.getByTestId("dataset-profile").selectOption("kafka/prod");
  await page.getByTestId("save").click();
  await expect(page.getByTestId("saved").last()).toBeVisible();
});

test("a new pipeline with a new dataset is saved to its own folder", async ({ page }) => {
  await page.goto("/?new=1");
  await page.getByTestId("pipeline-name").fill("Audit");
  await page.getByTestId("tab-datasets").click();
  await page.getByTestId("add-dataset").click();
  await page.getByTestId("new-dataset-name").fill("Audit");
  await page.getByTestId("new-dataset-topic").fill("packets.audit");
  await page.getByTestId("new-dataset-profile").selectOption("kafka/load");
  await page.getByTestId("new-dataset-schema").selectOption("Packets");
  await page.getByTestId("new-dataset-add").click();
  await expect(page.getByTestId("node-dataset:Audit")).toBeVisible();
  await expect(page.getByTestId("dataset-card-Audit")).toContainText("packets.audit");

  await page.getByTestId("node-dataset:Audit").click();
  await expect(page.getByTestId("dataset-schema")).toHaveValue("Packets");
  await expect(page.getByTestId("dataset-fields")).toContainText("guid");

  await page.getByTestId("save").click();
  await expect(page.getByTestId("saved")).toBeVisible();
  await expect(page).toHaveURL(/pipeline=Audit/);
  const saved = await (await page.request.get("/api/pipelines/Audit")).json();
  expect(saved.manifest).toContain("Name: Audit\n");
  expect(saved.manifest).toContain("DataSets:\n  Audit:\n    Type: Kafka\n    Config: kafka/load\n    DataSchema: Packets\n    Topic: packets.audit\n");
});
