import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { deriveRepositorySetup, generatedRepositorySetup, readRepositorySetup, type RepositorySetupFiles } from "./cloudEnvironmentSetup";

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

test("Docker distribution suffixes retain stable pins while prerelease tags refuse setup", () => {
  for (const [toolchain, dockerfile] of [
    ["Node", "FROM node:22.16.0-bookworm-slim"],
    ["Bun", "FROM oven/bun:1.4.0-slim"],
  ]) {
    const setup = deriveRepositorySetup({ Dockerfile: dockerfile });
    expect(setup.reason).toBeNull();
    expect(setup.steps).toContain(`${toolchain} ${toolchain === "Node" ? "22.16.0" : "1.4.0"} on the system PATH`);
  }
  for (const dockerfile of ["FROM node:22.16.0-rc.1", "FROM oven/bun:1.4.0-canary.1"]) {
    const setup = deriveRepositorySetup({ Dockerfile: dockerfile });
    expect(setup.reason).toContain("unsupported or ambiguous runtime image tag");
    expect(setup.installScript).not.toContain(dockerfile.includes("node:") ? "node-v22.16.0" : "bun-v1.4.0");
  }
  expect(deriveRepositorySetup({ ".node-version": "22.16.0", Dockerfile: "FROM node:22.16.0-rc.1" }).reason)
    .toContain("unsupported or ambiguous runtime image tag");
});

test("Dockerfile COPY and RUN heredoc payloads cannot declare runtimes", () => {
  const payloads = [
    "FROM ubuntu:24.04\nCOPY <<'EXAMPLE' /example.txt\nFROM node:22.16.0\nEXAMPLE",
    "FROM ubuntu:24.04\nRUN <<'EXAMPLE'\nFROM node:22.16.0\nRUN npm install -g bun@1.4.0\nEXAMPLE",
  ];
  for (const Dockerfile of payloads) {
    const setup = deriveRepositorySetup({ Dockerfile });
    expect(setup.reason).toContain("no exact");
    expect(setup.steps).toEqual([]);
    expect(setup.installScript).not.toContain("node-v22.16.0");
    expect(setup.installScript).not.toContain("bun-v1.4.0");
  }
  const declaredAfterHeredoc = deriveRepositorySetup({ Dockerfile:
    "FROM ubuntu:24.04\nCOPY <<'EXAMPLE' /example.txt\nFROM node:22.16.0\nEXAMPLE\nFROM node:22.16.0" });
  expect(declaredAfterHeredoc.reason).toBeNull();
  expect(declaredAfterHeredoc.steps).toEqual(["Node 22.16.0 on the system PATH"]);
});

test("repeated unsupported Docker runtime tags yield a bounded, deduplicated diagnosis", () => {
  const Dockerfile = Array.from({ length: 40 }, (_, index) => `FROM node:22.16.0-rc.1 AS build${index}`).join("\n");
  const setup = deriveRepositorySetup({ ".node-version": "22.16.0", Dockerfile });
  expect(setup.reason).toContain("unsupported or ambiguous runtime image tag");
  expect(setup.reason!.length).toBeLessThanOrEqual(2000);
  expect(setup.reason!.match(/unsupported or ambiguous runtime image tag/g)).toHaveLength(1);
  expect(setup.steps).toContain("Node 22.16.0 on the system PATH");
});

test("full heredoc words remove quotes before finding payload terminators", () => {
  for (const word of ["'DOC'END", '"DOC"END', "DOC'END'", "D'O'\"C\"END", "DOC\\END"]) {
    const Dockerfile = `FROM ubuntu:24.04\nCOPY <<${word} /example.txt\nDOC\nFROM node:22.16.0\nDOCEND\n`;
    const payload = deriveRepositorySetup({ Dockerfile });
    expect(payload.reason).toContain("no exact");
    expect(payload.steps).toEqual([]);
    const after = deriveRepositorySetup({ Dockerfile: Dockerfile + "FROM node:22.17.0\n" });
    expect(after.reason).toBeNull();
    expect(after.steps).toEqual(["Node 22.17.0 on the system PATH"]);
  }
});

test("quoted spaces, multiple heredocs and tab-stripped terminators keep payloads opaque", () => {
  const Dockerfile = "FROM ubuntu:24.04\nCOPY <<-'DOC END' <<NEXT'END' /examples/\n\tFROM node:22.16.0\n\tDOC END\nNEXT\nRUN npm install -g bun@1.3.3\nNEXTEND\n";
  expect(deriveRepositorySetup({ Dockerfile }).steps).toEqual([]);
  const after = deriveRepositorySetup({ Dockerfile: Dockerfile + "RUN npm install -g bun@1.4.0\n" });
  expect(after.reason).toBeNull();
  expect(after.steps).toEqual(["Bun 1.4.0 on the system PATH"]);
});

test("incomplete or ambiguous heredoc words cannot expose later payload pins", () => {
  for (const word of ["'DOC", "DOC;END", "DOC${SUFFIX}", '"DOC${SUFFIX}"']) {
    const setup = deriveRepositorySetup({ Dockerfile: `FROM ubuntu:24.04\nCOPY <<${word} /example.txt\nDOC\nFROM node:22.16.0\nDOCEND\n` });
    expect(setup.reason).toContain("no exact");
    expect(setup.steps).toEqual([]);
  }
});

const bunPins: Record<string, RepositorySetupFiles> = {
  ".bun-version": { ".bun-version": "1.4.0" },
  ".tool-versions": { ".tool-versions": "bun 1.4.0\n" },
  packageManager: { "package.json": '{"packageManager":"bun@1.4.0"}' },
  engines: { "package.json": '{"engines":{"bun":"1.4.0"}}' },
  Dockerfile: { Dockerfile: "FROM oven/bun:1.4.0-slim" },
};
for (const [source, files] of Object.entries(bunPins)) test(`an exact Bun pin from ${source} needs no guessed version`, () => {
  const setup = deriveRepositorySetup(files);
  expect(setup.reason).toBeNull(); expect(setup.steps).toEqual(["Bun 1.4.0 on the system PATH"]);
  expect(setup.installScript).not.toContain("install --frozen-lockfile");
});

const nodePins: RepositorySetupFiles[] = [
  { ".node-version": "22.16.0" }, { ".nvmrc": "v22.16.0" },
  { ".tool-versions": "nodejs 22.16.0\n" }, { "package.json": '{"engines":{"node":"22.16.0"}}' },
];
for (const files of nodePins) test(`Node-only ${Object.keys(files)[0]} derives npm ci only with a lockfile`, () => {
  const setup = deriveRepositorySetup({ ...files, "package-lock.json": "" });
  expect(setup.reason).toBeNull(); expect(setup.steps).toEqual(["Node 22.16.0 on the system PATH", "npm ci"]);
  expect(setup.installScript).not.toContain("bun --version");
  expect(deriveRepositorySetup(files).installScript).not.toContain("npm ci");
});

test("no pins, ranges, floating tags, conflicts and shell input refuse derivation", () => {
  const invalid: RepositorySetupFiles[] = [{}, { "package.json": '{"engines":{"bun":">=1.4.0"}}' }, { ".bun-version": "latest" },
    { ".bun-version": "1.4.0$(echo unsafe)" }, { ".bun-version": "1.4.0", Dockerfile: "FROM oven/bun:1.3.3" },
    { "bun.lock": "" }, { "package-lock.json": "" }, { "package.json": "invalid" }];
  for (const files of invalid) {
    expect(deriveRepositorySetup(files).reason).not.toBeNull();
  }
  expect(deriveRepositorySetup({ ".bun-version": "1.4.0", "bun.lock": "", "package-lock.json": "" }).reason).toContain("conflicting");
});

test("pinned alternate package managers use their frozen install", () => {
  for (const [manager, lock, command] of [["pnpm@10.1.0", "pnpm-lock.yaml", "pnpm install --frozen-lockfile"],
    ["yarn@1.22.22", "yarn.lock", "yarn install --frozen-lockfile"], ["yarn@4.1.0", "yarn.lock", "yarn install --immutable"]]) {
    const result = deriveRepositorySetup({ ".node-version": "22.16.0", "package.json": JSON.stringify({ packageManager: manager }), [lock!]: "" });
    expect(result.reason).toBeNull(); expect(result.installScript).toContain(command!);
    const distribution = manager === "yarn@4.1.0" ? "@yarnpkg/cli-dist@4.1.0" : manager;
    expect(result.installScript).toContain(`npm install --global --prefix /usr/local ${distribution}`);
    const withoutLock = deriveRepositorySetup({ ".node-version": "22.16.0", "package.json": JSON.stringify({ packageManager: manager }) });
    expect(withoutLock.reason).toBeNull(); expect(withoutLock.installScript).toContain(`npm install --global --prefix /usr/local ${distribution}`);
    expect(withoutLock.installScript).not.toContain(command!);
  }
  expect(deriveRepositorySetup({ ".node-version": "22.16.0", "pnpm-lock.yaml": "" }).reason).toContain("pnpm");
  expect(deriveRepositorySetup({ ".node-version": "22.16.0", "package.json": '{"packageManager":"pnpm@latest"}' }).reason).toContain("exact packageManager");
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
  const result = spawnSync("/bin/bash", [script], { cwd: root, encoding: "utf8", env: { NODE_ENV: "test", HOME: path.join(root, "home"), PATH: "/usr/bin:/bin", TMPDIR: root } });
  expect(result.status, result.stderr).toBe(wrongVersion ? 1 : 0);
  expect(fs.existsSync(marker)).toBe(!wrongVersion);
  if (!wrongVersion) {
    const fresh = spawnSync("/usr/bin/env", ["-i", `HOME=${path.join(root, "other-home")}`, `PATH=${bin}:/usr/bin:/bin`, "bun", "--version"], { encoding: "utf8" });
    expect(fresh.status).toBe(0); expect(fresh.stdout).toBe("1.4.0\n");
  }
});
