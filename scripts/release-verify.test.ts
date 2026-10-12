import { expect, test } from "bun:test";
import { releasePreflight, releasePublished, verifyRelease, type ReleasePreflight, type VerifyPorts } from "./release-verify";
const valid = (): ReleasePreflight => ({ tag: "v1.2.0", version: "1.2.0", localTag: "absent", remoteTag: "absent", npmVersion: false,
  files: ["CHANGELOG.md", "package.json", "docs/media/readme/board.svg"], provenance: true, clean: true });
test("preflight refuses product changes, existing tags or packages, stale frames and dirty heads", () => {
  expect(releasePreflight(valid())).toEqual([]);
  for (const patch of [{ files: ["src/components/Feed.tsx"] }, { localTag: "conflict" as const }, { remoteTag: "conflict" as const }, { npmVersion: true }, { provenance: false }, { clean: false }, { version: "1.1.0" }]) {
    expect(releasePreflight({ ...valid(), ...patch }).length).toBeGreaterThan(0);
  }
  expect(releasePreflight({ ...valid(), localTag: "matching", remoteTag: "absent" })).toEqual([]);
  expect(releasePreflight({ ...valid(), localTag: "matching", remoteTag: "matching", npmVersion: true })).toEqual([]);
  expect(releasePreflight({ ...valid(), remoteTag: "matching" })).toContain("release tag conflicts with the reviewed local or remote object");
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
      if (file === "git" && args[0] === "cat-file") return args[1] === "-p"
        ? `object ${sha}\ntype commit\ntag v1.2.0\ntagger Tester <test@example.invalid> 0 +0000\n\nDelegatus 1.2.0` : "tag";
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
  expect(await verifyRelease("v1.2.0", null, ports)).toEqual({ errors: [] });
  expect(calls.filter(c => c.startsWith("docker ")).length).toBe(3);
  expect(calls.some(c => /^(git (push|tag)|npm publish)/.test(c))).toBe(false);
});

test("a green checkout-triggered macOS run cannot replace the install run linked to the selected npm run", async () => {
  const sha = "b".repeat(40); let now = 0; let waits = 0; let macReads = 0;
  const ports: VerifyPorts = {
    now: () => now, wait: async () => { waits++; now += 30_000; }, provenance: () => true,
    registry: async url => url.endsWith("/1.2.0") ? { version: "1.2.0", dist: { integrity: "sha512-synthetic" } } : { "dist-tags": { latest: "1.2.0" } },
    command: async (file, args) => {
      if (file === "git" && args[0] === "show") return JSON.stringify({ name: "package-example", version: "1.2.0" });
      if (file === "git" && args[0] === "rev-parse") return sha;
      if (file === "git" && args[0] === "cat-file") return args[1] === "-p"
        ? `object ${sha}\ntype commit\ntag v1.2.0\ntagger Tester <test@example.invalid> 0 +0000\n\nDelegatus 1.2.0` : "tag";
      if (file === "git" && args[0] === "ls-remote") return `${sha}\trefs/tags/v1.2.0\n${sha}\trefs/tags/v1.2.0^{}`;
      if (file === "gh" && args[0] === "repo") return "example/project";
      if (file === "gh" && args[0] === "run" && args[1] === "list") {
        if (args.includes("macos-newcomer.yml")) {
          macReads++;
          const mac = macReads === 1
            ? { databaseId: 9, headSha: sha, displayTitle: "macOS newcomer install", status: "completed", conclusion: "success" }
            : { databaseId: 10, headSha: "main", displayTitle: "macOS install after npm run 1", status: "completed", conclusion: "success" };
          return JSON.stringify([mac]);
        }
        return JSON.stringify([{ databaseId: 1, headSha: sha, displayTitle: "Publish v1.2.0", status: "completed", conclusion: "success" }]);
      }
      if (file === "docker" && args[0] === "buildx") return JSON.stringify({ manifests: [{ platform: { os: "linux", architecture: "amd64" } }, { platform: { os: "linux", architecture: "arm64" } }] });
      throw new Error("unexpected command");
    },
  };
  expect(await verifyRelease("v1.2.0", null, ports)).toEqual({ errors: [] });
  expect(waits).toBeGreaterThan(0);
  expect(macReads).toBeGreaterThan(1);
});

test("real preflight rejects a product path with recorded commands and never writes", async () => {
  const ports: VerifyPorts = { now: () => 0, wait: async () => {}, provenance: () => true, registry: async () => null,
    command: async (file, args) => {
      if (file !== "git") throw new Error("unexpected command");
      if (args[0] === "show") return JSON.stringify({ name: "package-example", version: "1.2.0" });
      if (args[0] === "diff") return "src/components/Feed.tsx";
      if (args[0] === "rev-parse") return "b".repeat(40);
      if (["status", "merge-base", "for-each-ref", "ls-remote"].includes(args[0])) return "";
      throw new Error("unexpected or mutating command");
    } };
  expect((await verifyRelease("v1.2.0", "a".repeat(40), ports)).errors).toEqual(["diff includes product paths"]);
});

test("preflight distinguishes a matching local-only tag, a confirmed remote tag, and conflicts", async () => {
  const head = "b".repeat(40); const object = "d".repeat(40);
  const runPreflight = async (local: boolean, localCommit: string, remoteLines: string, packagePublished = false, message = "Delegatus 1.2.0") => verifyRelease("v1.2.0", "a".repeat(40), {
    now: () => 0, wait: async () => {}, provenance: () => true, registry: async () => packagePublished ? { version: "1.2.0" } : null,
    command: async (_file, args) => {
      if (args[0] === "show" && args[1] === "HEAD:package.json") return JSON.stringify({ name: "package-example", version: "1.2.0" });
      if (args[0] === "show" && args[1] === "v1.2.0:package.json") return JSON.stringify({ version: "1.2.0" });
      if (args[0] === "for-each-ref") return local ? "refs/tags/v1.2.0" : "";
      if (args[0] === "rev-parse" && args[1] === "HEAD") return head;
      if (args[0] === "rev-parse" && args[1] === "refs/tags/v1.2.0") return object;
      if (args[0] === "rev-parse" && args[1] === "refs/tags/v1.2.0^{commit}") return localCommit;
      if (args[0] === "cat-file" && args[1] === "-t") return "tag";
      if (args[0] === "cat-file" && args[1] === "-p") return `object ${localCommit}\ntype commit\ntag v1.2.0\ntagger Tester <test@example.invalid> 0 +0000\n\n${message}`;
      if (args[0] === "ls-remote") return remoteLines;
      if (args[0] === "diff" || args[0] === "status" || args[0] === "merge-base") return "";
      throw new Error(`unexpected command ${args.join(" ")}`);
    },
  });
  const noRemote = await runPreflight(true, head, "");
  expect(noRemote.errors).toEqual([]);
  expect(noRemote.nextStep).toBe("push-existing");
  const remote = `${object}\trefs/tags/v1.2.0\n${head}\trefs/tags/v1.2.0^{}`;
  const confirmed = await runPreflight(true, head, remote, true);
  expect(confirmed.errors).toEqual([]);
  expect(confirmed.nextStep).toBe("verify-remote");
  const changed = await runPreflight(true, "c".repeat(40), "");
  expect(changed.errors.length).toBeGreaterThan(0);
  const foreignLocal = await runPreflight(true, head, "", false, "A different release");
  expect(foreignLocal.errors.length).toBeGreaterThan(0);
  const foreign = await runPreflight(true, head, `${"e".repeat(40)}\trefs/tags/v1.2.0\n${"c".repeat(40)}\trefs/tags/v1.2.0^{}`);
  expect(foreign.errors.length).toBeGreaterThan(0);
});

test("restart verification refuses a remote tag that no longer names the local immutable release", async () => {
  const ports: VerifyPorts = { now: () => 0, wait: async () => {}, provenance: () => true, registry: async () => null,
    command: async (file, args) => {
      if (file === "git" && args[0] === "show") return JSON.stringify({ name: "package-example", version: "1.2.0" });
      if (file === "git" && args[0] === "rev-parse") return "b".repeat(40);
      if (file === "git" && args[0] === "cat-file") return args[1] === "-p"
        ? `object ${"b".repeat(40)}\ntype commit\ntag v1.2.0\ntagger Tester <test@example.invalid> 0 +0000\n\nDelegatus 1.2.0` : "tag";
      if (file === "git" && args[0] === "ls-remote") return `${"c".repeat(40)}\trefs/tags/v1.2.0^{}`;
      throw new Error("no workflow may verify a mismatched tag");
    } };
  expect((await verifyRelease("v1.2.0", null, ports)).errors).toEqual(["remote annotated tag differs from the local release"]);
});
test("verification requires three successful workflows, exact npm latest and one multi-arch digest", () => {
  const valid = { version: "1.2.0", npmVersion: "1.2.0", latest: "1.2.0", integrity: "sha512-synthetic", runs: ["success", "success", "success"], images: ["one", "one", "one"].map(digest => ({ digest, platforms: ["linux/amd64", "linux/arm64"] })) };
  expect(releasePublished(valid)).toEqual([]);
  expect(releasePublished({ ...valid, latest: "1.1.0" }).length).toBeGreaterThan(0);
  expect(releasePublished({ ...valid, runs: ["success", "failure", "success"] }).length).toBeGreaterThan(0);
  expect(releasePublished({ ...valid, images: [{ digest: "one", platforms: ["linux/amd64"] }] }).length).toBeGreaterThan(0);
});
