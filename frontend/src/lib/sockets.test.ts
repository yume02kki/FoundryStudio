import { describe, expect, it } from "vitest";
import type { GraphNode, ProcessorInfo } from "../types";
import type { Processors } from "./rules";
import { inputSockets, moveSocket, ordered, outputSockets, wires } from "./sockets";

const info = (name: string, input: string, output: string): ProcessorInfo => {
  const v = { ref: "abc", label: "main@abc", kind: "branch" as const, commit: "abc", committed_date: null, input, output, source: "processor.yaml", warnings: [], web_url: "", runtime: "dotnet" as const };
  return { id: `x/${name}:`, project: `x/${name}`, path: "", name, description: "", repo: `https://gitlab.com/x/${name}.git`, web_url: "", input, output, warnings: [], latest: "abc", head: "abc", versions: [v], runtime: "dotnet" };
};
const processors: Processors = Object.fromEntries(
  [info("join", "Packets | DecodeEnrichment | IspEnrichment", "EnrichedPackets"), info("decode", "Packets", "DecodeEnrichment")].map((i) => [i.id, i]),
);
const p = (repo: string): GraphNode => ({ id: repo, kind: "processor", processor: { Repo: `https://gitlab.com/x/${repo}.git` } });
const d = (name: string, types: string | string[]): GraphNode => ({ id: `dataset:${name}`, kind: "dataset", dataset: name, datasetSpec: { AllowedTypes: Array.isArray(types) ? types : [types], Topic: name } });

describe("sockets", () => {
  it("one per schema where there are several, else a single one", () => {
    expect(inputSockets(p("join"), processors)).toEqual(["Packets", "DecodeEnrichment", "IspEnrichment"]);
    expect(inputSockets(p("decode"), processors)).toEqual([]);
    expect(outputSockets(d("Enrichments", ["DecodeEnrichment", "IspEnrichment"]))).toEqual(["DecodeEnrichment", "IspEnrichment"]);
    expect(outputSockets(d("Packets", "Packets"))).toEqual([]);
  });

  it("draw a connection as one wire per schema it carries", () => {
    expect(wires(d("Enrichments", ["DecodeEnrichment", "IspEnrichment"]), p("join"), processors)).toEqual([
      { sourceHandle: "out:DecodeEnrichment", targetHandle: "in:DecodeEnrichment", schema: "DecodeEnrichment" },
      { sourceHandle: "out:IspEnrichment", targetHandle: "in:IspEnrichment", schema: "IspEnrichment" },
    ]);
    expect(wires(d("Converted", "Packets"), p("join"), processors)).toEqual([{ sourceHandle: "out", targetHandle: "in:Packets", schema: "Packets" }]);
    expect(wires(p("decode"), d("Enrichments", ["DecodeEnrichment", "IspEnrichment"]), processors)).toEqual([
      { sourceHandle: "out", targetHandle: "in:DecodeEnrichment", schema: "DecodeEnrichment" },
    ]);
    expect(wires(d("Converted", "Packets"), p("decode"), processors)).toEqual([{ sourceHandle: "out", targetHandle: "in", schema: "Packets" }]);
  });
});

describe("socket order", () => {
  it("follows the saved order, unmentioned schemas last", () => {
    expect(ordered(["A", "B", "C"], ["C", "A"])).toEqual(["C", "A", "B"]);
    expect(ordered(["A", "B"], undefined)).toEqual(["A", "B"]);
  });

  it("a dragged socket takes the place of the one it's dropped on", () => {
    expect(moveSocket(["A", "B", "C"], "A", "C")).toEqual(["B", "C", "A"]);
    expect(moveSocket(["A", "B", "C"], "C", "A")).toEqual(["C", "A", "B"]);
    expect(moveSocket(["A", "B"], "X", "A")).toEqual(["A", "B"]);
  });
});
