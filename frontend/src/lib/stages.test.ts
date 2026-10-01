import { describe, expect, it } from "vitest";
import type { FeedMessage, GraphNode } from "../types";
import type { FeedState } from "../types";
import { diffRecords, edgeDataset, liveKeys, pairRecords, recordId, stageFeeds, stageStats, stages, type GraphLike } from "./stages";

const t = (id: string): GraphNode => ({ id, kind: "transformer", transformer: {} });
const d = (name: string): GraphNode => ({ id: `dataset:${name}`, kind: "dataset", dataset: name });
const graph: GraphLike = {
  nodes: [d("packets.decoded"), t("Base64Decoder"), d("raw.xml"), t("XmlToJson"), d("encoded")],
  edges: [
    { source: "dataset:raw.xml", target: "XmlToJson" },
    { source: "XmlToJson", target: "dataset:encoded" },
    { source: "dataset:encoded", target: "Base64Decoder" },
    { source: "Base64Decoder", target: "dataset:packets.decoded" },
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
  it("orders datasets and transformers along the pipeline", () => {
    expect(stages(graph)).toEqual([
      "dataset:raw.xml", "XmlToJson", "dataset:encoded", "Base64Decoder", "dataset:packets.decoded",
    ]);
  });

  it("knows what each stage reads and writes", () => {
    expect(stageFeeds(graph, "XmlToJson")).toEqual({ inputs: ["raw.xml"], outputs: ["encoded"] });
    expect(stageFeeds(graph, "Base64Decoder")).toEqual({ inputs: ["encoded"], outputs: ["packets.decoded"] });
    expect(stageFeeds(graph, "dataset:raw.xml")).toEqual({ inputs: [], outputs: ["raw.xml"] });
    expect(edgeDataset("XmlToJson", "dataset:encoded")).toBe("encoded");
    expect(edgeDataset("dataset:raw.xml", "XmlToJson")).toBe("raw.xml");
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

describe("live overview", () => {
  const feed = (messages: FeedMessage[]): FeedState => ({ state: "live", messages, count: messages.length });
  it("watches one feed per dataset", () => {
    expect(liveKeys(graph)).toEqual(["raw.xml", "encoded", "packets.decoded"]);
  });

  it("summarises a transformer's throughput and drops", () => {
    const feeds = {
      encoded: feed([msg('{"guid":"a"}', 2), msg('{"guid":"b"}', 20), msg('{"guid":"c"}', 30)]),
      "packets.decoded": feed([msg('{"guid":"a"}', 1), msg('{"guid":"c"}', 29)]),
    };
    const s = stageStats(graph, "Base64Decoder", feeds, NOW);
    expect(s).toMatchObject({ inRate: 3, outRate: 2, transformed: 2, dropped: 1, tone: "warning", label: "3 in → 2 out/min" });
    expect(stageStats(graph, "dataset:packets.decoded", feeds, NOW)).toMatchObject({ inRate: 2, tone: "success" });
  });

  it("flags a transformer that receives but produces nothing", () => {
    const feeds = { encoded: feed([msg('{"guid":"a"}', 2)]), "packets.decoded": feed([]) };
    expect(stageStats(graph, "Base64Decoder", feeds, NOW).tone).toBe("danger");
    expect(stageStats(graph, "Base64Decoder", {}, NOW).label).toBe("Off");
  });
});
