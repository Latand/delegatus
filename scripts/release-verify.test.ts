import { expect, test } from "bun:test";
import { releasePreflight, releasePublished, verifyRelease, type ReleasePreflight, type VerifyPorts } from "./release-verify";
const valid = (): ReleasePreflight => ({ tag: "v1.2.0", version: "1.2.0", localTag: false, remoteTag: false, npmVersion: false,
  files: ["CHANGELOG.md", "package.json", "docs/media/readme/board.svg"], provenance: true, clean: true });
test("preflight refuses product changes, existing tags or packages, stale frames and dirty heads", () => {
  expect(releasePreflight(valid())).toEqual([]);
  for (const patch of [{ files: ["src/components/Feed.tsx"] }, { localTag: true }, { remoteTag: true }, { npmVersion: true }, { provenance: false }, { clean: false }, { version: "1.1.0" }]) {
    expect(releasePreflight({ ...valid(), ...patch }).length).toBeGreaterThan(0);
  }
});

test("real verifier consumes recorded read-only git, workflow, npm and image responses", async () => {
  const calls: string[] = [];
  const sha = "b".repeat(40);
  const ports: VerifyPorts = {
    now: () => 0, wait: async () => { throw new Error("unexpected wait"); }, provenance: () => true,
    registry: async url => url.endsWith("/1.2.0") ? { version: "1.2.0", dist: { integrity: "sha512-synthetic" } } : { "dist-tags": { latest: "1.2.0" } },
    command: async (file, args) => {
      calls.push(`${file} ${args.join(" ")}`);
      if (file === "git" && args[0] === "show") return JSON.stringify({ name: "package-example", version: "1.2.0" });
      if (file === "git" && args[0] === "rev-parse") return sha;
      if (file === "git" && args[0] === "cat-file") return "tag";
      if (file === "git" && args[0] === "ls-remote") return `${sha}\trefs/tags/v1.2.0\n${sha}\trefs/tags/v1.2.0^{}`;
      if (file === "gh" && args[0] === "repo") return "example/project";
      if (file === "gh" && args[0] === "run" && args[1] === "list") {
        const mac = args.includes("macos-newcomer.yml");
        return JSON.stringify([{ databaseId: mac ? 3 : 1, headSha: mac ? "main" : sha, displayTitle: mac ? "macOS install after npm run 1" : "Publish v1.2.0", status: "completed", conclusion: "success" }]);
      }
      if (file === "docker" && args[0] === "buildx" && args[1] === "imagetools" && args[2] === "inspect") return JSON.stringify({ manifests: [{ platform: { os: "linux", architecture: "amd64" } }, { platform: { os: "linux", architecture: "arm64" } }] });
      throw new Error("unexpected or mutating command");
    },
  };
  expect(await verifyRelease("v1.2.0", null, ports)).toEqual([]);
  expect(calls.filter(c => c.startsWith("docker ")).length).toBe(3);
  expect(calls.some(c => /^(git (push|tag)|npm publish)/.test(c))).toBe(false);
});

test("real preflight rejects a product path with recorded commands and never writes", async () => {
  const ports: VerifyPorts = { now: () => 0, wait: async () => {}, provenance: () => true, registry: async () => null,
    command: async (file, args) => {
      if (file !== "git") throw new Error("unexpected command");
      if (args[0] === "show") return JSON.stringify({ name: "package-example", version: "1.2.0" });
      if (args[0] === "diff") return "src/components/Feed.tsx";
      if (["status", "merge-base", "for-each-ref", "ls-remote"].includes(args[0])) return "";
      throw new Error("unexpected or mutating command");
    } };
  expect(await verifyRelease("v1.2.0", "a".repeat(40), ports)).toEqual(["diff includes product paths"]);
});

test("restart verification refuses a remote tag that no longer names the local immutable release", async () => {
  const ports: VerifyPorts = { now: () => 0, wait: async () => {}, provenance: () => true, registry: async () => null,
    command: async (file, args) => {
      if (file === "git" && args[0] === "show") return JSON.stringify({ name: "package-example", version: "1.2.0" });
      if (file === "git" && args[0] === "rev-parse") return "b".repeat(40);
      if (file === "git" && args[0] === "cat-file") return "tag";
      if (file === "git" && args[0] === "ls-remote") return `${"c".repeat(40)}\trefs/tags/v1.2.0^{}`;
      throw new Error("no workflow may verify a mismatched tag");
    } };
  expect(await verifyRelease("v1.2.0", null, ports)).toEqual(["remote annotated tag differs from the local release"]);
});
test("verification requires three successful workflows, exact npm latest and one multi-arch digest", () => {
  const valid = { version: "1.2.0", npmVersion: "1.2.0", latest: "1.2.0", integrity: "sha512-synthetic", runs: ["success", "success", "success"], images: ["one", "one", "one"].map(digest => ({ digest, platforms: ["linux/amd64", "linux/arm64"] })) };
  expect(releasePublished(valid)).toEqual([]);
  expect(releasePublished({ ...valid, latest: "1.1.0" }).length).toBeGreaterThan(0);
  expect(releasePublished({ ...valid, runs: ["success", "failure", "success"] }).length).toBeGreaterThan(0);
  expect(releasePublished({ ...valid, images: [{ digest: "one", platforms: ["linux/amd64"] }] }).length).toBeGreaterThan(0);
});
