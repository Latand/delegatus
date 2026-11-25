import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { statePath } from "@/lib/configDir";
import { savePipelines } from "@/lib/pipelines/store";
import { readAttemptEvidenceBinding } from "./attemptEvidenceBinding";
import { sweepMonotonicNow, withAttemptTempDeadline, ATTEMPT_TEMP_REPLY_MARGIN_MS } from "./attemptTempDeadline";
import { preserveAttemptEvidence } from "./attemptTempEvidence";
import { AttemptTempStore, sweepAttemptTemps } from "./attemptTempRetention";
import { finishedLane, nameInReport } from "./attemptTempRetention.testSupport";

const NOW = Date.parse("2026-10-22T12:00:00Z");
const tracked = "tracked media bytes\n";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_DATE: "2026-10-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-10-01T00:00:00Z" } });
}

function fixture(format = "sha1") {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "stage-evidence-")));
  roots.push(root);
  const repo = path.join(root, "repo"), directory = path.join(root, "llv-stage-fixture");
  fs.mkdirSync(repo);
  fs.mkdirSync(directory);
  git(repo, "init", "-q", "--initial-branch=main", "--object-format=" + format);
  fs.writeFileSync(path.join(repo, "asset.png"), tracked);
  fs.writeFileSync(path.join(repo, "asset.svg"), "<svg/>");
  git(repo, "add", ".");
  git(repo, "-c", "user.name=Fixture", "-c", "user.email=fixture", "commit", "-qm", "fixture media");
  const stat = fs.lstatSync(directory), identity = `${stat.dev}:${stat.ino}`;
  function put(relative: string, contents = tracked) {
    const file = path.join(directory, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
    return file;
  }
  const registered: string[] = [];
  const preserve = (repoDir: string | null = repo, pipelineId: string | null = "retention-lane") =>
    preserveAttemptEvidence(directory, directory, identity, { repoDir: repoDir ?? undefined, pipelineId, launchId: "fixture-launch",
      register: destination => { roots.push(destination); registered.push(destination); } });
  return { root, directory, repo, identity, put, preserve, registered };
}

function manifest(destination: string | undefined) {
  return JSON.parse(fs.readFileSync(path.join(destination!, "manifest.json"), "utf8")) as {
    skippedTracked: { count: number; bytes: number };
    selectionFallback?: string;
    files: { path: string; savedPath: string; hash: string }[];
  };
}

test("skips unmodified PNG and SVG in a Git archive without checkout metadata", async () => {
  const f = fixture();
  const archive = execFileSync("git", ["archive", "HEAD"], { cwd: f.repo });
  const target = path.join(f.directory, "export");
  fs.mkdirSync(target);
  execFileSync("tar", ["-x", "-C", target], { input: archive });
  expect(fs.existsSync(path.join(target, ".git"))).toBeFalse();
  f.put(".artifacts/capture.txt", "keep");
  const result = await f.preserve();
  expect(manifest(result.destination).skippedTracked).toEqual({ count: 2, bytes: tracked.length + 6 });
  expect(manifest(result.destination).files.map(file => file.path)).toEqual([path.join(".artifacts", "capture.txt")]);
});

test("skips tracked media inside a shared clone with an alternate object store", async () => {
  const f = fixture();
  const clone = path.join(f.directory, "shared-clone");
  git(f.root, "clone", "-q", "--shared", f.repo, clone);
  expect(fs.existsSync(path.join(clone, ".git", "objects", "info", "alternates"))).toBeTrue();
  const result = await f.preserve();
  expect(result.selection?.skippedTracked).toEqual({ count: 2, bytes: tracked.length + 6 });
  expect(result.destination).toBeUndefined();
});

test("keeps a tracked PNG edited in place", async () => {
  const f = fixture();
  f.put("asset.png");
  fs.appendFileSync(path.join(f.directory, "asset.png"), "edited");
  const result = await f.preserve();
  expect(manifest(result.destination).files.map(file => file.path)).toEqual(["asset.png"]);
  expect(fs.readFileSync(path.join(result.destination!, "files", "asset.png"), "utf8")).toBe(tracked + "edited");
});

test("keeps generated PNG, SVG, PDF and MP4 with their exact bytes and manifest hashes", async () => {
  const f = fixture();
  for (const extension of ["png", "svg", "pdf", "mp4"]) f.put(path.join("frames", `draft.${extension}`), `generated ${extension}`);
  const result = await f.preserve();
  const files = manifest(result.destination).files.sort((a, b) => a.path.localeCompare(b.path));
  expect(files.map(file => path.extname(file.path))).toEqual([".mp4", ".pdf", ".png", ".svg"]);
  for (const file of files) {
    const contents = fs.readFileSync(path.join(f.directory, file.path));
    expect(fs.readFileSync(path.join(result.destination!, file.savedPath))).toEqual(contents);
    expect(file.hash).toBe(createHash("sha256").update(contents).digest("hex"));
  }
});

test("matches content at a new name, including a blob from an older revision", async () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.repo, "asset.png"), "new revision");
  git(f.repo, "add", ".");
  git(f.repo, "-c", "user.name=Fixture", "-c", "user.email=fixture", "commit", "-qm", "update media");
  f.put(path.join("frames", "renamed.png"));
  const result = await f.preserve();
  expect(result.selection?.skippedTracked).toEqual({ count: 1, bytes: tracked.length });
  expect(result.destination).toBeUndefined();
});

test("keeps all explicitly declared artifacts and report-linked media even when identical to Git", async () => {
  const f = fixture();
  const artifact = path.join("nested", ".artifacts", "asset.png");
  const notes = path.join(".artifacts", "notes.txt");
  f.put(artifact); f.put(notes);
  nameInReport(f.put("report.png"));
  f.put("unnamed.png");
  const result = await f.preserve();
  expect(manifest(result.destination).files.map(file => file.path).sort()).toEqual([artifact, notes, "report.png"].sort());
  expect(manifest(result.destination).skippedTracked.count).toBe(1);
  for (const file of manifest(result.destination).files)
    expect(fs.readFileSync(path.join(result.destination!, file.savedPath), "utf8")).toBe(tracked);
});

test("copies media from an agent root even when a repository was supplied", async () => {
  const f = fixture();
  f.put("asset.png");
  const result = await f.preserve(f.repo, null);
  expect(manifest(result.destination).files.map(file => file.path)).toEqual(["asset.png"]);
  expect(manifest(result.destination).skippedTracked.count).toBe(0);
});

test.each(["no record", "missing", "non-repo", "ancestor repository", "sha256", "alternate lane repository", "inside the root"])(
  "copies media when the lane repository is %s", async condition => {
    const f = fixture(condition === "sha256" ? "sha256" : "sha1");
    let repo: string | null = f.repo;
    if (condition === "no record") repo = null;
    if (condition === "missing") repo = path.join(f.root, "missing");
    if (condition === "non-repo") repo = f.root;
    if (condition === "ancestor repository") {
      repo = path.join(f.repo, "ordinary-folder");
      fs.mkdirSync(repo);
    }
    if (condition === "alternate lane repository") {
      repo = path.join(f.root, "alternate-lane");
      git(f.root, "clone", "-q", "--shared", f.repo, repo);
    }
    if (condition === "inside the root") {
      repo = path.join(f.directory, "lane");
      git(f.root, "clone", "-q", f.repo, repo);
    }
    const files = condition === "inside the root" ? ["asset.png", path.join("lane", "asset.png"), path.join("lane", "asset.svg")] : ["asset.png"];
    f.put("asset.png");
    const result = await f.preserve(repo);
    const saved = manifest(result.destination);
    expect(saved.files.map(file => file.path).sort()).toEqual(files.sort());
    expect(saved.skippedTracked.count).toBe(0);
    expect(saved.selectionFallback).toBe(condition === "sha256" ? "object-format"
      : condition === "non-repo" ? "git-lookup"
      : condition === "alternate lane repository" ? "object-store-unverified" : "repository-unavailable");
  },
);

test("ignores an inherited Git object directory belonging to another repository", async () => {
  const f = fixture();
  const foreign = fixture();
  fs.writeFileSync(path.join(foreign.repo, "foreign.png"), "foreign-only bytes");
  git(foreign.repo, "hash-object", "-w", "foreign.png");
  f.put("frame.png", "foreign-only bytes");
  const old = process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES;
  process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES = path.join(foreign.repo, ".git", "objects");
  try {
    const result = await f.preserve();
    expect(manifest(result.destination).files.map(file => file.path)).toEqual(["frame.png"]);
  } finally {
    if (old === undefined) delete process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES;
    else process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES = old;
  }
});

function withGitFault<T>(root: string, command: string, run: () => Promise<T>) {
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  const originalPath = process.env.PATH!;
  // The stage Git wrapper delegates through PATH and would reenter this stub.
  const actual = Bun.which("git", { PATH: "/usr/bin:/bin:" + originalPath })!;
  fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh
if [ "$1" = cat-file ]; then
  ${command}
fi
exec "${actual}" "$@"
`, { mode: 0o700 });
  process.env.PATH = bin + path.delimiter + originalPath;
  return run().finally(() => { process.env.PATH = originalPath; });
}

const shellTest = process.platform === "win32" ? test.skip : test;
shellTest.each([
  ["exit 42", "git-lookup"],
  ['IFS= read -r first; printf "%s blob 20\\n" "$first"; exit 0', "git-lookup"],
  ["while :; do :; done", "git-deadline"],
])("copies all media when Git batch lookup fails (%s)", async (command, fallback) => {
  const f = fixture();
  f.put("asset.png"); f.put("distinct.svg", "<svg/>");
  const result = await withGitFault(f.root, command, () => f.preserve());
  const saved = manifest(result.destination);
  expect(saved.files.map(file => file.path).sort()).toEqual(["asset.png", "distinct.svg"]);
  expect(saved.skippedTracked.count).toBe(0);
  expect(saved.selectionFallback).toBe(fallback);
}, 15_000);

shellTest("an overall deadline during a stuck lookup keeps the root for retry", async () => {
  const f = fixture();
  f.put("asset.png");
  await withGitFault(f.root, "while :; do :; done", async () => {
    const deadline = sweepMonotonicNow() + ATTEMPT_TEMP_REPLY_MARGIN_MS + 1500;
    await expect(withAttemptTempDeadline(deadline, () => f.preserve())).rejects.toThrow("retry next tick");
  });
  expect(f.registered).toEqual([]);
  expect(fs.readFileSync(path.join(f.directory, "asset.png"), "utf8")).toBe(tracked);
}, 15_000);

test("the manifest places bounded selection metadata before its final files array", async () => {
  const f = fixture();
  f.put("asset.png"); f.put("frame.png", "new frame");
  const result = await f.preserve();
  const file = path.join(result.destination!, "manifest.json");
  expect(Object.keys(manifest(result.destination)).slice(-2)).toEqual(["skippedTracked", "files"]);
  expect(fs.readFileSync(file, "utf8").indexOf('"files"')).toBeLessThan(65536);
  expect(readAttemptEvidenceBinding(file)).toEqual({ original: f.directory, identity: f.identity,
    pipelineId: "retention-lane", launchId: "fixture-launch" });
});

test("an all-tracked pass leaves a copy written earlier intact", async () => {
  const f = fixture();
  f.put("asset.png");
  const prior = await f.preserve(null);
  const file = path.join(prior.destination!, "manifest.json"), previous = fs.readFileSync(file);
  const result = await f.preserve();
  expect(result.destination).toBeUndefined();
  expect(f.registered).toEqual([prior.destination!]);
  expect(fs.readFileSync(file)).toEqual(previous);
  expect(fs.readFileSync(path.join(prior.destination!, "files", "asset.png"), "utf8")).toBe(tracked);
});

test.each([false, true])("the sweep reports skipped files and checks them at dispatch (late edit: %s)", async edit => {
  const f = fixture();
  const file = f.put("asset.png");
  savePipelines([finishedLane(f.repo, "2026-10-22T00:00:00Z")]);
  const store = new AttemptTempStore(path.join(f.root, "roots.sqlite"));
  store.register({ directory: f.directory, pipelineId: "retention-lane", launchId: "fixture-launch",
    createdAt: NOW, retainUntilClose: false });
  let observations = 0;
  try {
    const report = await sweepAttemptTemps(store, {
      now: () => NOW, state: async () => "closed", availableBytes: () => 10 ** 12,
      scan: () => ({ ownNamespace: null, processes: [] }), references: async () => {
        if (++observations === 2 && edit) fs.appendFileSync(file, "late edit");
        return true;
      },
    });
    expect(report.removed).toBe(edit ? 0 : 1);
    expect(report.outcomes).toContainEqual(expect.objectContaining({
      directory: f.directory, disposition: edit ? "evidence" : "removed",
      reason: edit ? "evidence changed before dispatch" : "retirement completed",
    }));
    expect(report.evidenceSelections[f.directory]).toEqual({ skippedTracked: { count: 1, bytes: tracked.length } });
    expect(fs.existsSync(f.directory)).toBe(edit);
    if (edit) expect(fs.readFileSync(file, "utf8")).toBe(tracked + "late edit");
    expect(fs.existsSync(statePath("evidence", "attempt-temp", createHash("sha256")
      .update(f.directory).update("\0").update(f.identity).digest("hex")))).toBeFalse();
  } finally { store.close(); }
});
