import { describe, expect, it } from "vitest";
import type { GraphNode } from "../types";
import { checkConnection, edgeTopic, emits, expects, shortReason, type GraphLike } from "./rules";

const source = (Ontology?: string): GraphNode => ({ id: "InputSink", kind: "source", sink: { Type: "Kafka", Ontology } });
const output = (Ontology?: string): GraphNode => ({ id: "OutputSink", kind: "output", sink: { Type: "Kafka", Ontology } });
const t = (id: string, IN: string, OUT: string): GraphNode => ({ id, kind: "transformer", transformer: { IN, OUT } });

function graph(edges: [string, string][] = []): GraphLike {
  return {
    nodes: [
      source("XmlPackets"),
      output("Packets"),
      t("XmlToJson", "XmlPackets", "EncodedPackets"),
      t("Base64Decoder", "EncodedPackets", "Packets"),
    ],
    edges: edges.map(([s, d]) => ({ source: s, target: d })),
  };
}

describe("ports", () => {
  it("InputSink emits its Ontology, OutputSink expects its Ontology", () => {
    expect(emits(source("XmlPackets"))).toBe("XmlPackets");
    expect(expects(source("XmlPackets"))).toBeUndefined();
    expect(expects(output("Packets"))).toBe("Packets");
    expect(emits(output("Packets"))).toBeUndefined();
    expect(emits(t("A", "X", "Y"))).toBe("Y");
    expect(expects(t("A", "X", "Y"))).toBe("X");
  });
});

describe("checkConnection", () => {
  it("accepts matching schemas along SWpipeline", () => {
    const g = graph();
    expect(checkConnection(g, "InputSink", "XmlToJson")).toEqual({ ok: true });
    expect(checkConnection(g, "XmlToJson", "Base64Decoder")).toEqual({ ok: true });
    expect(checkConnection(g, "Base64Decoder", "OutputSink")).toEqual({ ok: true });
  });

  it("refuses a type mismatch with deploy.py's wording", () => {
    const r = checkConnection(graph([["InputSink", "XmlToJson"]]), "XmlToJson", "OutputSink");
    expect(r).toEqual({
      ok: false,
      kind: "type",
      reason:
        "Relation 'XmlToJson -> OutputSink': type mismatch — XmlToJson emits EncodedPackets but OutputSink expects Packets",
    });
    if (!r.ok) expect(shortReason(r.reason)).toBe("XmlToJson emits EncodedPackets but OutputSink expects Packets");
  });

  it("refuses wiring into InputSink or out of OutputSink", () => {
    const g = graph();
    expect(checkConnection(g, "XmlToJson", "InputSink")).toMatchObject({ ok: false, kind: "direction" });
    expect(checkConnection(g, "OutputSink", "XmlToJson")).toMatchObject({
      ok: false,
      reason: "Relation 'OutputSink -> XmlToJson': OutputSink cannot emit data",
    });
  });

  it("refuses self-loops, duplicates and cycles", () => {
    const g = graph([
      ["InputSink", "XmlToJson"],
      ["XmlToJson", "Base64Decoder"],
    ]);
    g.nodes.push(t("Echo", "EncodedPackets", "EncodedPackets"));
    expect(checkConnection(g, "Echo", "Echo")).toMatchObject({ ok: false, kind: "self-loop" });
    expect(checkConnection(g, "XmlToJson", "Base64Decoder")).toMatchObject({ ok: false, kind: "duplicate" });
    g.edges.push({ source: "XmlToJson", target: "Echo" });
    expect(checkConnection(g, "Echo", "XmlToJson")).toMatchObject({ ok: false, kind: "type" });
    g.nodes.push(t("Back", "EncodedPackets", "XmlPackets"));
    g.edges.push({ source: "Echo", target: "Back" });
    expect(checkConnection(g, "Back", "XmlToJson")).toMatchObject({ ok: false, kind: "cycle" });
  });

  it("allows fan-out and fan-in between transformers", () => {
    const g = graph([
      ["InputSink", "XmlToJson"],
      ["XmlToJson", "Base64Decoder"],
    ]);
    g.nodes.push(t("Audit", "EncodedPackets", "Packets"));
    expect(checkConnection(g, "XmlToJson", "Audit")).toEqual({ ok: true });
    g.edges.push({ source: "XmlToJson", target: "Audit" }, { source: "Base64Decoder", target: "OutputSink" });
    expect(checkConnection(g, "Audit", "OutputSink")).toEqual({ ok: true });
  });

  it("refuses a transformer that would feed OutputSink and another transformer", () => {
    const g = graph([["Base64Decoder", "OutputSink"]]);
    g.nodes.push(t("Tee", "Packets", "Packets"));
    expect(checkConnection(g, "Base64Decoder", "Tee")).toMatchObject({ ok: false, kind: "fan-out" });
  });

  it("lets untyped nodes connect; deploy.py reports the missing field", () => {
    const g = graph();
    g.nodes[1] = output(undefined);
    expect(checkConnection(g, "XmlToJson", "OutputSink")).toEqual({ ok: true });
  });
});

describe("edgeTopic", () => {
  it("names internal datasets like deploy.py's endpoint_id", () => {
    const g = graph([
      ["InputSink", "XmlToJson"],
      ["XmlToJson", "Base64Decoder"],
      ["Base64Decoder", "OutputSink"],
    ]);
    g.nodes[0].sink!.Topic = "raw.xml";
    g.nodes[1].sink!.Topic = "packets.decoded";
    expect(edgeTopic("SWpipeline", g, "InputSink")).toEqual({ topic: "raw.xml", internal: false });
    expect(edgeTopic("SWpipeline", g, "XmlToJson")).toEqual({ topic: "SWpipeline.XmlToJson.out", internal: true });
    expect(edgeTopic("SWpipeline", g, "Base64Decoder")).toEqual({ topic: "packets.decoded", internal: false });
  });
});
