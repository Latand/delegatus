import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { deriveRepositorySetup, generatedRepositorySetup, readRepositorySetup } from "./cloudEnvironmentSetup";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

test("Dockerfile pins derive both runtimes and the frozen Bun lockfile install", () => {
  const result = deriveRepositorySetup({ Dockerfile: "FROM node:22.16.0-bookworm-slim\nRUN npm install -g bun@1.4.0\n",
    "package.json": JSON.stringify({ engines: { node: ">=20.9.0", bun: ">=1.4.0" } }), "bun.lock": "" });
  expect(result.reason).toBeNull();
  expect(result.steps).toEqual(["Node 22.16.0 on the system PATH", "Bun 1.4.0 on the system PATH", "bun install --frozen-lockfile"]);
  expect(result.installScript).toContain('/usr/local/bin/bun');
  expect(result.installScript).toContain('env -i PATH=/usr/local/bin:/usr/bin:/bin bun --version');
  expect(result.installScript).toContain('= "1.4.0"');
  expect(result.installScript).toContain('= "v22.16.0"');
  expect(generatedRepositorySetup(result.installScript)).toBe(true);
  expect(generatedRepositorySetup(result.installScript + "echo edited\n")).toBe(false);
});

for (const files of [
  { ".bun-version": "1.4.0" },
  { ".tool-versions": "bun 1.4.0\n" },
  { "package.json": '{"packageManager":"bun@1.4.0"}' },
  { "package.json": '{"engines":{"bun":"1.4.0"}}' },
  { Dockerfile: "FROM oven/bun:1.4.0-slim" },
] as const) test(`an exact Bun pin from ${Object.keys(files)[0]} needs no guessed version`, () => {
  const setup = deriveRepositorySetup(files);
  expect(setup.reason).toBeNull(); expect(setup.steps).toEqual(["Bun 1.4.0 on the system PATH"]);
  expect(setup.installScript).not.toContain("install --frozen-lockfile");
});

for (const files of [
  { ".node-version": "22.16.0" }, { ".nvmrc": "v22.16.0" },
  { ".tool-versions": "nodejs 22.16.0\n" }, { "package.json": '{"engines":{"node":"22.16.0"}}' },
] as const) test(`Node-only ${Object.keys(files)[0]} derives npm ci only with a lockfile`, () => {
  const setup = deriveRepositorySetup({ ...files, "package-lock.json": "" });
  expect(setup.reason).toBeNull(); expect(setup.steps).toEqual(["Node 22.16.0 on the system PATH", "npm ci"]);
  expect(setup.installScript).not.toContain("bun --version");
  expect(deriveRepositorySetup(files).installScript).not.toContain("npm ci");
});

test("no pins, ranges, floating tags, conflicts and shell input refuse derivation", () => {
  for (const files of [{}, { "package.json": '{"engines":{"bun":">=1.4.0"}}' }, { ".bun-version": "latest" },
    { ".bun-version": "1.4.0$(echo unsafe)" }, { ".bun-version": "1.4.0", Dockerfile: "FROM oven/bun:1.3.3" },
    { "bun.lock": "" }, { "package-lock.json": "" }, { "package.json": "invalid" }] as const) {
    expect(deriveRepositorySetup(files).reason).not.toBeNull();
  }
  expect(deriveRepositorySetup({ ".bun-version": "1.4.0", "bun.lock": "", "package-lock.json": "" }).reason).toContain("conflicting");
});

test("pinned alternate package managers use their frozen install", () => {
  for (const [manager, lock, command] of [["pnpm@10.1.0", "pnpm-lock.yaml", "pnpm install --frozen-lockfile"],
    ["yarn@1.22.22", "yarn.lock", "yarn install --frozen-lockfile"], ["yarn@4.1.0", "yarn.lock", "yarn install --immutable"]]) {
    const result = deriveRepositorySetup({ ".node-version": "22.16.0", "package.json": JSON.stringify({ packageManager: manager }), [lock!]: "" });
    expect(result.reason).toBeNull(); expect(result.installScript).toContain(command!);
  }
  expect(deriveRepositorySetup({ ".node-version": "22.16.0", "pnpm-lock.yaml": "" }).reason).toContain("pnpm");
});

test("only allowlisted pin values enter the script", () => {
  const result = deriveRepositorySetup({ ".bun-version": "1.4.0", "package.json": JSON.stringify({
    name: "private-project-name", scripts: { postinstall: "private-command" }, config: { unrelated: "private-value" },
  }) });
  for (const value of ["private-project-name", "private-command", "private-value", "/home/", "/Users/", "HOME=", "latest"]) expect(result.installScript).not.toContain(value);
});

test("snapshot reads pin files to immutable blobs at the requested ref and skip lock bodies", async () => {
  const calls: string[][] = [], sha = "a".repeat(40), blob = "b".repeat(40);
  const files = await readRepositorySetup("sample/project", "release/pinned", () => {}, async args => {
    calls.push(args);
    if (args[1]!.includes("/commits/")) return JSON.stringify({ sha });
    if (args[1]!.includes("/trees/")) return JSON.stringify({ tree: [
      { path: ".bun-version", sha: blob, mode: "100644", type: "blob", size: 5 },
      { path: "bun.lock", sha, mode: "100644", type: "blob", size: 99999999 },
      { path: "unrelated", sha, mode: "100644", type: "blob", size: 99999999 },
    ], truncated: false });
    return JSON.stringify({ encoding: "base64", content: Buffer.from("1.4.0").toString("base64") });
  });
  expect(files).toEqual({ ".bun-version": "1.4.0", "bun.lock": "" });
  expect(calls.map(call => call[1])).toEqual(["repos/sample/project/commits/release%2Fpinned", `repos/sample/project/git/trees/${sha}`, `repos/sample/project/git/blobs/${blob}`]);
});

for (const mode of ["truncated", "symlink", "large", "authority"]) test(`snapshot refuses ${mode} without reading untrusted content`, async () => {
  let calls = 0;
  const guard = () => { if (mode === "authority" && calls) throw new Error("authority changed"); };
  await expect(readRepositorySetup("sample/project", "main", guard, async () => {
    calls++;
    return JSON.stringify(calls === 1 ? { sha: "a".repeat(40) } : { truncated: mode === "truncated", tree: [
      { path: ".bun-version", sha: "b".repeat(40), mode: mode === "symlink" ? "120000" : "100644", type: "blob", size: mode === "large" ? 70000 : 5 },
    ] });
  })).rejects.toThrow();
  expect(calls).toBe(mode === "authority" ? 1 : 2);
});

for (const wrongVersion of [false, true]) test(`generated Bun setup executes with a fake distribution and ${wrongVersion ? "refuses a wrong version" : "survives a fresh HOME"}`, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cloud-setup-shell-")); roots.push(root);
  const prefix = path.join(root, "system"), bin = path.join(prefix, "bin");
  fs.mkdirSync(bin, { recursive: true }); fs.mkdirSync(path.join(root, "home")); fs.mkdirSync(path.join(root, "other-home"));
  const write = (file: string, body: string) => fs.writeFileSync(file, "#!/bin/sh\nset -eu\n" + body + "\n", { mode: 0o755 });
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  const marker = path.join(root, "installed-dependencies");
  const distribution = path.join(root, "distribution");
  write(distribution, `case "$1" in --version) printf '%s\\n' '${wrongVersion ? "1.3.3" : "1.4.0"}' ;; install) test "$2" = --frozen-lockfile; touch ${quote(marker)} ;; esac`);
  write(path.join(bin, "uname"), "echo x86_64");
  write(path.join(bin, "git"), `test "$1 $2" = 'rev-parse --show-toplevel'; printf '%s\\n' ${quote(root)}`);
  write(path.join(bin, "curl"), 'test "$2" = https://github.com/oven-sh/bun/releases/download/bun-v1.4.0/bun-linux-x64-baseline.zip; test "$3" = -o; touch "$4"');
  write(path.join(bin, "unzip"), `test "$1" = -q; test "$3" = -d; mkdir -p "$4/bun-linux-x64-baseline"; cp ${quote(distribution)} "$4/bun-linux-x64-baseline/bun"`);
  const setup = deriveRepositorySetup({ ".bun-version": "1.4.0", "bun.lock": "" });
  // Relocate the system prefix for this shell rehearsal. All other commands
  // execute unchanged; the download and archive are owned local substitutes.
  const script = path.join(root, "setup.sh");
  fs.writeFileSync(script, setup.installScript.replaceAll("/usr/local", prefix));
  const result = spawnSync("/bin/bash", [script], { cwd: root, encoding: "utf8", env: { HOME: path.join(root, "home"), PATH: "/usr/bin:/bin", TMPDIR: root } });
  expect(result.status, result.stderr).toBe(wrongVersion ? 1 : 0);
  expect(fs.existsSync(marker)).toBe(!wrongVersion);
  if (!wrongVersion) {
    const fresh = spawnSync("/usr/bin/env", ["-i", `HOME=${path.join(root, "other-home")}`, `PATH=${bin}:/usr/bin:/bin`, "bun", "--version"], { encoding: "utf8" });
    expect(fresh.status).toBe(0); expect(fresh.stdout).toBe("1.4.0\n");
  }
});
