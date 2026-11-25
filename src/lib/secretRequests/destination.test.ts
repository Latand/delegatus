import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createManualProject } from "@/lib/projects/curation";
import { projectForCwd } from "@/lib/scanner/describe";
import { resetProjectDirectoryCacheForTests } from "@/lib/scanner/projectDirectories";
import { resolveSecretDestination } from "./destination";
import type { SecretRefusal } from "./types";

let root: string;
let project: string;
let folder: string;
let other: string;
let state: string;
const names = ["HOME", "LLV_STATE_DIR", "XDG_CONFIG_HOME", "CODEX_HOME", "LLV_SECRET_ROOTS", "LLV_DOCKER_NSENTER_SHIMS"] as const;
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const name of names) saved.set(name, process.env[name]);
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "secret-destination-")));
  folder = path.join(root, "project");
  other = path.join(root, "other");
  state = path.join(folder, "state");
  for (const dir of [folder, other, state, "home", "other/.config", "other/tool"]) fs.mkdirSync(path.resolve(root, dir));
  Object.assign(process.env, {
    HOME: path.join(root, "home"), LLV_STATE_DIR: state, XDG_CONFIG_HOME: path.join(other, ".config"),
    CODEX_HOME: path.join(other, "tool"),
  });
  delete process.env.LLV_SECRET_ROOTS;
  delete process.env.LLV_DOCKER_NSENTER_SHIMS;
  fs.writeFileSync(path.join(state, "project-catalog.json"), JSON.stringify({
    version: 2, resolutionVersion: 4, files: { a: { cwd: folder, projectRoot: folder }, b: { cwd: other, projectRoot: other } },
  }));
  resetProjectDirectoryCacheForTests();
  project = projectForCwd(folder)!;
});

afterEach(() => {
  for (const name of names) {
    const old = saved.get(name);
    if (old === undefined) delete process.env[name];
    else process.env[name] = old;
  }
  resetProjectDirectoryCacheForTests();
  fs.rmSync(root, { recursive: true, force: true });
});

const file = (filename: string, replace = false) => resolveSecretDestination(project, { kind: "file", path: filename, replace });
const rejects = (filename: string, code: SecretRefusal, replace = false) => expect(file(filename, replace)).rejects.toMatchObject({ code });

test("uses only the selected project's paths and drops broad roots", async () => {
  await rejects("relative", "secret_destination_outside_roots");
  await rejects(folder + "/../other/entry", "secret_destination_outside_roots");
  await rejects(path.join(other, "entry"), "secret_destination_outside_roots");
  expect((await file(path.join(folder, "entry"))).destination).toMatchObject({ git: "outside-repository", effect: "file-create" });

  process.env.LLV_SECRET_ROOTS = [root, process.env.HOME, other].join(":");
  await rejects(path.join(root, "entry"), "secret_destination_outside_roots");
  await rejects("~/entry", "secret_destination_outside_roots");
  expect((await file(path.join(other, "entry"))).destination.path).toBe(path.join(other, "entry"));

  const child = path.join(process.env.HOME!, "selected");
  fs.mkdirSync(child);
  process.env.LLV_SECRET_ROOTS = child;
  expect((await file("~/selected/entry")).destination.path).toBe(path.join(child, "entry"));
});

test("a registered manual root is admitted for its own project", async () => {
  const manual = path.join(root, "manual");
  fs.mkdirSync(manual);
  const entry = createManualProject("Manual project", manual);
  expect(entry.ok).toBe(true);
  if (!entry.ok) throw new Error("fixture registration failed");
  const filename = path.join(manual, "entry");
  await rejects(filename, "secret_destination_outside_roots");
  expect((await resolveSecretDestination(entry.entry.project, { kind: "file", path: filename })).destination.path).toBe(filename);
});

test("resolves parent links inside the roots and refuses escaping or final links", async () => {
  const nested = path.join(folder, "nested");
  fs.mkdirSync(nested);
  fs.symlinkSync(nested, path.join(folder, "inside"), "dir");
  fs.symlinkSync(other, path.join(folder, "outside"), "dir");
  fs.symlinkSync(path.join(nested, "missing"), path.join(folder, "leaf"));
  await rejects(path.join(folder, "outside", "entry"), "secret_destination_link");
  await rejects(path.join(folder, "leaf"), "secret_destination_link", true);
  expect((await file(path.join(folder, "inside", "entry"))).destination.path).toBe(path.join(nested, "entry"));
});

test("vetoes private areas even beneath admitted roots and refuses unsafe names", async () => {
  process.env.LLV_SECRET_ROOTS = other;
  const fenced = path.join(folder, "fenced");
  fs.mkdirSync(fenced);
  fs.symlinkSync(fenced, path.join(state, "done-media"), "dir");
  for (const filename of [
    path.join(state, "entry"), path.join(state, "scratch", "entry"), path.join(state, "prototype-reviews", "entry"),
    path.join(other, "tool", "entry"), path.join(other, ".config", "entry"), path.join(fenced, "entry"),
  ]) await rejects(filename, "secret_destination_private");
  for (const name of [".git", ".git/config", "unsafe\rname", "unsafe\u0085name", "unsafe\u202ename", "unsafe\u2066name"]) {
    await rejects(path.join(folder, name), "secret_destination_name");
  }
  await rejects(path.join(folder, "missing", "entry"), "secret_parent_missing");
});

const put = (name: string, size = 1, mode = 0o600) => {
  const filename = path.join(folder, name);
  fs.writeFileSync(filename, Buffer.alloc(size), { mode });
  fs.chmodSync(filename, mode);
  return filename;
};

test("checks permission, type and replacement eligibility", async () => {
  const existing = put("existing");
  await rejects(existing, "secret_destination_exists");
  expect((await file(existing, true)).destination).toMatchObject({ effect: "file-replace", previous: { size: 1 } });
  await rejects(put("executable", 1, 0o700), "secret_destination_not_replaceable", true);
  await rejects(put("large", 65537), "secret_destination_not_replaceable", true);
  fs.linkSync(existing, path.join(folder, "hardlink"));
  await rejects(existing, "secret_destination_not_replaceable", true);
  fs.mkdirSync(path.join(folder, "directory"));
  await rejects(path.join(folder, "directory"), "secret_destination_not_replaceable", true);
});

test("compares file ownership with the effective user", async () => {
  const filename = put("foreign");
  const euid = process.geteuid;
  try {
    if (euid?.() === 0) fs.chownSync(filename, 65534, 65534);
    else process.geteuid = () => 0; // An unprivileged test cannot chown a fixture.
    await rejects(filename, "secret_destination_not_replaceable", true);
  } finally { process.geteuid = euid; }
});

test("checks environment names and keys and recognizes the edit effect", async () => {
  for (const name of [".env", ".env.test", "local.env"]) {
    const filename = path.join(folder, name);
    const resolve = () => resolveSecretDestination(project, { kind: "env", path: filename, key: "NAME" });
    expect((await resolve()).destination.effect).toBe("env-add");
    fs.writeFileSync(filename, "export NAME=before\n");
    expect((await resolve()).destination.effect).toBe("env-replace");
  }
  await expect(resolveSecretDestination(project, { kind: "env", path: path.join(folder, ".env."), key: "NAME" }))
    .rejects.toMatchObject({ code: "secret_env_file_name" });
  for (const key of ["1NAME", "name-hyphen", "X".repeat(65), "NAME\n"]) {
    await expect(resolveSecretDestination(project, { kind: "env", path: path.join(folder, ".env"), key }))
      .rejects.toMatchObject({ code: "secret_env_key_invalid" });
  }
});

function git(...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd: folder, stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error("fixture Git command failed");
}

test("allows only ignored untracked files inside a worktree and never runs fsmonitor", async () => {
  git("init");
  const tracked = put("tracked");
  put("Mixed");
  git("add", "--", "tracked", "Mixed");
  fs.writeFileSync(path.join(folder, ".gitignore"), "tracked\nignored\n[[]literal]\nmixed\n");
  const marker = path.join(folder, "monitor-ran");
  const monitor = path.join(folder, "monitor");
  fs.writeFileSync(monitor, "#!/bin/sh\ntouch monitor-ran\n", { mode: 0o700 });
  git("config", "core.fsmonitor", monitor);
  git("config", "core.ignorecase", "true");
  // This catalog path now names a repository project.
  resetProjectDirectoryCacheForTests();
  project = projectForCwd(folder)!;
  await rejects(tracked, "secret_destination_tracked", true);
  await rejects(path.join(folder, "mixed"), "secret_destination_tracked", true);
  await rejects(path.join(folder, "ordinary"), "secret_destination_not_ignored");
  expect((await file(path.join(folder, "ignored"))).destination.git).toBe("ignored");
  expect((await file(path.join(folder, "[literal]"))).destination.git).toBe("ignored");
  expect(fs.existsSync(marker)).toBe(false);
});
