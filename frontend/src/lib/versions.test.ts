import { describe, expect, it } from "vitest";
import type { ProcessorInfo, Version } from "../types";
import { compareSemver, findInfo, updateFor, versionFor } from "./versions";

const v = (ref: string, label: string, kind: "tag" | "branch", commit: string): Version => ({
  ref,
  label,
  kind,
  commit,
  committed_date: null,
  input: "EncodedPackets",
  output: "Packets",
  source: "processor.yaml",
  warnings: [],
  web_url: "",
});

const info = (versions: Version[]): ProcessorInfo => ({
  id: "yume02kki/skywalker:Base64Decoder",
  project: "yume02kki/skywalker",
  path: "Base64Decoder",
  name: "Base64Decoder",
  description: "",
  repo: "https://gitlab.com/yume02kki/skywalker.git",
  web_url: "",
  input: "EncodedPackets",
  output: "Packets",
  warnings: [],
  latest: versions[0].ref,
  head: versions[versions.length - 1].commit,
  versions,
});

describe("versions", () => {
  it("orders semver with pre-releases below releases", () => {
    expect(compareSemver("v0.4.10", "v0.4.9")).toBe(1);
    expect(compareSemver("v1.0.0-rc.1", "v1.0.0")).toBe(-1);
  });

  it("flags a newer tag", () => {
    const i = info([
      v("Base64Decoder/v0.4.3", "v0.4.3", "tag", "b"),
      v("Base64Decoder/v0.4.2", "v0.4.2", "tag", "a"),
      v("b", "main@b", "branch", "b"),
    ]);
    expect(updateFor(i, "Base64Decoder/v0.4.2")?.ref).toBe("Base64Decoder/v0.4.3");
    expect(updateFor(i, "Base64Decoder/v0.4.3")).toBeUndefined();
  });

  it("flags a pinned commit that isn't the newest", () => {
    const i = info([v("Base64Decoder/v0.4.2", "v0.4.2", "tag", "a"), v("c".repeat(40), "main@cccc", "branch", "c".repeat(40))]);
    expect(updateFor(i, "c".repeat(40))?.ref).toBe("Base64Decoder/v0.4.2");
  });

  it("treats a missing Ref as the default branch, which is always the latest", () => {
    const head = v("c".repeat(40), "main@cccc", "branch", "c".repeat(40));
    const i = info([v("Base64Decoder/v0.4.3", "v0.4.3", "tag", "b"), head]);
    expect(versionFor(i, undefined)).toBe(head);
    expect(versionFor(i, "HEAD")).toBe(head);
    expect(updateFor(i, undefined)).toBeUndefined();
  });

  it("matches nodes to discovered processors by repo and path", () => {
    const i = info([v("Base64Decoder/v0.4.2", "v0.4.2", "tag", "a")]);
    expect(findInfo({ Repo: "https://gitlab.com/yume02kki/skywalker", Path: "Base64Decoder/" }, [i])).toBe(i);
    expect(findInfo({ Repo: "https://gitlab.com/yume02kki/skywalker.git", Path: "XmlToJson" }, [i])).toBeUndefined();
  });
});
