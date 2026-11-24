import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const entry = path.join(import.meta.dir, "prepare-stage-dependencies.ts");
const pin = /npm install -g bun@(\d+\.\d+\.\d+)/.exec(readFileSync(path.join(import.meta.dir, "../Dockerfile"), "utf8"))![1]!;
const older = "1.3.3";

function findPinnedBun(): string {
  const cache = process.env.XDG_CACHE_HOME ?? path.join(Bun.env.HOME ?? "", ".cache");
  const candidates = [
    "/usr/local/bin/bun-container",
    path.join(cache, "delegatus-gate", `bun-${pin}`, "node_modules/.bin/bun"),
    ...((process.env.PATH ?? "").split(path.delimiter).filter(Boolean)
      .map(dir => Bun.which("bun", { PATH: path.resolve(dir) }) ?? "")),
  ];
  for (const candidate of candidates) {
    if (!candidate || !existsSync(candidate)) continue;
    const result = Bun.spawnSync([candidate, "--version"], { timeout: 2_000 });
    if (result.exitCode === 0 && result.stdout.toString().trim() === pin) return candidate;
  }
  throw new Error(`Focused test requires Dockerfile-pinned Bun ${pin} to be installed`);
}

const pinnedBun = findPinnedBun();

test.skipIf(process.platform === "win32").each(["cache", "PATH", "unavailable"] as const)(
  "dependency preparation with older Bun first on PATH and the pinned runtime %s",
  (source) => {
    const root = mkdtempSync(path.join(tmpdir(), "stage-dependency-runtime-"));
    try {
      const repo = path.join(root, "repo"), lane = path.join(root, "lane");
      const hostBin = path.join(root, "host-bin"), pinnedBin = path.join(root, "pinned-bin");
      const home = path.join(root, "home"), cache = path.join(root, "cache"), tmp = path.join(root, "tmp");
      const preload = path.join(root, "old-bun.ts");
      for (const dir of [repo, hostBin, pinnedBin, home, cache, tmp]) mkdirSync(dir);
      const env = {
        HOME: home, XDG_CONFIG_HOME: path.join(root, "config"), XDG_CACHE_HOME: cache,
        LLV_STATE_DIR: path.join(root, "state"), TMPDIR: tmp,
        TEST_BUN: process.execPath, TEST_BUN_PRELOAD: preload,
        GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Fixture", GIT_COMMITTER_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: ["noreply", "example.invalid"].join("@"),
        GIT_COMMITTER_EMAIL: ["noreply", "example.invalid"].join("@"),
        PATH: [hostBin, ...(source === "PATH" ? [pinnedBin] : []), "/usr/bin", "/bin"].join(path.delimiter),
      };
      const run = (args: string[], cwd = repo) =>
        Bun.spawnSync(args, { cwd, env, timeout: 10_000, killSignal: "SIGKILL" });
      const git = (...args: string[]) => {
        const result = run(["git", ...args]);
        if (result.exitCode !== 0) throw new Error(result.stderr.toString());
      };
      git("init", "-q");
      // Keep a nonempty frozen lock without fetching packages or running a registry.
      const manifest = { name: "delegatus-cli", optionalDependencies: { "fixture-tool": "1.0.0" } };
      const os = process.platform === "darwin" ? "linux" : "darwin";
      const integrity = createHash("sha512").update("fixture").digest("base64");
      writeFileSync(path.join(repo, "package.json"), JSON.stringify(manifest));
      writeFileSync(path.join(repo, "bun.lock"), JSON.stringify({
        lockfileVersion: 1, configVersion: 1, workspaces: { "": manifest },
        packages: { "fixture-tool": ["fixture-tool@1.0.0", "", { os }, `sha512-${integrity}`] },
      }));
      writeFileSync(path.join(repo, ".gitignore"), "/node_modules\n");
      git("add", ".");
      git("commit", "-qm", "Dependency fixture");
      git("worktree", "add", "-q", "--detach", lane);

      // Present the older runtime's version and missing API without downloading
      // a second runtime. Its install command must never be used.
      writeFileSync(preload, `process.versions.bun = "${older}"; delete Bun.TOML.stringify;`);
      writeFileSync(path.join(hostBin, "bun"), `#!/bin/sh
case "$1" in
  --version) printf '%s\\n' '${older}'; exit 0 ;;
  install) exit 90 ;;
esac
exec "$TEST_BUN" --no-env-file --preload "$TEST_BUN_PRELOAD" "$@"
`, { mode: 0o755 });
      const cachedBin = path.join(cache, "delegatus-gate", `bun-${pin}`, "node_modules/.bin");
      mkdirSync(cachedBin, { recursive: true });
      // A cache pathname alone is insufficient. The fallback probes its version.
      symlinkSync(source === "cache" ? pinnedBun : path.join(hostBin, "bun"), path.join(cachedBin, "bun"));
      if (source === "PATH") symlinkSync(pinnedBun, path.join(pinnedBin, "bun"));
      expect(run(["bun", "--version"], lane).stdout.toString().trim()).toBe(older);

      const result = run(["bun", entry], lane);
      if (source === "unavailable") {
        expect(result.exitCode).toBe(1);
        expect(result.stderr.toString()).toContain(`found Bun ${older}. Dependency preparation requires Dockerfile-pinned Bun ${pin}`);
        expect(() => readlinkSync(path.join(lane, "node_modules"))).toThrow("ENOENT");
      } else {
        expect(result.stderr.toString()).toBe("");
        expect(result.exitCode).toBe(0);
        expect(readlinkSync(path.join(lane, "node_modules"))).toContain("delegatus-dependencies");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")("image pre-commit and post-merge hooks select bun-container before the host shim", () => {
  const root = mkdtempSync(path.join(tmpdir(), "stage-image-hook-"));
  try {
    const repo = path.join(root, "repo"), lane = path.join(root, "lane");
    const hooks = path.join(root, "hooks"), hostBin = path.join(root, "host-bin");
    const imageBin = path.join(root, "bun-container"), marker = path.join(root, "dockerenv");
    const hostCalls = path.join(root, "host-calls"), prepared = path.join(root, "prepared");
    for (const directory of [repo, hooks, hostBin]) mkdirSync(directory);
    writeFileSync(marker, "");
    writeFileSync(imageBin, `#!/bin/sh
case "$1" in
  scripts/prepare-stage-dependencies.ts) : > '${prepared}' ;;
  scripts/local-gate.ts) : ;;
  *) exit 92 ;;
esac
`, { mode: 0o755 });
    const hostShim = path.join(hostBin, "bun");
    writeFileSync(hostShim, `#!/bin/sh
if [ "$1" = --version ]; then printf '%s\\n' '${older}'; exit 0; fi
printf '%s\\n' "$*" >> '${hostCalls}'
exit 91
`, { mode: 0o755 });

    const git = (...args: string[]) => {
      const result = Bun.spawnSync(["git", ...args], { cwd: repo, env: { ...process.env, PATH: `${hostBin}${path.delimiter}/usr/bin:/bin`, GIT_AUTHOR_NAME: "Fixture", GIT_COMMITTER_NAME: "Fixture", GIT_AUTHOR_EMAIL: "noreply@example.invalid", GIT_COMMITTER_EMAIL: "noreply@example.invalid" } });
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    };
    git("init", "-q");
    writeFileSync(path.join(repo, "base"), "base\n");
    git("add", "base");
    git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "fixture base");
    git("worktree", "add", "-qb", "image-hook", lane);
    git("config", "core.hooksPath", hooks);

    for (const hookName of ["pre-commit", "post-merge"] as const) {
      const source = readFileSync(path.join(import.meta.dir, "../.githooks", hookName), "utf8")
        .replaceAll("/.dockerenv", marker)
        .replaceAll("/usr/local/bin/bun-container", imageBin)
        .replaceAll("/usr/local/bin/bun", hostShim);
      const target = path.join(hooks, hookName);
      writeFileSync(target, source, { mode: 0o755 });
    }
    const worktreeGit = (args: string[]) => {
      const result = Bun.spawnSync(["git", ...args], { cwd: lane, env: { ...process.env, PATH: `${hostBin}${path.delimiter}/usr/bin:/bin`, GIT_AUTHOR_NAME: "Fixture", GIT_COMMITTER_NAME: "Fixture", GIT_AUTHOR_EMAIL: "noreply@example.invalid", GIT_COMMITTER_EMAIL: "noreply@example.invalid" } });
      return result;
    };
    writeFileSync(path.join(lane, "change"), "stage\n");
    const commit = worktreeGit(["add", "change"]);
    expect(commit.exitCode).toBe(0);
    const committed = worktreeGit(["commit", "-m", "stage change"]);
    expect(committed.exitCode).toBe(0);
    expect(existsSync(prepared)).toBe(true);
    expect(existsSync(hostCalls)).toBe(false);

    rmSync(prepared);
    const merged = Bun.spawnSync(["bash", path.join(hooks, "post-merge")], { cwd: lane, env: { ...process.env, PATH: `${hostBin}${path.delimiter}/usr/bin:/bin` } });
    expect(merged.exitCode).toBe(0);
    expect(existsSync(prepared)).toBe(true);
    expect(existsSync(hostCalls)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
