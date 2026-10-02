import type { ProcessorInfo, Processorspec, Version } from "../types";

const SEMVER = /v(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

export function semverKey(label: string): [number, number, number, number, string] {
  const m = SEMVER.exec(label);
  if (!m) return [-1, -1, -1, 0, label];
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ? 0 : 1, m[4] ?? ""];
}

export function compareSemver(a: string, b: string): number {
  const ka = semverKey(a);
  const kb = semverKey(b);
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] < kb[i]) return -1;
    if (ka[i] > kb[i]) return 1;
  }
  return 0;
}

const normRepo = (url: string | undefined) =>
  (url ?? "")
    .trim()
    .toLowerCase()
    .replace(/\.git$/, "")
    .replace(/\/$/, "");

/** The discovered processor a canvas node was dragged from (same repo and folder). */
export function findInfo(spec: Processorspec | undefined, infos: Iterable<ProcessorInfo>): ProcessorInfo | undefined {
  if (!spec) return undefined;
  const repo = normRepo(spec.Repo);
  const path = (spec.Path ?? "").replace(/^\/+|\/+$/g, "");
  for (const info of infos) {
    if (normRepo(info.repo) === repo && info.path === path) return info;
  }
  return undefined;
}

/** The default-branch version: what a processor without a Ref runs (foundry: no Ref = HEAD). */
export function headVersion(info: ProcessorInfo | undefined): Version | undefined {
  return info?.versions.find((v) => v.kind === "branch");
}

export function versionFor(info: ProcessorInfo | undefined, ref: string | undefined): Version | undefined {
  if (!info) return undefined;
  if (!ref || ref === "HEAD") return headVersion(info);
  return info.versions.find((v) => v.ref === ref) ?? info.versions.find((v) => v.commit.startsWith(ref));
}

/**
 * The newer version a node could move to, if any. A tag is outdated when a higher
 * semver tag exists; a pinned commit is outdated when the newest version is a
 * different commit.
 */
export function updateFor(info: ProcessorInfo | undefined, ref: string | undefined): Version | undefined {
  // No Ref follows the default branch, so it's always on the latest.
  if (!info || !ref || ref === "HEAD" || info.versions.length === 0) return undefined;
  const newest = info.versions[0];
  const current = versionFor(info, ref);
  if (current?.kind === "tag" || (!current && SEMVER.test(ref))) {
    const label = current?.label ?? ref;
    const newer = info.versions.filter((v) => v.kind === "tag" && compareSemver(v.label, label) > 0);
    return newer[0];
  }
  if (current && current.commit !== newest.commit) return newest;
  return undefined;
}
