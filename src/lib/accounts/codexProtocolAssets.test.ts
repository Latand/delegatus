import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const versions = ["0.154.0", "0.159.0", "0.162.1", "0.163.0", "0.164.0", "0.165.0", "0.166.0"];
let root: string;
let bundle: string;
afterAll(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-protocol-assets-"));
  const outdir = path.join(root, "dist");
  // Use the shipping producer: a managed MCP release has dist and dependencies,
  // and carries no source checkout. The caller's cwd can be elsewhere.
  const built = Bun.spawnSync([process.execPath, "scripts/build-mcp.ts", outdir], {
    cwd: process.cwd(), env: process.env, stdout: "pipe", stderr: "pipe", timeout: 60_000,
  });
  expect(built.exitCode, built.stderr.toString()).toBe(0);
  fs.symlinkSync(path.join(process.cwd(), "node_modules"), path.join(root, "node_modules"), "junction");
  const result = await Bun.build({
    entrypoints: [path.join(import.meta.dir, "codexPinnedProtocol.ts")],
    outdir, naming: "protocol-probe.mjs", target: "node", format: "esm", external: ["zod"], metafile: true,
  });
  expect(result.success, result.logs.map(String).join("\n")).toBeTrue();
  const inputs = Object.keys(result.metafile!.inputs);
  expect(inputs.filter(file => /[/\\](?:stable|experimental)\.json$/.test(file))).toEqual([]);
  bundle = result.outputs[0]!.path;
  fs.mkdirSync(path.join(root, "unrelated-cwd"));
}, 60_000);

function probe(body: string, runtime = process.execPath) {
  const child = Bun.spawnSync([runtime, "--input-type=module", "-e", `
    import fs from "node:fs";
    const reads = [];
    const original = fs.readFileSync;
    fs.readFileSync = function(file, ...args) {
      if (String(file).includes("codex-protocol") && /(?:stable|experimental)\\.json$/.test(String(file))) reads.push(String(file));
      return original.call(this, file, ...args);
    };
    const { CodexPinnedProtocol, resolveCodexProtocol } = await import(${JSON.stringify(pathToFileURL(bundle).href)});
    const importedReads = reads.length;
    ${body}
  `], { cwd: path.join(root, "unrelated-cwd"), env: process.env, stdout: "pipe", stderr: "pipe", timeout: 10_000 });
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  return JSON.parse(child.stdout.toString());
}

test.each(versions)("relocated artifacts validate %s lazily under Bun and Node", version => {
  const source = path.join(import.meta.dir, "protocol", version);
  const shipped = path.join(root, "dist/codex-protocol", version);
  for (const name of ["manifest", "stable", "experimental"]) {
    expect(fs.readFileSync(path.join(shipped, `${name}.json`))).toEqual(fs.readFileSync(path.join(source, `${name}.json`)));
  }
  for (const runtime of [process.execPath, "node"]) {
    const result = probe(`
      const protocol = new CodexPinnedProtocol(${JSON.stringify(version)});
      const constructedReads = reads.length;
      for (let pass = 0; pass < 2; pass++) {
        protocol.assertRequest("turn/interrupt", { threadId: "thread", turnId: "turn" });
        protocol.assertRequest("turn/interrupt", { threadId: "thread", turnId: "turn" }, false);
      }
      let refused = false;
      try { protocol.assertRequest("turn/interrupt", { threadId: "thread", turnId: 42 }); } catch { refused = true; }
      console.log(JSON.stringify({ importedReads, constructedReads, reads, refused }));
    `, runtime);
    expect(result.importedReads).toBe(0);
    expect(result.constructedReads).toBe(0);
    expect(result.reads).toEqual([path.join(shipped, "experimental.json"), path.join(shipped, "stable.json")]);
    expect(result.refused).toBeTrue();
  }
});

test.each(["stable", "experimental"] as const)("selected %s artifacts refuse faults and recover when restored", name => {
  const file = path.join(root, `dist/codex-protocol/0.166.0/${name}.json`);
  const original = fs.readFileSync(file);
  const backup = path.join(root, "original.json");
  fs.writeFileSync(backup, original);
  for (const fault of ["missing", "corrupt"]) {
    try {
      if (fault === "missing") fs.unlinkSync(file);
      else fs.writeFileSync(file, "{}");
      const result = probe(`
        const protocol = new CodexPinnedProtocol("0.166.0");
        let error;
        try { protocol.assertRequest("turn/interrupt", { threadId: "thread", turnId: "turn" }, ${name === "experimental"}); }
        catch (cause) { error = cause.message; }
        const older = new CodexPinnedProtocol("0.165.0");
        older.assertRequest("turn/interrupt", { threadId: "thread", turnId: "turn" });
        const generated = {
          stable: fs.readFileSync(${JSON.stringify(name === "stable" ? backup : path.join(root, "dist/codex-protocol/0.166.0/stable.json"))}, "utf8"),
          experimental: fs.readFileSync(${JSON.stringify(name === "experimental" ? backup : path.join(root, "dist/codex-protocol/0.166.0/experimental.json"))}, "utf8"),
        };
        let calls = 0, admissionError;
        const generate = async () => { calls++; return generated; };
        try { await resolveCodexProtocol("0.166.1", "unused", process.env, generate); }
        catch (cause) { admissionError = cause.message; }
        fs.copyFileSync(${JSON.stringify(backup)}, ${JSON.stringify(file)});
        protocol.assertRequest("turn/interrupt", { threadId: "thread", turnId: "turn" }, ${name === "experimental"});
        const admitted = await resolveCodexProtocol("0.166.1", "unused", process.env, generate);
        admitted.assertRequest("turn/interrupt", { threadId: "thread", turnId: "turn" });
        console.log(JSON.stringify({ error, admissionError, calls, older: older.version, recovered: admitted.cliVersion }));
      `);
      expect(result.error).toBe(`Codex app-server protocol error: CLI 0.166.0 pinned ${name} schema ${fault === "missing" ? "is unavailable" : "digest mismatch"}`);
      expect(result.older).toBe("0.165.0");
      expect(result.admissionError).toBe(result.error);
      expect(result.calls).toBe(2);
      expect(result.recovered).toBe("0.166.1");
    } finally { fs.writeFileSync(file, original); }
    expect(probe(`
      new CodexPinnedProtocol("0.166.0").assertRequest("turn/interrupt", { threadId: "thread", turnId: "turn" }, ${name === "experimental"});
      console.log(JSON.stringify({ ok: true }));
    `)).toEqual({ ok: true });
  }
});
