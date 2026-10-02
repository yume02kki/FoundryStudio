import { describe, expect, it } from "vitest";
import type { GraphNode, TransformerInfo } from "../types";
import { checkConnection, emits, expects, inputsOf, outputsOf, shortReason, type GraphLike, type Transformers } from "./rules";

const info = (name: string, input: string, output: string, tagged?: [string, string]): TransformerInfo => {
  const branch = { ref: "abc", label: "main@abc", kind: "branch" as const, commit: "abc", committed_date: null, input, output, source: "transformer.yaml", warnings: [], web_url: "" };
  const tag = tagged && { ...branch, ref: "v1.0.0", label: "v1.0.0", kind: "tag" as const, commit: "def", input: tagged[0], output: tagged[1] };
  return {
    id: `foundry-enrichers/${name}:`, project: `foundry-enrichers/${name}`, path: "", name, description: "",
    repo: `https://gitlab.com/foundry-enrichers/${name}.git`, web_url: "", input, output, warnings: [],
    latest: tag ? "v1.0.0" : "abc", head: "abc", versions: tag ? [tag, branch] : [branch],
  };
};
const transformers: Transformers = Object.fromEntries(
  [info("XmlToJson", "XmlPackets", "Packets"), info("Decode", "Packets", "EnrichedPackets", ["XmlPackets", "Packets"])].map((i) => [i.id, i]),
);
const t = (id: string, Ref?: string): GraphNode => ({
  id, kind: "transformer", transformer: { Repo: `https://gitlab.com/foundry-enrichers/${id}.git`, ...(Ref ? { Ref } : {}) },
});
const d = (name: string, DataSchema: string): GraphNode => ({
  id: `dataset:${name}`, kind: "dataset", dataset: name, datasetSpec: { Type: "Kafka", Config: "kafka/prod", DataSchema, Topic: name.toLowerCase() },
});

const base = (): GraphLike => ({
  nodes: [t("XmlToJson"), t("Decode"), d("Input", "XmlPackets"), d("Converted", "Packets"), d("Output", "EnrichedPackets")],
  edges: [{ source: "dataset:Input", target: "XmlToJson" }],
});

describe("schemas", () => {
  it("come from transformer.yaml at the Ref for transforms and DataSchema for datasets", () => {
    const g = base();
    expect(emits(g.nodes[0], transformers)).toBe("Packets");
    expect(expects(g.nodes[1], transformers)).toBe("Packets");
    expect(expects(t("Decode", "v1.0.0"), transformers)).toBe("XmlPackets");
    expect(emits(g.nodes[2], transformers)).toBe("XmlPackets");
    expect(expects(t("Unknown"), transformers)).toBeUndefined();
  });
});

describe("checkConnection", () => {
  it("accepts matching schemas", () => {
    const g = base();
    expect(checkConnection(g, transformers, "XmlToJson", "dataset:Converted")).toEqual({ ok: true });
    expect(checkConnection(g, transformers, "dataset:Converted", "Decode")).toEqual({ ok: true });
  });

  it("refuses mismatched schemas in manifest.py's words", () => {
    const g = base();
    const out = checkConnection(g, transformers, "XmlToJson", "dataset:Output");
    expect(out).toMatchObject({ ok: false, kind: "type" });
    expect(!out.ok && out.reason).toBe("Transforms.XmlToJson.Out: XmlToJson writes Packets but Output carries EnrichedPackets");
    const into = checkConnection(g, transformers, "dataset:Input", "Decode");
    expect(!into.ok && shortReason(into.reason)).toBe("Input carries XmlPackets but Decode reads Packets");
  });

  it("allows one In and one Out per transform", () => {
    const g = base();
    g.nodes.push(d("Other", "XmlPackets"));
    expect(checkConnection(g, transformers, "dataset:Other", "XmlToJson")).toMatchObject({ ok: false, kind: "single" });
    g.edges.push({ source: "XmlToJson", target: "dataset:Converted" });
    g.nodes.push(d("Converted2", "Packets"));
    expect(checkConnection(g, transformers, "XmlToJson", "dataset:Converted2")).toMatchObject({ ok: false, kind: "single" });
  });

  it("refuses wrong kinds, duplicates, self loops and cycles", () => {
    const g = base();
    expect(checkConnection(g, transformers, "XmlToJson", "Decode")).toMatchObject({ ok: false, kind: "kind" });
    expect(checkConnection(g, transformers, "dataset:Input", "dataset:Output")).toMatchObject({ ok: false, kind: "kind" });
    expect(checkConnection(g, transformers, "dataset:Input", "XmlToJson")).toMatchObject({ ok: false, kind: "duplicate" });

    const loop: GraphLike = {
      nodes: [t("A"), t("B"), d("X", "Packets"), d("Y", "Packets")],
      edges: [
        { source: "dataset:X", target: "A" },
        { source: "A", target: "dataset:Y" },
        { source: "dataset:Y", target: "B" },
      ],
    };
    expect(checkConnection(loop, transformers, "B", "dataset:X")).toMatchObject({ ok: false, kind: "cycle" });
    const self: GraphLike = { nodes: [t("A"), d("X", "Packets")], edges: [{ source: "dataset:X", target: "A" }] };
    expect(checkConnection(self, transformers, "A", "dataset:X")).toMatchObject({ ok: false, kind: "self" });
  });
});

describe("wiring", () => {
  it("lists a transform's In and Out", () => {
    const g = base();
    g.edges.push({ source: "XmlToJson", target: "dataset:Converted" });
    expect(inputsOf(g, "XmlToJson")).toEqual(["Input"]);
    expect(outputsOf(g, "XmlToJson")).toEqual(["Converted"]);
    expect(outputsOf(g, "Decode")).toEqual([]);
  });
});
