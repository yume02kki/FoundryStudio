import { describe, expect, it } from "vitest";
import type { Catalog, GraphNode } from "../types";
import { checkConnection, emits, expects, inputsOf, outputsOf, shortReason, type GraphLike } from "./rules";

const catalog: Catalog = {
  clusters: { core: { Brokers: "core:9092" } },
  schemas: { XmlPackets: "schemas/xml_packets.yaml", EncodedPackets: "schemas/encoded_packets.yaml", Packets: "schemas/packets.yaml" },
  datasets: {
    "raw.xml": { Cluster: "core", Schema: "XmlPackets" },
    encoded: { Cluster: "core", Schema: "EncodedPackets" },
    "packets.decoded": { Cluster: "core", Schema: "Packets" },
  },
};
const t = (id: string, IN: string, OUT: string): GraphNode => ({ id, kind: "transformer", transformer: { IN, OUT } });
const d = (name: string): GraphNode => ({ id: `dataset:${name}`, kind: "dataset", dataset: name });

const base = (): GraphLike => ({
  nodes: [t("XmlToJson", "XmlPackets", "EncodedPackets"), t("Base64Decoder", "EncodedPackets", "Packets"), d("raw.xml"), d("encoded"), d("packets.decoded")],
  edges: [{ source: "dataset:raw.xml", target: "XmlToJson" }],
});

describe("schemas", () => {
  it("come from IN/OUT for transformers and the catalog for datasets", () => {
    const g = base();
    expect(emits(g.nodes[0], catalog)).toBe("EncodedPackets");
    expect(expects(g.nodes[1], catalog)).toBe("EncodedPackets");
    expect(emits(g.nodes[2], catalog)).toBe("XmlPackets");
    expect(expects(d("nope"), catalog)).toBeUndefined();
  });
});

describe("checkConnection", () => {
  it("accepts matching schemas both ways", () => {
    const g = base();
    expect(checkConnection(g, catalog, "XmlToJson", "dataset:encoded")).toEqual({ ok: true });
    expect(checkConnection(g, catalog, "dataset:encoded", "Base64Decoder")).toEqual({ ok: true });
  });

  it("refuses type mismatches in deploy.py's words", () => {
    const g = base();
    const input = checkConnection(g, catalog, "dataset:raw.xml", "Base64Decoder");
    expect(input).toMatchObject({ ok: false, kind: "type" });
    expect(!input.ok && input.reason).toBe("Transformers.Base64Decoder.Inputs: raw.xml carries XmlPackets but Base64Decoder expects EncodedPackets");
    const output = checkConnection(g, catalog, "XmlToJson", "dataset:packets.decoded");
    expect(!output.ok && output.reason).toBe("Transformers.XmlToJson.Output: XmlToJson emits EncodedPackets but packets.decoded carries Packets");
    expect(shortReason(!output.ok ? output.reason : "")).toBe("XmlToJson emits EncodedPackets but packets.decoded carries Packets");
  });

  it("joins transformers only through datasets", () => {
    const g = base();
    expect(checkConnection(g, catalog, "XmlToJson", "Base64Decoder")).toMatchObject({ ok: false, kind: "kind" });
    expect(checkConnection(g, catalog, "dataset:raw.xml", "dataset:encoded")).toMatchObject({ ok: false, kind: "kind" });
    g.edges.push({ source: "XmlToJson", target: "dataset:encoded" });
    expect(checkConnection(g, catalog, "XmlToJson", "dataset:encoded")).toMatchObject({ ok: false, kind: "duplicate" });
  });

  it("lets a dataset feed several transformers and a transformer write several datasets", () => {
    const g = base();
    g.nodes.push(t("Copy", "XmlPackets", "EncodedPackets"), d("encoded.copy"));
    catalog.datasets["encoded.copy"] = { Cluster: "core", Schema: "EncodedPackets" };
    expect(checkConnection(g, catalog, "dataset:raw.xml", "Copy")).toEqual({ ok: true }); // raw.xml already feeds XmlToJson
    g.edges.push({ source: "XmlToJson", target: "dataset:encoded" });
    expect(checkConnection(g, catalog, "XmlToJson", "dataset:encoded.copy")).toEqual({ ok: true }); // a second output
    g.edges.push({ source: "XmlToJson", target: "dataset:encoded.copy" });
    expect(outputsOf(g, "XmlToJson")).toEqual(["encoded", "encoded.copy"]);
    expect(checkConnection(g, catalog, "Copy", "dataset:encoded")).toEqual({ ok: true }); // two writers, one dataset
  });

  it("refuses cycles and reading what it writes", () => {
    const g = base();
    g.nodes.push(t("Loop", "Packets", "Packets"));
    g.edges.push({ source: "dataset:packets.decoded", target: "Loop" });
    expect(checkConnection(g, catalog, "Loop", "dataset:packets.decoded")).toMatchObject({ ok: false, kind: "self" });
    g.edges.push({ source: "Base64Decoder", target: "dataset:packets.decoded" }, { source: "dataset:encoded", target: "Base64Decoder" });
    g.nodes.push(t("Back", "Packets", "EncodedPackets"));
    g.edges.push({ source: "dataset:packets.decoded", target: "Back" });
    expect(checkConnection(g, catalog, "Back", "dataset:encoded")).toMatchObject({ ok: false, kind: "cycle" });
    expect(inputsOf(g, "Base64Decoder")).toEqual(["encoded"]);
  });
});
