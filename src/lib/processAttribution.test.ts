import { expect, test } from "bun:test";
import { once } from "node:events";
import { promisify } from "node:util";
import { spawn as namedSpawn } from "node:child_process";
import childProcess from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { heapAttribution } from "./heapAttribution";
import { installProcessAttribution } from "./processAttribution";

const nativeSpawn = Bun.spawn;
const status = installProcessAttribution();

test("startup wraps Bun and Node, preserves named imports and is idempotent", () => {
  expect(status.installed.sort()).toEqual(["Bun.spawn", "Bun.spawnSync", "node.spawn", "node.execFile", "node.exec", "node.fork", "node.ChildProcess.spawn"].sort());
  const wrapped = Bun.spawn;
  expect(installProcessAttribution()).toBe(status);
  expect(Bun.spawn).toBe(wrapped);
  expect(status.installed).toContain("node.ChildProcess.spawn");
});

test("both Bun overloads record safe creation sites and exits while preserving callbacks", async () => {
  let exits = 0;
  const a = Bun.spawn([process.execPath, "-e", "process.exit(7)", "private-argument"], { stdout: "ignore", stderr: "ignore", onExit: () => { exits++; } });
  const b = Bun.spawn({ cmd: [process.execPath, "-e", "process.exit(0)"], stdout: "ignore", stderr: "ignore" });
  expect(await a.exited).toBe(7);
  await b.exited;
  await Bun.sleep(1);
  expect(exits).toBe(1);
  const snapshot = heapAttribution.snapshot();
  const row = snapshot.processes.oldest.find(row => row.pid === a.pid && row.api === "Bun.spawn");
  expect(row).toMatchObject({ command: path.basename(process.execPath), exitCode: 7 });
  expect(row!.site).toMatch(/^src\/lib\/processAttribution.test.ts:\d+:\d+$/);
  expect(row!.exitedAt).toBeGreaterThanOrEqual(row!.startedAt);
  expect(JSON.stringify(snapshot)).not.toContain("private-argument");
  const result = Bun.spawnSync([process.execPath, "-e", "process.exit(3)"], { stdout: "ignore", stderr: "ignore" });
  expect(result.exitCode).toBe(3);
  expect(heapAttribution.snapshot().processes.groups.some(row => row.api === "Bun.spawnSync" && row.exited > 0)).toBe(true);
});

test("Node spawn, execFile callback, exec, promisify and fork keep their contracts", async () => {
  const held = namedSpawn(process.execPath, ["-e", "process.exit(2)"], { stdio: "ignore" });
  expect((await once(held, "exit"))[0]).toBe(2);
  await new Promise<void>((resolve, reject) => childProcess.execFile(process.execPath, ["-e", "process.stdout.write('ok')"], (err, stdout) => {
    if (err) return reject(err);
    expect(stdout).toBe("ok"); resolve();
  }));
  const promise = promisify(childProcess.execFile)(process.execPath, ["-e", "process.stdout.write('promise')"]);
  expect(promise.child.pid).toBeGreaterThan(0);
  expect((await promise).stdout).toBe("promise");
  const shell = childProcess.exec("printf shell-private-argument");
  await once(shell, "exit");
  const fork = childProcess.fork("-e", ["process.exit(0)"], { stdio: "ignore" });
  await once(fork, "exit");
  const snapshot = heapAttribution.snapshot();
  expect(snapshot.processes.oldest.some(row => row.pid === held.pid && row.api === "node.spawn")).toBe(true);
  expect(snapshot.processes.oldest.some(row => row.pid === promise.child.pid)).toBe(true);
  expect(JSON.stringify(snapshot)).not.toContain("shell-private-argument");
  expect(status.errors).toBe(0);
});

test("an exited subprocess has the same weak lifetime as an unwrapped native control", async () => {
  async function launch(spawn: typeof Bun.spawn) {
    const child = spawn([process.execPath, "-e", "process.exit(0)"], { stdout: "ignore", stderr: "ignore" });
    await child.exited;
    return new WeakRef(child);
  }
  const ref = await launch(Bun.spawn);
  const control = await launch(nativeSpawn);
  let live = true;
  for (let round = 0; round < 40 && live; round++) {
    await Bun.sleep(5); Bun.gc(true); live = ref.deref() !== undefined;
  }
  expect(live).toBe(control.deref() !== undefined);
});


test("minified production chunks attribute distinct caller locations without source maps", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "heap-bundle-"));
  try {
    const entry = path.join(root, "entry.ts");
    const outdir = path.join(root, ".next/server/chunks");
    const observer = fileURLToPath(new URL("./processAttribution.ts", import.meta.url));
    const registry = fileURLToPath(new URL("./heapAttribution.ts", import.meta.url));
    fs.writeFileSync(entry, `
      import { installProcessAttribution } from ${JSON.stringify(observer)};
      import { heapAttribution } from ${JSON.stringify(registry)};
      import childProcess, { spawn } from "node:child_process";
      installProcessAttribution();
      function first() { return Bun.spawnSync([process.execPath, "-e", "process.exit(0)"]); }
      function second() { return Bun.spawnSync([process.execPath, "-e", "process.exit(1)"]); }
      function third() { return childProcess.spawn(process.execPath, ["-e", "process.exit(0)"]); }
      function fourth() { return childProcess.spawn(process.execPath, ["-e", "process.exit(1)"]); }
      function fifth() { return spawn(process.execPath, ["-e", "process.exit(0)"]); }
      function sixth() { return spawn(process.execPath, ["-e", "process.exit(1)"]); }
      const held = [first(), second(), third(), fourth(), fifth(), sixth()];
      console.log(JSON.stringify({ groups: heapAttribution.snapshot().processes.groups, held: held.length }));
    `);
    const built = await Bun.build({ entrypoints: [entry], outdir, naming: "fixture.js", target: "bun", minify: true, sourcemap: "none" });
    expect(built.success).toBe(true);
    const child = Bun.spawn([process.execPath, path.join(outdir, "fixture.js")], { stdout: "pipe", stderr: "pipe" });
    const output = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    const result = JSON.parse(output) as { groups: { api: string; site: string }[]; held: number };
    expect(result.held).toBe(6);
    for (const api of ["Bun.spawnSync", "node.spawn"]) {
      const sites = result.groups.filter(row => row.api === api).map(row => row.site);
      const count = api === "Bun.spawnSync" ? 2 : 4;
      expect(sites).toHaveLength(count);
      expect(new Set(sites).size).toBe(count);
      expect(sites.every(site => /^\.next\/server\/chunks\/fixture\.js:\d+:\d+$/.test(site))).toBe(true);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
