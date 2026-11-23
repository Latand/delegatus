import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { releaseCutFromTag, releasePreflight, releasePublished, verifyRelease, type ReleasePreflight, type VerifyPorts } from "./release-verify";
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

test("preflight keeps the changelog boundary independent from product paths integrated after the cut", () => {
  const base: ReleasePreflight = { tag: "v1.2.0", version: "1.2.0", localTag: "absent", remoteTag: "absent",
    npmVersion: false, files: ["CHANGELOG.md", "package.json"], provenance: true, clean: true };
  expect(releasePreflight(base)).toEqual([]);
  const cut = "b".repeat(40);
  expect(releaseCutFromTag(`object a\ntype commit\ntag v1.2.0\n\nDelegatus 1.2.0\n\nRelease-Cut: ${cut}`)).toBe(cut);
  expect(releaseCutFromTag("object a\ntype commit\ntag v1.2.0\n\nDelegatus 1.2.0")).toBeNull();
});

test("real verifier consumes recorded read-only git, workflow, npm and image responses", async () => {
  const calls: string[] = [];
  const sha = "b".repeat(40);
  const ports: VerifyPorts = {
    now: () => 0, wait: async () => { throw new Error("unexpected wait"); }, provenance: () => true,
    registry: async url => url.endsWith("/1.2.0") ? { version: "1.2.0", dist: { integrity: "sha512-synthetic" } } : { latest: "1.2.0" },
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

test.each(["fresh", "delayed", "missing", "scoped"] as const)("release verification ignores a stale packument (%s metadata)", async mode => {
  const sha = "b".repeat(40);
  const registryReads: string[] = [];
  const name = mode === "scoped" ? "@example/package-example" : "package-example";
  const encodedName = encodeURIComponent(name);
  let now = 0;
  let waits = 0;
  const ports: VerifyPorts = {
    now: () => now,
    wait: async () => { waits++; now += 30_000; },
    provenance: () => true,
    registry: async url => {
      registryReads.push(url);
      const pending = mode === "missing" || mode === "delayed" && waits === 0;
      if (url.endsWith(`/${encodedName}/1.2.0`)) return pending ? null : { version: "1.2.0", dist: { integrity: "sha512-synthetic" } };
      if (url.endsWith(`/-/package/${encodedName}/dist-tags`)) return pending ? null : { latest: "1.2.0" };
      if (url.endsWith(`/${encodedName}`)) return { "dist-tags": { latest: "1.1.0" } };
      throw new Error(`unexpected registry URL ${url}`);
    },
    command: async (file, args) => {
      if (file === "git" && args[0] === "show") return JSON.stringify({ name, version: "1.2.0" });
      if (file === "git" && args[0] === "rev-parse") return sha;
      if (file === "git" && args[0] === "cat-file") return args[1] === "-p"
        ? `object ${sha}\ntype commit\ntag v1.2.0\ntagger Tester <test@example.invalid> 0 +0000\n\nDelegatus 1.2.0` : "tag";
      if (file === "git" && args[0] === "ls-remote") return `${sha}\trefs/tags/v1.2.0\n${sha}\trefs/tags/v1.2.0^{}`;
      if (file === "gh" && args[0] === "repo") return "example/project";
      if (file === "gh" && args[0] === "run" && args[1] === "list") {
        const mac = args.includes("macos-newcomer.yml");
        return JSON.stringify([{ databaseId: mac ? 3 : 1, headSha: mac ? "main" : sha, displayTitle: mac ? "macOS install after npm run 1" : "Publish v1.2.0", status: "completed", conclusion: "success" }]);
      }
      if (file === "docker" && args[0] === "buildx") return JSON.stringify({ manifests: [{ platform: { os: "linux", architecture: "amd64" } }, { platform: { os: "linux", architecture: "arm64" } }] });
      throw new Error(`unexpected command ${file} ${args.join(" ")}`);
    },
  };

  expect(await verifyRelease("v1.2.0", null, ports)).toEqual({
    errors: mode === "missing" ? ["npm version/latest/integrity not verified"] : [],
  });
  const rounds = mode === "missing" ? 180 : mode === "delayed" ? 2 : 1;
  expect(waits).toBe(mode === "missing" ? 180 : rounds - 1);
  expect(now).toBe(mode === "missing" ? 90 * 60_000 : (rounds - 1) * 30_000);
  expect(registryReads).toEqual(Array.from({ length: rounds }, () => [
    `https://registry.npmjs.org/${encodedName}/1.2.0`,
    `https://registry.npmjs.org/-/package/${encodedName}/dist-tags`,
  ]).flat());
});

test("a green checkout-triggered macOS run cannot replace the install run linked to the selected npm run", async () => {
  const sha = "b".repeat(40); let now = 0; let waits = 0; let macReads = 0;
  const ports: VerifyPorts = {
    now: () => now, wait: async () => { waits++; now += 30_000; }, provenance: () => true,
    registry: async url => url.endsWith("/1.2.0") ? { version: "1.2.0", dist: { integrity: "sha512-synthetic" } } : { latest: "1.2.0" },
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

test("the preflight CLI requires the merged PR number", () => {
  const result = spawnSync(process.execPath, [new URL("./release-verify.ts", import.meta.url).pathname,
    "--preflight", "--cut", "a".repeat(40), "--tag", "v1.2.0"], { encoding: "utf8", timeout: 5_000 });
  expect(result.status).toBe(1);
  expect(result.stderr.trim()).toBe("release preflight requires --pr with the merged release PR number");
});

test("preflight distinguishes a matching local-only tag, a confirmed remote tag, and conflicts", async () => {
  const head = "b".repeat(40); const object = "d".repeat(40);
  const runPreflight = async (local: boolean, localCommit: string, remoteLines: string, packagePublished = false, message = `Delegatus 1.2.0\n\nRelease-Cut: ${"a".repeat(40)}`) => verifyRelease("v1.2.0", "a".repeat(40), {
    now: () => 0, wait: async () => {}, provenance: () => true, registry: async () => packagePublished ? { version: "1.2.0" } : null,
    command: async (file, args) => {
      if (file === "gh") return JSON.stringify({ state: "MERGED", baseRefName: "main", mergeCommit: { oid: head } });
      args = args.filter(arg => arg !== "--no-replace-objects");
      if (args[0] === "fetch") return "";
      if (args[0] === "show" && args[1] === `${head}:package.json`) return JSON.stringify({ name: "package-example", version: "1.2.0" });
      if (args[0] === "show" && args[1]?.endsWith(":scripts/capture-readme-media.ts")) return "fixture generator at cut";
      if (args[0] === "show" && args[1]?.endsWith(":scripts/readme-demo-state.ts")) return "fixture seed at cut";
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
  }, "7");
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

function imagePorts(docker: (args: string[]) => string, calls: string[]): VerifyPorts {
  const sha = "b".repeat(40); let now = 0;
  return {
    now: () => now, wait: async () => { now += 60 * 60_000; }, provenance: () => true,
    registry: async url => url.endsWith("/1.2.0") ? { version: "1.2.0", dist: { integrity: "sha512-synthetic" } } : { latest: "1.2.0" },
    command: async (file, args) => {
      calls.push(`${file} ${args.join(" ")}`);
      if (file === "git" && args[0] === "show") return JSON.stringify({ name: "package-example", version: "1.2.0" });
      if (file === "git" && args[0] === "rev-parse") return sha;
      if (file === "git" && args[0] === "cat-file") return args[1] === "-p"
        ? `object ${sha}\ntype commit\ntag v1.2.0\ntagger Tester <test@example.invalid> 0 +0000\n\nDelegatus 1.2.0` : "tag";
      if (file === "git" && args[0] === "ls-remote") return `${sha}\trefs/tags/v1.2.0\n${sha}\trefs/tags/v1.2.0^{}`;
      if (file === "gh" && args[0] === "repo") return "Example/Project";
      if (file === "gh" && args[0] === "run" && args[1] === "list") {
        const mac = args.includes("macos-newcomer.yml");
        return JSON.stringify([{ databaseId: mac ? 3 : 1, headSha: mac ? "main" : sha, displayTitle: mac ? "macOS install after npm run 1" : "Publish v1.2.0", status: "completed", conclusion: "success" }]);
      }
      if (file === "docker") return docker(args);
      throw new Error("unexpected or mutating command");
    },
  };
}
const platform = (architecture: string) => ({ platform: { os: "linux", architecture } });
const pretty = (architectures: string[]) => JSON.stringify({ manifests: architectures.map(platform) }, null, 3);

test("without buildx imagetools the verifier checks the same three tags with docker manifest inspect", async () => {
  const calls: string[] = [];
  const ports = imagePorts(args => {
    if (args[0] === "buildx") throw new Error("docker: 'buildx' is not a docker command.\nSee 'docker --help'");
    if (args[0] === "manifest" && args[1] === "inspect") return pretty(["amd64", "arm64"]);
    throw new Error("unexpected docker command");
  }, calls);
  expect(await verifyRelease("v1.2.0", null, ports)).toEqual({ errors: [] });
  expect(calls.filter(c => c.startsWith("docker manifest inspect ")))
    .toEqual(["1.2.0", "1.2", "latest"].map(t => `docker manifest inspect ghcr.io/example/project:${t}`));
  expect(calls.filter(c => c.startsWith("docker buildx")).length).toBe(1);
});

test("once a later buildx tag fails, all tags use manifest inspect output for digest comparison", async () => {
  const calls: string[] = []; let buildxReads = 0;
  const ports = imagePorts(args => {
    if (args[0] === "buildx") {
      buildxReads++;
      if (buildxReads === 1) return JSON.stringify({ manifests: [platform("amd64"), platform("arm64")] });
      throw new Error("buildx failed for a later tag");
    }
    if (args[0] === "manifest" && args[1] === "inspect") return pretty(["amd64", "arm64"]);
    throw new Error("unexpected docker command");
  }, calls);

  expect(await verifyRelease("v1.2.0", null, ports)).toEqual({ errors: [] });
  expect(calls.filter(c => c.startsWith("docker manifest inspect "))).toEqual(
    ["1.2", "1.2.0", "latest"].map(t => `docker manifest inspect ghcr.io/example/project:${t}`),
  );
});

test("the manifest inspect fallback still refuses a missing platform and differing tag digests", async () => {
  const missing = await verifyRelease("v1.2.0", null, imagePorts(args => {
    if (args[0] === "buildx") throw new Error("buildx missing");
    return pretty(["amd64"]);
  }, []));
  expect(missing.errors).toContain("Docker tags/digest/platforms not verified");
  const differing = await verifyRelease("v1.2.0", null, imagePorts(args => {
    if (args[0] === "buildx") throw new Error("buildx missing");
    return pretty(args[2].endsWith(":latest") ? ["amd64", "arm64", "s390x"] : ["amd64", "arm64"]);
  }, []));
  expect(differing.errors).toContain("Docker tags/digest/platforms not verified");
  const digestMismatch = await verifyRelease("v1.2.0", null, imagePorts(args => {
    if (args[0] === "buildx") throw new Error("buildx missing");
    return args[2].endsWith(":latest")
      ? JSON.stringify({ manifests: [platform("amd64"), platform("arm64")], annotations: { version: "different" } }, null, 3)
      : pretty(["amd64", "arm64"]);
  }, []));
  expect(digestMismatch.errors).toContain("Docker tags/digest/platforms not verified");
});

test("a tag that neither inspector can read fails with both causes", async () => {
  await expect(verifyRelease("v1.2.0", null, imagePorts(args => {
    throw new Error(args[0] === "buildx" ? "buildx missing" : "manifest unknown");
  }, []))).rejects.toThrow(/buildx imagetools: buildx missing; manifest inspect: manifest unknown/);
});

test("buildx imagetools stays the first choice and manifest inspect is not called when it works", async () => {
  const calls: string[] = [];
  const ports = imagePorts(args => {
    if (args[0] === "buildx") return JSON.stringify({ manifests: [platform("amd64"), platform("arm64")] });
    throw new Error("manifest inspect must not run");
  }, calls);
  expect(await verifyRelease("v1.2.0", null, ports)).toEqual({ errors: [] });
  expect(calls.filter(c => c.startsWith("docker ")).length).toBe(3);
});

// Exercise native Git ancestry and tag objects; only the forge and registry are stubbed.
test.each(["open PR", "wrong base", "branch head", "checkout moved", "squash", "renamed product path", "off main", "unreadable main", "main advanced before preparation", "main advanced before squash"] as const)("release main admission: %s", async scenario => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "release-main-"));
  const lane = path.join(root, "lane"), remote = path.join(root, "origin.git");
  fs.mkdirSync(lane);
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(root, "no-config"), GIT_CONFIG_COUNT: "0",
    GIT_AUTHOR_NAME: "Fixture", GIT_COMMITTER_NAME: "Fixture", GIT_AUTHOR_EMAIL: ["noreply", "example.invalid"].join("@"), GIT_COMMITTER_EMAIL: ["noreply", "example.invalid"].join("@"),
    GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: lane, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  let registryReads = 0;
  try {
    git("init", "--bare", "--initial-branch=main", remote);
    git("init", "--initial-branch=main");
    fs.writeFileSync(path.join(lane, "package.json"), JSON.stringify({ name: "package-example", version: "1.1.0" }));
    fs.mkdirSync(path.join(lane, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(lane, "scripts/capture-readme-media.ts"), "export const generator = 'fixture';\n");
    fs.writeFileSync(path.join(lane, "scripts/readme-demo-state.ts"), "export const seed = 'fixture';\n");
    fs.writeFileSync(path.join(lane, "feature.ts"), "export const feature = true;\n");
    git("add", "."); git("commit", "-m", "base");
    const cut = git("rev-parse", "HEAD");
    git("remote", "add", "origin", remote); git("push", "origin", "HEAD:refs/heads/main");
    if (scenario === "main advanced before preparation") {
      fs.writeFileSync(path.join(lane, "src-feature.ts"), "export const newer = true;\n");
      git("add", "."); git("commit", "-m", "New product after cut (#8)"); git("push", "origin", "main");
    }
    git("checkout", "-b", "release", cut);
    fs.writeFileSync(path.join(lane, "package.json"), JSON.stringify({ name: "package-example", version: "1.2.0" }));
    if (scenario === "renamed product path") {
      git("mv", "feature.ts", "scripts/feature.ts");
    }
    git("add", "."); git("commit", "-m", "release");
    const reviewed = git("rev-parse", "HEAD");
    let merged: string;
    if (scenario === "main advanced before squash") {
      git("checkout", "main"); fs.writeFileSync(path.join(lane, "src-feature.ts"), "export const newer = true;\n");
      git("add", "."); git("commit", "-m", "New product after cut (#8)"); git("push", "origin", "main");
      git("merge", "--squash", "release"); git("commit", "-m", "squash release"); merged = git("rev-parse", "HEAD");
    } else if (scenario === "main advanced before preparation") {
      git("checkout", "main"); git("merge", "--squash", "release"); git("commit", "-m", "squash release"); merged = git("rev-parse", "HEAD");
    } else merged = git("commit-tree", git("rev-parse", "HEAD^{tree}"), "-p", cut, "-m", "squash release");
    if (!(["off main", "main advanced before squash", "main advanced before preparation"] as string[]).includes(scenario)) git("push", "origin", `${merged}:refs/heads/main`);
    if (["main advanced before squash", "main advanced before preparation"].includes(scenario)) git("push", "origin", "main");
    if (scenario !== "branch head") git("checkout", "--detach", merged);
    if (scenario === "unreadable main") git("remote", "set-url", "origin", path.join(root, "missing.git"));
    const ports: VerifyPorts = { now: () => 0, wait: async () => {}, provenance: () => true,
      registry: async () => { registryReads++; return null; },
      command: async (file, args) => {
        if (file === "git") return git(...args);
        if (scenario === "checkout moved") git("commit", "--allow-empty", "-m", "head moves during forge read");
        return JSON.stringify({ state: scenario === "open PR" ? "OPEN" : "MERGED", baseRefName: scenario === "wrong base" ? "other" : "main",
          mergeCommit: { oid: merged } });
      },
    };
    const run = () => verifyRelease("v1.2.0", cut, ports, "7");
    const result = await run();
    if (scenario === "squash" || scenario === "main advanced before preparation" || scenario === "main advanced before squash") {
      expect(result).toEqual({ errors: [], nextStep: "create-and-push", tagCommit: merged });
      if (scenario === "squash") expect(merged).not.toBe(reviewed);
      if (scenario !== "squash") expect(git("show", `${merged}:src-feature.ts`)).toBe("export const newer = true;");
      git("tag", "-a", "v1.2.0", merged, "-m", "Delegatus 1.2.0", "-m", `Release-Cut: ${cut}`);
      expect(await run()).toEqual({ errors: [], nextStep: "push-existing", tagCommit: merged });
      git("push", "origin", "refs/tags/v1.2.0");
      expect(await run()).toEqual({ errors: [], nextStep: "verify-remote", tagCommit: merged });
      expect(git("rev-parse", "HEAD")).toBe(merged);
    } else {
      const reasons = {
        "open PR": "release PR is unmerged",
        "wrong base": "release PR is unmerged",
        "branch head": "release checkout differs from the PR's integrated main commit",
        "checkout moved": "release checkout head moved",
        "renamed product path": "diff includes product paths",
        "off main": "release tag commit is not on origin/main",
        "unreadable main": "cannot refresh origin/main",
      };
      expect(result.errors.join("\n")).toContain(reasons[scenario]);
      expect(result.nextStep).toBeUndefined();
      expect(registryReads).toBe(["checkout moved", "renamed product path"].includes(scenario) ? 1 : 0);
      expect(git("tag", "--list")).toBe("");
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
