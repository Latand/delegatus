import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("the packed standalone server starts with every worker available", async () => {
  const nodeSearchPath = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter((directory) => !path.basename(directory).startsWith("bun-node-"))
    .join(path.delimiter);
  const nodeExecutable = Bun.which("node", { PATH: nodeSearchPath });
  if (!nodeExecutable) throw new Error("the npm package smoke requires Node");
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "npm-package-smoke.mjs")], {
    cwd: path.resolve(import.meta.dir, ".."),
    env: { ...process.env, LLV_NODE_EXECUTABLE: nodeExecutable },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  expect(exitCode, `${stdout}\n${stderr}`.trim()).toBe(0);
}, 150_000);

test("all five bins of the packed package run, and the legacy names say so on stderr only", async () => {
  /* rename-delegatus.md §3.3. Packed with --ignore-scripts so this runs without
     the standalone build; the MCP server bundle is replaced by a stub that
     answers one JSON-RPC frame, because what is under test is what the
     launchers write around it. */
  const root = path.resolve(import.meta.dir, "..");
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "llv-package-bins-"));
  try {
    const packed = Bun.spawnSync({
      cmd: ["npm", "pack", "--ignore-scripts", "--silent", "--pack-destination", work],
      cwd: root,
      env: { PATH: process.env.PATH ?? "", HOME: work, npm_config_cache: path.join(work, "npm-cache") },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(packed.exitCode, packed.stderr.toString()).toBe(0);
    const tarball = fs.readdirSync(work).find((name) => name.endsWith(".tgz"))!;
    expect(tarball).toStartWith("delegatus-cli-");
    const extract = path.join(work, "extract");
    fs.mkdirSync(extract);
    expect(Bun.spawnSync({ cmd: ["tar", "-xzf", path.join(work, tarball), "-C", extract] }).exitCode).toBe(0);
    const pkg = path.join(extract, "package");
    const manifest = JSON.parse(fs.readFileSync(path.join(pkg, "package.json"), "utf8")) as { name: string; version: string; bin: Record<string, string> };
    expect(manifest.name).toBe("delegatus-cli");
    /* `bunx delegatus-cli` runs the FIRST bin of a package none of whose bins
       is named after it (observed on Bun 1.4.0), so the order is the contract. */
    expect(Object.keys(manifest.bin)).toEqual(["delegatus", "dlg", "delegatus-mcp", "agent-log-viewer", "agent-log-viewer-mcp"]);
    for (const target of Object.values(manifest.bin)) expect(fs.existsSync(path.join(pkg, target))).toBeTrue();

    fs.mkdirSync(path.join(pkg, "dist"), { recursive: true });
    fs.writeFileSync(path.join(pkg, "dist", "mcp-server.mjs"), `
      process.stdin.once("data", () => {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "viewer" } } }) + "\\n");
        process.exit(0);
      });
    `);
    const node = Bun.which("node");
    const bun = Bun.which("bun");
    if (!node || !bun) throw new Error("Node and Bun are required for the bin smoke");
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      HOME: path.join(work, "home"),
      XDG_CONFIG_HOME: path.join(work, "config"),
      LLV_STATE_DIR: path.join(work, "state"),
      LLV_BUN_EXECUTABLE: bun,
      TMPDIR: work,
    };
    const run = (bin: string, args: string[], stdin?: string) => {
      const child = Bun.spawnSync({
        cmd: [node, path.join(pkg, manifest.bin[bin]!), ...args],
        cwd: pkg,
        env,
        stdin: stdin === undefined ? "ignore" : Buffer.from(stdin),
        stdout: "pipe",
        stderr: "pipe",
      });
      return { status: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString() };
    };

    for (const bin of ["delegatus", "dlg", "agent-log-viewer"]) {
      const version = run(bin, ["--version"]);
      expect(version.status, version.stderr).toBe(0);
      expect(version.stdout.trim()).toBe(manifest.version);
      const notices = version.stderr.split("\n").filter((line) => line.includes("is now delegatus"));
      expect(notices).toHaveLength(bin === "agent-log-viewer" ? 1 : 0);
      expect(run(bin, ["--help"]).stdout).toContain("Usage: delegatus");
    }

    const initialize = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n";
    for (const bin of ["delegatus-mcp", "agent-log-viewer-mcp"]) {
      const mcp = run(bin, [], initialize);
      expect(mcp.status, mcp.stderr).toBe(0);
      /* stdout is the protocol channel: its first byte is the first frame's. */
      expect(mcp.stdout.startsWith('{"jsonrpc":"2.0","id":1,')).toBeTrue();
      expect(mcp.stdout.trim().split("\n")).toHaveLength(1);
      const notices = mcp.stderr.split("\n").filter((line) => line.includes("is now delegatus"));
      expect(notices).toHaveLength(bin === "agent-log-viewer-mcp" ? 1 : 0);
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}, 150_000);
