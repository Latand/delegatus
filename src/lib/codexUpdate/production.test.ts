import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { productionUpdatePorts, runUpdateCommand, UpdateCommandFailure } from "./production";
import { procBackend } from "@/lib/proc";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function directory() { const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-prefix-")); roots.push(root); return root; }

test("isolated install records exact ownership, suppresses scripts and passes no account environment", async () => {
  const root = directory(), stub = path.join(root, "bun"), versions = path.join(root, "versions");
  fs.writeFileSync(stub, `#!${process.execPath}
import fs from 'node:fs'; import path from 'node:path';
const prefix = process.argv[process.argv.indexOf('--cwd') + 1];
fs.writeFileSync(path.join(prefix, 'invocation.json'), JSON.stringify({args: process.argv.slice(2), env: Object.keys(process.env)}));
`, { mode: 0o700 });
  const ports = productionUpdatePorts({ bun: stub, probeFile: "unused", scratch: path.join(root, "scratch"), versionsDirectory: versions, current: () => true, report: async () => {} });
  const target = await ports.install("0.164.0", versions), prefix = path.resolve(target, "../../../../..");
  const invocation = JSON.parse(fs.readFileSync(path.join(prefix, "invocation.json"), "utf8"));
  expect(invocation.args).toContain("--ignore-scripts"); expect(invocation.args).toContain("--cwd");
  expect(invocation.env).not.toContain("OPENAI_API_KEY"); expect(invocation.env).not.toContain("GH_TOKEN");
  expect(JSON.parse(fs.readFileSync(path.join(prefix, "package.json"), "utf8")).dependencies).toEqual({ "@openai/codex": "0.164.0" });
  const unrelated = path.join(versions, "unrecorded"); fs.mkdirSync(unrelated);
  await ports.prune!([target]); expect(fs.existsSync(prefix)).toBeTrue();
  await ports.prune!([]); expect(fs.existsSync(prefix)).toBeFalse(); expect(fs.existsSync(unrelated)).toBeTrue();
});

test("failed install cleans only its recorded prefix and reports failure", async () => {
  const root = directory(), stub = path.join(root, "bun"), versions = path.join(root, "versions");
  fs.writeFileSync(stub, `#!${process.execPath}\nprocess.exit(23);\n`, { mode: 0o700 });
  const ports = productionUpdatePorts({ bun: stub, probeFile: "unused", scratch: path.join(root, "scratch"), versionsDirectory: versions, current: () => true, report: async () => {} });
  await expect(ports.install("0.164.0", versions)).rejects.toThrow("exit 23");
  const owned = JSON.parse(fs.readFileSync(path.join(versions, "owned.json"), "utf8"));
  expect(owned).toHaveLength(1); expect(fs.existsSync(owned[0])).toBeFalse();
  await ports.prune!([]); expect(JSON.parse(fs.readFileSync(path.join(versions, "owned.json"), "utf8"))).toEqual([]);
});

test("malformed prefix ownership cannot delete a neighbouring directory", async () => {
  const root = directory(), versions = path.join(root, "versions"), other = path.join(root, "other");
  fs.mkdirSync(versions); fs.mkdirSync(other); fs.writeFileSync(path.join(versions, "owned.json"), JSON.stringify([other]));
  const ports = productionUpdatePorts({ bun: process.execPath, probeFile: "unused", scratch: path.join(root, "scratch"), versionsDirectory: versions, current: () => true, report: async () => {} });
  await expect(ports.prune!([])).rejects.toThrow("invalid owned prefix manifest"); expect(fs.existsSync(other)).toBeTrue();
});

test("probe reports the exact failed boundary", async () => {
  const root = directory(), stub = path.join(root, "codex");
  fs.writeFileSync(stub, `#!${process.execPath}\nprocess.exit(23);\n`, { mode: 0o700 });
  const ports = productionUpdatePorts({ bun: process.execPath, probeFile: path.join(root, "missing-probe.test.ts"), scratch: path.join(root, "scratch"), current: () => true, report: async () => {} });
  await expect(ports.probe("0.164.0", stub)).rejects.toMatchObject({ check: "app-server schema" });
  await expect(ports.probe("0.163.0", stub)).rejects.toMatchObject({ check: "native queue fixture" });
});

test("a failed command kills and verifies an unrefed descendant before rejecting", async () => {
  const root = directory(), pidFile = path.join(root, "descendant.pid");
  const source = `const {spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});child.unref();fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid));process.exit(23);`;
  await expect(runUpdateCommand(process.execPath, ["-e", source], { NODE_ENV: "test" }, 5_000)).rejects.toThrow("command exit 23");
  const pid = Number(fs.readFileSync(pidFile, "utf8"));
  expect(procBackend.pidAlive(pid) && !procBackend.processExited(pid)).toBeFalse();
});

test("a timed out command kills and verifies an unrefed descendant before rejecting", async () => {
  const root = directory(), pidFile = path.join(root, "timeout-descendant.pid");
  const source = `const {spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});child.unref();fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid));setInterval(()=>{},1000);`;
  await expect(runUpdateCommand(process.execPath, ["-e", source], { NODE_ENV: "test" }, 200)).rejects.toThrow("deadline or output bound");
  const pid = Number(fs.readFileSync(pidFile, "utf8"));
  expect(procBackend.pidAlive(pid) && !procBackend.processExited(pid)).toBeFalse();
});

test.skipIf(process.env.CODEX_UPDATE_NATIVE_SMOKE !== "1")("package artifacts install and probe a real CLI in a private prefix", async () => {
  const root = directory();
  const ports = productionUpdatePorts({ bun: process.execPath, probeFile: path.resolve("dist/gate/codex-probe.test.ts"), scratch: path.join(root, "scratch"), current: () => true, report: async () => {} });
  const target = await ports.install("0.163.0", path.join(root, "versions"));
  expect(await ports.version(target)).toBe("0.163.0");
  try { await ports.probe("0.163.0", target); }
  catch (error) {
    if (error instanceof Error && error.cause instanceof UpdateCommandFailure) console.error(error.cause.diagnostics);
    throw error;
  }
}, 240_000);
