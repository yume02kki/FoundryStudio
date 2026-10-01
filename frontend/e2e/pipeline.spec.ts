import { expect, test } from "@playwright/test";
import { dropCard, dropDataset, handle, wire } from "./helpers";

const RAW = "dataset:raw.xml";
const MID = "dataset:SWpipeline.XmlToJson.out";
const OUT = "dataset:packets.decoded";

test("AC1: SWpipeline draws raw.xml -> XmlToJson -> SWpipeline.XmlToJson.out -> Base64Decoder -> packets.decoded", async ({ page }) => {
  await page.goto("/?pipeline=SWpipeline");

  for (const node of ["XmlToJson", "Base64Decoder", RAW, MID, OUT]) {
    await expect(page.getByTestId(`node-${node}`)).toBeVisible();
  }
  const schemas: [string, "in" | "out", string][] = [
    [RAW, "out", "XmlPackets"],
    ["XmlToJson", "in", "XmlPackets"],
    ["XmlToJson", "out", "EncodedPackets"],
    [MID, "in", "EncodedPackets"],
    ["Base64Decoder", "in", "EncodedPackets"],
    ["Base64Decoder", "out", "Packets"],
    [OUT, "in", "Packets"],
  ];
  for (const [node, port, schema] of schemas) {
    await expect(page.getByTestId(`port-${node}-${port}`)).toHaveAttribute("data-schema", schema);
  }
  await expect(page.getByTestId("port-XmlToJson-out")).toContainText("EncodedPackets");
  await expect(page.getByTestId("cluster-raw.xml")).toHaveText("upstream");
  await expect(page.getByTestId("schema-packets.decoded")).toHaveText("Packets");

  await expect(page.locator(".react-flow__edge")).toHaveCount(4);
  for (const id of [`${RAW}->XmlToJson`, `XmlToJson->${MID}`, `${MID}->Base64Decoder`, `Base64Decoder->${OUT}`]) {
    await expect(page.getByTestId(`rf__edge-${id}`)).toHaveCount(1);
  }
  await expect(page.getByTestId("inspector")).toContainText("Select a node or an edge");
  await expect(page.getByTestId("validation-status")).toContainText("valid");
});

test("AC3: wiring a dataset of the wrong schema is refused with deploy.py's message", async ({ page }) => {
  await page.goto("/?new=1");
  await expect(page.getByTestId("canvas")).toBeVisible();
  const box = (await page.getByTestId("canvas").boundingBox())!;

  await dropDataset(page, "raw.xml", box.width * 0.15, box.height / 2);
  await dropDataset(page, "packets.decoded", box.width * 0.75, box.height / 2);
  await dropCard(page, "XmlToJson", box.width * 0.4, box.height / 2 + 120);
  for (const node of [RAW, OUT, "XmlToJson"]) await expect(page.getByTestId(`node-${node}`)).toBeVisible();
  await expect(page.getByTestId("port-XmlToJson-in")).toHaveAttribute("data-schema", "XmlPackets");

  // raw.xml -> XmlToJson is accepted; the compatible port lights up while dragging.
  await wire(page, handle(page, RAW, "out"), handle(page, "XmlToJson", "in"), async () => {
    await expect(page.getByTestId("port-XmlToJson-in")).toHaveClass(/port-compatible/);
    await expect(page.getByTestId(`port-${OUT}-in`)).toHaveClass(/port-incompatible/);
  });
  await expect(page.getByTestId(`rf__edge-${RAW}->XmlToJson`)).toHaveCount(1);

  // XmlToJson -> packets.decoded is refused: tooltip while hovering, deploy.py's message on drop.
  await wire(page, handle(page, "XmlToJson", "out"), handle(page, OUT, "in"), async () => {
    await expect(page.getByTestId(`port-${OUT}-in`)).toHaveClass(/port-incompatible/);
    await expect(page.getByTestId("drag-tooltip")).toHaveText("XmlToJson emits EncodedPackets but packets.decoded carries Packets");
  });
  await expect(page.getByTestId("connection-refused")).toContainText(
    "Transformers.XmlToJson.Output: XmlToJson emits EncodedPackets but packets.decoded carries Packets",
  );
  await page.locator(".toast .icon-btn").first().click();
  await expect(page.getByTestId(`rf__edge-XmlToJson->${OUT}`)).toHaveCount(0);

  // Transformers only connect through a dataset.
  await dropCard(page, "Base64Decoder", box.width * 0.6, box.height / 2 - 150);
  await wire(page, handle(page, "XmlToJson", "out"), handle(page, "Base64Decoder", "in"));
  await expect(page.getByTestId("connection-refused").filter({ hasText: "transformers connect through a dataset" })).toHaveCount(1);
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);
});

test("clicking a connection shows its dataset's cluster; edits are saved to the shared catalog", async ({ page }) => {
  await page.goto("/?pipeline=SWpipeline");
  await expect(page.getByTestId("node-XmlToJson")).toBeVisible();
  // Let the canvas finish its fit-to-view animation, or a click can land beside the edge.
  await expect(page.getByTestId("validation-status")).toContainText("valid");
  await page.waitForTimeout(400);
  const inspector = page.getByTestId("inspector");

  await page.getByTestId(`rf__edge-${RAW}->XmlToJson`).click({ force: true });
  await expect(page.getByTestId("edge-topic")).toHaveValue("raw.xml");
  await expect(page.getByTestId("edge-group")).toHaveValue("SWpipeline.XmlToJson");
  await expect(page.getByTestId("edge-brokers")).toHaveValue("upstream-kafka:9092");
  await expect(page.getByTestId("edge-secretref")).toHaveValue("upstream-kafka-creds");

  await page.getByTestId(`rf__edge-XmlToJson->${MID}`).click({ force: true });
  await expect(page.getByTestId("edge-topic")).toHaveValue("SWpipeline.XmlToJson.out");
  await expect(inspector).toContainText("Cluster internal");
  await page.getByTestId("edge-brokers").fill("kafka-internal-2:9092");
  await expect(page.getByTestId("dirty")).toBeVisible();

  await page.getByTestId("save").click();
  await expect(page.getByTestId("saved")).toBeVisible();
  const catalog = await (await page.request.get("/api/catalog")).json();
  expect(catalog.clusters.internal.Brokers).toBe("kafka-internal-2:9092");
  // The manifest doesn't carry connection settings at all.
  const saved = await (await page.request.get("/api/pipelines/SWpipeline")).json();
  expect(saved.manifest).not.toContain("Brokers");

  // Put it back for the other tests.
  catalog.clusters.internal.Brokers = "kafka-internal:9092";
  expect((await page.request.put("/api/catalog", { data: { catalog } })).ok()).toBe(true);
});

test("a new dataset goes into the catalog and onto the canvas", async ({ page }) => {
  await page.goto("/?pipeline=SWpipeline");
  await page.getByTestId("tab-datasets").click();
  await page.getByTestId("add-dataset").click();
  await page.getByTestId("new-dataset-name").fill("packets.enriched");
  await page.getByTestId("new-dataset-cluster").selectOption("downstream");
  await page.getByTestId("new-dataset-schema").selectOption("Packets");
  await page.getByTestId("new-dataset-add").click();
  await expect(page.getByTestId("node-dataset:packets.enriched")).toBeVisible();
  await expect(page.getByTestId("dataset-card-packets.enriched")).toContainText("on downstream");
  await expect(page.getByTestId("dataset-cluster")).toHaveValue("downstream");
  await expect(page.getByTestId("dataset-fields")).toContainText("guid");
});

test("a dataset feeds several transformers; a transformer writes several datasets", async ({ page }) => {
  const catalog = await (await page.request.get("/api/catalog")).json();
  const original = structuredClone(catalog);
  catalog.datasets["encoded.copy"] = { Cluster: "internal", Schema: "EncodedPackets" };
  expect((await page.request.put("/api/catalog", { data: { catalog } })).ok()).toBe(true);
  try {
    await page.goto("/?pipeline=SWpipeline");
    await expect(page.getByTestId("validation-status")).toContainText("valid");
    const box = (await page.getByTestId("canvas").boundingBox())!;
    await dropDataset(page, "encoded.copy", box.width * 0.45, box.height - 60);
    await dropCard(page, "XmlToJson", box.width * 0.2, box.height - 80);
    await expect(page.getByTestId("node-XmlToJson2")).toBeVisible();

    // raw.xml already feeds XmlToJson; it can feed XmlToJson2 too (each gets its own consumer group).
    await wire(page, handle(page, RAW, "out"), handle(page, "XmlToJson2", "in"));
    await expect(page.getByTestId(`rf__edge-${RAW}->XmlToJson2`)).toHaveCount(1);
    // XmlToJson2 writes the dataset XmlToJson writes (two writers) ...
    await wire(page, handle(page, "XmlToJson2", "out"), handle(page, MID, "in"));
    // ... and XmlToJson gets a second output.
    await wire(page, handle(page, "XmlToJson", "out"), handle(page, "dataset:encoded.copy", "in"));
    await expect(page.locator(".react-flow__edge")).toHaveCount(7);
    await expect(page.getByTestId("validation-status")).toContainText("valid");

    await page.getByTestId("node-XmlToJson").click();
    await expect(page.getByTestId("transformer-writes")).toHaveText("SWpipeline.XmlToJson.out, encoded.copy");
    await page.getByTestId("deploy").click();
    await expect(page.locator(".manifest-preview")).toContainText("Output: [SWpipeline.XmlToJson.out, encoded.copy]");
    await expect(page.locator(".manifest-preview")).toContainText("  XmlToJson2:");
  } finally {
    expect((await page.request.put("/api/catalog", { data: { catalog: original } })).ok()).toBe(true);
  }
});
