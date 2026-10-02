#!/usr/bin/env bun
/** Run the three executable red-path controls for the pinned Bun verifiers. */
import { spawnSync } from "node:child_process";
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const repo = path.resolve(import.meta.dir, "..");
const scratch = mkdtempSync(path.join(os.tmpdir(), "delegatus-runtime-controls-"));
const verifier = path.join(repo, "scripts/verify-viewer-runtime.ts");
const runtimeModule = "app-page.runtime.prod.js";

function run(args: string[], cwd: string, env = process.env) {
  const result = spawnSync(process.execPath, args, { cwd, env, encoding: "utf8" });
  if (result.error) throw result.error;
  return { status: result.status ?? 1, output: `${result.stdout ?? ""}\n${result.stderr ?? ""}` };
}

function copyNextRuntimeWithFailure(subject: string): void {
  const sourceNext = path.join(repo, "node_modules/next");
  const targetNext = path.join(subject, "node_modules/next");
  mkdirSync(targetNext, { recursive: true });
  for (const entry of readdirSync(sourceNext)) {
    if (entry === "dist") continue;
    const source = path.join(sourceNext, entry);
    const target = path.join(targetNext, entry);
    if (lstatSync(source).isDirectory()) symlinkSync(source, target, "dir");
    else symlinkSync(source, target);
  }

  const sourceDist = path.join(sourceNext, "dist");
  const targetDist = path.join(targetNext, "dist");
  mkdirSync(targetDist);
  for (const entry of readdirSync(sourceDist)) {
    if (entry === "compiled") continue;
    const source = path.join(sourceDist, entry);
    symlinkSync(source, path.join(targetDist, entry), lstatSync(source).isDirectory() ? "dir" : "file");
  }

  const sourceCompiled = path.join(sourceDist, "compiled");
  const targetCompiled = path.join(targetDist, "compiled");
  mkdirSync(targetCompiled);
  for (const entry of readdirSync(sourceCompiled)) {
    if (entry === "next-server") {
      const sourceServer = path.join(sourceCompiled, entry);
      const targetServer = path.join(targetCompiled, entry);
      mkdirSync(targetServer);
      for (const file of readdirSync(sourceServer)) {
        const source = path.join(sourceServer, file);
        const target = path.join(targetServer, file);
        if (file === runtimeModule) writeFileSync(target, 'throw new Error("unloadable on purpose for the local red-path control");\n');
        else symlinkSync(source, target, lstatSync(source).isDirectory() ? "dir" : "file");
      }
      continue;
    }
    const source = path.join(sourceCompiled, entry);
    symlinkSync(source, path.join(targetCompiled, entry), lstatSync(source).isDirectory() ? "dir" : "file");
  }
}

try {
  const noBuild = path.join(scratch, "no-build");
  mkdirSync(noBuild);
  const absent = run([verifier], noBuild);
  if (absent.status === 0) throw new Error("Viewer check passed with no build present");

  const subject = path.join(scratch, "unloadable-viewer");
  mkdirSync(path.join(subject, ".next/server"), { recursive: true });
  mkdirSync(path.join(subject, "scripts"), { recursive: true });
  writeFileSync(path.join(subject, "package.json"), "{}\n");
  writeFileSync(path.join(subject, ".next/server/control.js"), "module.exports = {};\n");
  copyFileSync(verifier, path.join(subject, "scripts/verify-viewer-runtime.ts"));
  copyNextRuntimeWithFailure(subject);
  const broken = run([path.join(subject, "scripts/verify-viewer-runtime.ts")], subject);
  if (broken.status === 0 || !broken.output.includes(runtimeModule)) {
    throw new Error(`Viewer check did not reject and name the unloadable ${runtimeModule}`);
  }

  const emptyHost = path.join(scratch, "no-runtime-host");
  mkdirSync(emptyHost);
  const hostRun = path.join(repo, "src/runtime-host/hostRehearsalRun.ts");
  const host = run([hostRun], repo, { ...process.env, LLV_RUNTIME_HOST_REHEARSAL_ROOT: emptyHost });
  if (host.status === 0 || !host.output.includes('"ok":false')) {
    throw new Error("runtime-host rehearsal did not report a failed verdict with no host source");
  }
  console.log("runtime negative controls passed: no build, unloadable Viewer module, and absent runtime host each produced a named failure");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
