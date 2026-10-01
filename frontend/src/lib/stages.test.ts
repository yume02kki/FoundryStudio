import { describe, expect, it } from "vitest";
import type { FeedMessage, GraphNode } from "../types";
import { diffRecords, pairRecords, recordId, stageFeeds, stages, writerKey, type GraphLike } from "./stages";

const t = (id: string): GraphNode => ({ id, kind: "transformer", transformer: {} });
const graph: GraphLike = {
  nodes: [
    { id: "InputSink", kind: "source" },
    { id: "OutputSink", kind: "output" },
    t("Base64Decoder"),
    t("XmlToJson"),
  ],
  edges: [
    { source: "InputSink", target: "XmlToJson" },
    { source: "XmlToJson", target: "Base64Decoder" },
    { source: "Base64Decoder", target: "OutputSink" },
  ],
};

const NOW = Date.parse("2026-10-01T12:00:00Z");
const msg = (value: string, secondsAgo: number, key: string | null = null): FeedMessage => ({
  partition: 0,
  offset: 0,
  timestamp: new Date(NOW - secondsAgo * 1000).toISOString(),
  key,
  value,
  encoding: "text",
  truncated: false,
  size: value.length,
  check: { ok: true, detail: "" },
  receivedAt: NOW,
});

describe("stages", () => {
  it("orders stages along the pipeline", () => {
    expect(stages(graph)).toEqual(["InputSink", "XmlToJson", "Base64Decoder", "OutputSink"]);
  });

  it("knows what each stage reads and writes (deploy.py's endpoint_id)", () => {
    expect(writerKey(graph, "XmlToJson")).toBe("XmlToJson"); // internal dataset
    expect(writerKey(graph, "Base64Decoder")).toBe("OutputSink"); // writes the sink's topic
    expect(stageFeeds(graph, "XmlToJson")).toEqual({ inputs: ["InputSink"], output: "XmlToJson" });
    expect(stageFeeds(graph, "Base64Decoder")).toEqual({ inputs: ["XmlToJson"], output: "OutputSink" });
    expect(stageFeeds(graph, "OutputSink")).toEqual({ inputs: [], output: "OutputSink" });
  });
});

describe("pairing", () => {
  it("identifies records by key, then by guid in JSON or XML", () => {
    expect(recordId(msg("{}", 0, "k1"))).toBe("k1");
    expect(recordId(msg('{"guid":"g2","data":"x"}', 0))).toBe("g2");
    expect(recordId(msg("<packet><guid>g3</guid></packet>", 0))).toBe("g3");
    expect(recordId(msg("plain", 0))).toBeNull();
  });

  it("pairs inputs with outputs and spots drops", () => {
    const inputs = [msg('{"guid":"a"}', 1), msg('{"guid":"b"}', 9), msg('{"guid":"c"}', 2), msg("no id", 3)];
    const outputs = [msg('{"guid":"a","data":"x"}', 0.5), msg('{"guid":"z"}', 4)];
    const pairs = pairRecords(inputs, outputs, NOW);
    const by = Object.fromEntries(pairs.map((p) => [p.id, p.status]));
    expect(by).toMatchObject({ a: "transformed", b: "dropped", c: "pending", z: "out-only", "in:3": "unkeyed" });
    expect(pairs[0].id).toBe("a"); // newest first
  });
});

describe("diffRecords", () => {
  it("shows what a transformer changed", () => {
    const d = diffRecords(
      "<packet><guid>g</guid><data>SGVsbG8=</data></packet>",
      '{"guid":"g","data":"Hello","extra":1}',
    )!;
    expect(d.format).toEqual(["XML", "JSON"]);
    expect(d.changed).toEqual([{ field: "data", before: "SGVsbG8=", after: "Hello" }]);
    expect(d.unchanged).toEqual(["guid"]);
    expect(d.added).toEqual(["extra"]);
    expect(diffRecords("plain", "{}")).toBeNull();
  });
});
