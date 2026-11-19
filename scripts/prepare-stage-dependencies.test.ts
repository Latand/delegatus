import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { expect, test } from "bun:test";

test.each([undefined, 0, 7])("unmanaged dependency subject preserves frozen-install fallback: %s", exit => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "check-dependencies-"));
  try {
    const bin = path.join(root, "bin"), marker = path.join(root, "args"); fs.mkdirSync(bin);
    fs.writeFileSync(path.join(root, "package.json"), "{}");
    fs.writeFileSync(path.join(bin, "bun"), `#!/bin/sh\nprintf '%s\\n' "$@" > "$DEPENDENCY_ARGS"\nexit ${exit ?? 99}\n`, { mode: 0o755 });
    const result = spawnSync(process.execPath, [path.join(import.meta.dir, "prepare-stage-dependencies.ts"), ...(exit === undefined ? [] : ["--install-if-unmanaged"])], {
      cwd: root, env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, DEPENDENCY_ARGS: marker }, encoding: "utf8",
    });
    expect(result.status).toBe(exit === 7 ? 1 : 0);
    if (exit === undefined) expect(fs.existsSync(marker)).toBeFalse();
    else expect(fs.readFileSync(marker, "utf8")).toBe("install\n--frozen-lockfile\n--backend=copyfile\n");
    if (exit === 7) expect(result.stderr).toContain("dependency installation failed (7)");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("two private installs reuse artifacts while writes and chmod stay isolated", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "private-bun-installs-"));
  const packageDir = path.join(root, "archive/package");
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ name: "private-install-fixture", version: "1.0.0" }));
  fs.writeFileSync(path.join(packageDir, "payload.txt"), "original package bytes\n");
  fs.chmodSync(path.join(packageDir, "payload.txt"), 0o644);
  const archive = path.join(root, "package.tgz");
  expect(spawnSync("tar", ["-czf", archive, "-C", path.dirname(packageDir), "package"]).status).toBe(0);
  const tarball = fs.readFileSync(archive);
  let requests = 0;
  const registry = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    requests++;
    if (new URL(request.url).pathname.endsWith(".tgz")) return new Response(tarball);
    return Response.json({ name: "private-install-fixture", "dist-tags": { latest: "1.0.0" }, versions: {
      "1.0.0": { name: "private-install-fixture", version: "1.0.0", dist: { tarball: new URL("/package.tgz", request.url).href } },
    } });
  } });
  try {
    const cache = path.join(root, "artifacts");
    const subjects = ["first", "second"].map(name => path.join(root, name));
    const run = async (cwd: string, command: string[]) => {
      const child = Bun.spawn([process.execPath, ...command], { cwd, env: {
        ...process.env, HOME: path.join(cwd, "home"), XDG_CONFIG_HOME: path.join(cwd, "config"),
        BUN_INSTALL_CACHE_DIR: cache, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`,
      }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const [out, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect({ out, error, code }).toMatchObject({ code: 0 });
    };
    for (const subject of subjects) {
      fs.mkdirSync(subject);
      fs.writeFileSync(path.join(subject, "package.json"), JSON.stringify({ dependencies: { "private-install-fixture": "1.0.0" } }));
      fs.writeFileSync(path.join(subject, "bunfig.toml"), `[install]\nregistry = "${registry.url}"\n`);
    }
    await run(subjects[0]!, ["install", "--lockfile-only", "--ignore-scripts"]);
    fs.copyFileSync(path.join(subjects[0]!, "bun.lock"), path.join(subjects[1]!, "bun.lock"));
    const helper = [path.join(import.meta.dir, "prepare-stage-dependencies.ts"), "--install-if-unmanaged"];
    await run(subjects[0]!, helper);
    const firstRequests = requests;
    await run(subjects[1]!, helper);
    expect(requests).toBe(firstRequests);
    const payloads = subjects.map(subject => path.join(subject, "node_modules/private-install-fixture/payload.txt"));
    const findPayloads = (directory: string): string[] => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
      const file = path.join(directory, entry.name);
      return entry.isDirectory() ? findPayloads(file) : entry.name === "payload.txt" ? [file] : [];
    });
    const cached = findPayloads(cache);
    expect(cached.length).toBeGreaterThan(0);
    const untouched = [payloads[1]!, ...cached].map(file => ({ file, stat: fs.statSync(file), bytes: fs.readFileSync(file) }));
    const first = fs.statSync(payloads[0]!);
    for (const other of untouched) expect(`${first.dev}:${first.ino}`).not.toBe(`${other.stat.dev}:${other.stat.ino}`);
    fs.writeFileSync(payloads[0]!, "private edit\n");
    fs.chmodSync(payloads[0]!, 0o600);
    for (const other of untouched) {
      expect(fs.readFileSync(other.file)).toEqual(other.bytes);
      expect(fs.statSync(other.file).mode).toBe(other.stat.mode);
    }
  } finally {
    await registry.stop(true);
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
