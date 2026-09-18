import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createCaptureDirectory } from "./capture-directory";

const REPO_ROOT = path.resolve(import.meta.dir, "..");

test("each run is fresh and the stable latest link resolves to the newest run", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-capture-directory-"));
  const parent = path.join(sandbox, "llv-issue-963-parent");
  fs.mkdirSync(parent);

  try {
    const options = {
      envName: "ATTENTION_CAPTURE_DIR",
      prefix: "llv-issue-963" as const,
      raw: parent,
      repoRoot: REPO_ROOT,
    };
    const first = createCaptureDirectory(options);
    const second = createCaptureDirectory(options);
    const latest = path.join(parent, "llv-issue-963-latest");

    expect(path.dirname(first)).toBe(fs.realpathSync(parent));
    expect(path.basename(first)).toStartWith("llv-issue-963-");
    expect(first).not.toBe(second);
    expect(fs.existsSync(first)).toBe(true);
    expect(fs.lstatSync(latest).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(latest)).toBe(second);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("a refusal names the caller's own environment variable", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-capture-variable-"));
  const wrongPrefix = path.join(sandbox, "llv-issue-963-parent");
  fs.mkdirSync(wrongPrefix);

  try {
    expect(() => createCaptureDirectory({
      envName: "ORCH_CAPTURE_DIR",
      prefix: "llv-issue-978",
      raw: wrongPrefix,
      repoRoot: REPO_ROOT,
    })).toThrow("ORCH_CAPTURE_DIR refused");
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("a non-symlink latest marker is preserved and blocks allocation", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-capture-latest-refusal-"));
  const parent = path.join(sandbox, "llv-issue-963-parent");
  const latest = path.join(parent, "llv-issue-963-latest");
  const sentinel = path.join(latest, "keep.txt");
  fs.mkdirSync(latest, { recursive: true });
  fs.writeFileSync(sentinel, "keep", "utf8");

  try {
    expect(() => createCaptureDirectory({
      envName: "ATTENTION_CAPTURE_DIR",
      prefix: "llv-issue-963",
      raw: parent,
      repoRoot: REPO_ROOT,
    })).toThrow("latest marker must be a symbolic link");
    expect(fs.readFileSync(sentinel, "utf8")).toBe("keep");
    expect(fs.readdirSync(parent)).toEqual(["llv-issue-963-latest"]);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("an override that resolves outside the temp root is refused, and what it holds survives", () => {
  const enclosing = fs.mkdtempSync(path.join(os.tmpdir(), "llv-capture-escape-"));
  const tempRoot = path.join(enclosing, "temp-root");
  // A sibling of the temp root, so only the descendant arm can refuse it: the leaf
  // carries the expected prefix, and nothing here overlaps the home or the repo.
  const outside = path.join(enclosing, "llv-issue-963-operator");
  const sentinel = path.join(outside, "keep.txt");
  fs.mkdirSync(tempRoot);
  fs.mkdirSync(outside);
  fs.writeFileSync(sentinel, "keep", "utf8");
  const priorTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = tempRoot;

  try {
    expect(() => createCaptureDirectory({
      envName: "ATTENTION_CAPTURE_DIR",
      prefix: "llv-issue-963",
      raw: outside,
      repoRoot: REPO_ROOT,
    })).toThrow(`ATTENTION_CAPTURE_DIR refused ${outside} (resolved to ${fs.realpathSync(outside)}): override must be a descendant of ${fs.realpathSync(tempRoot)}`);
    expect(fs.readFileSync(sentinel, "utf8")).toBe("keep");
    expect(fs.readdirSync(outside)).toEqual(["keep.txt"]);
  } finally {
    if (priorTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = priorTmpdir;
    fs.rmSync(enclosing, { recursive: true, force: true });
  }
});

test("with no override the run lands directly beneath the temp root", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llv-capture-default-"));
  const priorTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = tempRoot;

  try {
    const run = createCaptureDirectory({
      envName: "ATTENTION_CAPTURE_DIR",
      prefix: "llv-issue-963",
      raw: undefined,
      repoRoot: REPO_ROOT,
    });

    expect(path.dirname(run)).toBe(fs.realpathSync(tempRoot));
    expect(path.basename(run)).toStartWith("llv-issue-963-");
    expect(fs.realpathSync(path.join(tempRoot, "llv-issue-963-latest"))).toBe(run);
  } finally {
    if (priorTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = priorTmpdir;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
