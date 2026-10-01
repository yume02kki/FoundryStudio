import { describe, expect, it } from "vitest";
import type { FeedMessage, FeedState } from "../types";
import { ago, feedHealth } from "./feedHealth";

const NOW = Date.parse("2026-10-01T12:00:00Z");
const msg = (secondsAgo: number, ok: boolean | null = true): FeedMessage => ({
  partition: 0,
  offset: 1,
  timestamp: new Date(NOW - secondsAgo * 1000).toISOString(),
  key: null,
  value: "{}",
  encoding: "text",
  truncated: false,
  size: 2,
  check: { ok, detail: "" },
  receivedAt: NOW,
});
const feed = (state: FeedState["state"], messages: FeedMessage[] = [], message?: string): FeedState => ({
  state,
  messages,
  count: messages.length,
  message,
});

describe("feedHealth", () => {
  it("is flowing with messages produced in the last minute", () => {
    const h = feedHealth(feed("live", [msg(5), msg(30), msg(300)]), NOW);
    expect(h).toMatchObject({ tone: "success", label: "Flowing · 2/min", detail: "last message 5s ago", mismatches: 0 });
  });

  it("is quiet when connected but nothing recent (history doesn't count as flowing)", () => {
    expect(feedHealth(feed("live", [msg(7200)]), NOW)).toMatchObject({
      tone: "warning",
      label: "Quiet",
      detail: "no messages in the last minute; last one 2 h ago",
    });
    expect(feedHealth(feed("live"), NOW).detail).toBe("connected, no messages yet");
  });

  it("flags schema mismatches and errors", () => {
    expect(feedHealth(feed("live", [msg(1, false), msg(2)]), NOW)).toMatchObject({ tone: "warning", mismatches: 1 });
    expect(feedHealth(feed("error", [], "auth failed"), NOW)).toMatchObject({ tone: "danger", detail: "auth failed" });
    expect(feedHealth(feed("idle"), NOW).label).toBe("Off");
  });

  it("formats ages", () => {
    expect([ago(4000), ago(90_000), ago(3 * 3600_000), ago(5 * 86400_000)]).toEqual(["4s ago", "2 min ago", "3 h ago", "5 days ago"]);
  });
});
