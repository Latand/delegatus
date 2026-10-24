import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { OWNERSHIP_PRELOAD, ownershipSandbox } from "@/lib/state/fixtures/ownershipSandbox";
import { ownFixtureChild, reapFixtureChildren } from "./ownedFixtureChildren";

afterAll(reapFixtureChildren);

function fixture() {
  const sandbox = ownershipSandbox();
  const directory = path.join(sandbox.home, ".config", "delegatus", "state");
  const filename = path.join(directory, "mcp-receipts.sqlite");
  fs.mkdirSync(directory, { recursive: true });
  const env: Record<string, string> = { ...sandbox.environment(), LLV_STATE_DIR: directory };
  for (const key of ["CODEX_HOME", "LLV_CODEX_HOME", "CLAUDE_CONFIG_DIR", "LLV_CLAUDE_HOME", "GH_CONFIG_DIR"]) {
    env[key] = path.join(sandbox.home, "providers", key);
    fs.mkdirSync(env[key]!, { recursive: true });
  }
  return { sandbox, directory, filename, env };
}
type Fixture = ReturnType<typeof fixture>;

async function run(f: Fixture, owner: string, code: string) {
  const child = ownFixtureChild(Bun.spawn([process.execPath, "--preload", OWNERSHIP_PRELOAD, "--eval", code], {
    cwd: process.cwd(), env: { ...f.env, LLV_STATE_OWNER: owner }, stdout: "pipe", stderr: "pipe",
  }));
  const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(status, stderr).toBe(0);
  expect(stderr).not.toMatch(/Unhandled Rejection|StateStartupMutationRefused/);
  return stdout;
}

const viewerStartup = `
  const { initializeHotStateStoresAtStartup } = await import('./src/lib/viewerInstrumentation');
  await initializeHotStateStoresAtStartup();
  const { ensureLegacyCollectionsImported } = await import('./src/lib/state/legacyCollections');
  await ensureLegacyCollectionsImported();
  const { agentRegistry } = await import('./src/lib/agent/registry');
  await agentRegistry().prepareReadOnlySnapshot();
`;

async function stdio(f: Fixture) {
  // A real stdio protocol and receipt store. Only the tool's domain binding is
  // a fixture; it has no external effects. Opening is lazy, as in the worker.
  const code = `
    const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
    const { statePath } = await import('./src/lib/configDir');
    const { createViewerMcpServer, createMcpToolService, openAsyncMcpReceiptStore, taskExecutorFailure } = await import('./src/lib/mcp/server');
    const server = createViewerMcpServer({ async callTool(name, args, context) {
      let store;
      try {
        store = await openAsyncMcpReceiptStore(statePath('mcp-receipts.sqlite'));
        return await createMcpToolService({ list_tasks: async () => ({ tasks: [] }) }, store).callTool(name, args, context);
      } catch (error) { return taskExecutorFailure(name, args, error); }
      finally { store?.close(); }
    } });
    await server.connect(new StdioServerTransport());
  `;
  const transport = new StdioClientTransport({ command: process.execPath,
    args: ["--preload", OWNERSHIP_PRELOAD, "--eval", code], cwd: process.cwd(),
    env: { ...f.env, LLV_STATE_OWNER: "mcp" }, stderr: "pipe" });
  let stderr = "";
  transport.stderr?.on("data", chunk => { stderr += String(chunk); });
  const client = new Client({ name: "receipts-startup-fixture", version: "1" });
  try {
    await client.connect(transport);
    return await client.callTool({ name: "list_tasks", arguments: { clientRequestId: "receipt-fixture-read" } });
  } finally {
    await client.close();
    await transport.close();
    expect(stderr).not.toMatch(/Unhandled Rejection|StateStartupMutationRefused/);
  }
}

function schema(filename: string) {
  const db = new Database(filename, { readonly: true });
  try {
    return db.query<{ name: string }, []>("SELECT name FROM sqlite_master ORDER BY name").all().map(row => row.name);
  } finally { db.close(); }
}

test("an MCP first call before Viewer startup refuses cleanly and creates no receipts file, across restarts", async () => {
  const f = fixture();
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const reply = await stdio(f);
      expect(reply.isError).toBe(true);
      expect(fs.existsSync(f.filename), `first call left ${fs.existsSync(f.filename) ? fs.statSync(f.filename).size : 0} bytes`).toBe(false);
      expect(reply.structuredContent).toMatchObject({ code: "receipts_not_ready", retryable: true });
      expect(JSON.stringify(reply)).toContain("Viewer");
      expect(fs.existsSync(f.filename)).toBe(false);
      expect(fs.readdirSync(f.directory)).toEqual([]);
    }
    await run(f, "viewer", viewerStartup);
    expect((await stdio(f)).isError).not.toBe(true);
  } finally { f.sandbox.release(); }
}, 60_000);

test("opening prepared receipts as MCP performs no startup import or file permission repair", async () => {
  const f = fixture();
  try {
    await run(f, "viewer", viewerStartup);
    const legacy = path.join(f.directory, "mcp-receipts.json");
    fs.writeFileSync(legacy, "{");
    fs.chmodSync(f.filename, 0o640);
    const before = fs.readFileSync(f.filename);
    await run(f, "mcp", `
      const { openAsyncMcpReceiptStore } = await import('./src/lib/mcp/server');
      const store = await openAsyncMcpReceiptStore(process.env.LLV_STATE_DIR + '/mcp-receipts.sqlite', {
        legacyFilePath: process.env.LLV_STATE_DIR + '/mcp-receipts.json'
      });
      store.close();
    `);
    expect(fs.readFileSync(f.filename).equals(before)).toBe(true);
    if (process.platform !== "win32") expect(fs.statSync(f.filename).mode & 0o777).toBe(0o640);
    expect(fs.readFileSync(legacy, "utf8")).toBe("{");
  } finally { f.sandbox.release(); }
}, 60_000);

test.each(["tool", "http"])("the real %s worker answers a cold receipts refusal and recovers in the same process", async transport => {
  const f = fixture();
  const child = ownFixtureChild(Bun.spawn([process.execPath, "--preload", OWNERSHIP_PRELOAD, "src/lib/mcpTask.worker.ts"], {
    env: { ...f.env, LLV_STATE_OWNER: "mcp" }, stdin: "pipe", stdout: "pipe", stderr: "pipe",
  }));
  const logs = new Response(child.stderr).text();
  const reader = child.stdout.getReader();
  let buffer = "";
  const read = async (id: number): Promise<Record<string, unknown>> => {
    for (;;) {
      const end = buffer.indexOf("\n");
      if (end >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        const tab = line.indexOf("\t");
        const frame = JSON.parse(tab < 0 ? line : line.slice(0, tab));
        if (frame.id === id) return { ...frame, ...(tab < 0 ? {} : { body: JSON.parse(line.slice(tab + 1)) }) };
        continue;
      }
      const next = await reader.read();
      if (next.done) throw new Error(`worker exited before reply: ${await logs}`);
      buffer += new TextDecoder().decode(next.value);
    }
  };
  const call = (id: number) => {
    const request = transport === "tool" ? { name: "list_tasks", args: {} } : { name: "httpTaskCall", args: {
      toolName: "list_tasks", url: "http://127.0.0.1/api/mcp",
      headers: [["content-type", "application/json"], ["accept", "application/json, text/event-stream"], ["mcp-protocol-version", "2025-03-26"]],
      body: { jsonrpc: "2.0", id, method: "tools/call", params: { name: "list_tasks", arguments: {} } },
    } };
    child.stdin.write(JSON.stringify({ id, ...request, caller: {}, deadlineAt: Date.now() + 30_000 }) + "\n");
    return read(id);
  };
  try {
    await read(0);
    const refusal = await call(1);
    if (transport === "tool") expect(refusal.result).toMatchObject({ code: "receipts_not_ready", retryable: true });
    else {
      expect(refusal.http).toMatchObject({ status: 200 });
      expect(refusal.body).toMatchObject({ result: { isError: true, structuredContent: { code: "receipts_not_ready", retryable: true } } });
      expect(JSON.stringify(refusal.body)).toContain("Start or restart the Viewer");
    }
    expect(fs.existsSync(f.filename)).toBe(false);
    await run(f, "viewer", viewerStartup);
    const recovered = await call(2);
    if (transport === "tool") expect(recovered.result).toMatchObject({ ok: true });
    else {
      expect(recovered.http).toMatchObject({ status: 200 });
      expect(recovered.body).toMatchObject({ result: { structuredContent: { ok: true } } });
      expect((recovered.body as { result: { isError?: boolean } }).result.isError).not.toBe(true);
    }
    child.stdin.end();
    expect(await child.exited).toBe(0);
    expect(await logs).not.toMatch(/Unhandled Rejection|StateStartupMutationRefused/);
  } finally {
    if (child.exitCode === null) child.kill();
    await child.exited;
    await logs;
    f.sandbox.release();
  }
}, 60_000);

test.each(["absent", "empty"])("Viewer startup prepares %s receipts before an MCP first call", async shape => {
  const f = fixture();
  try {
    if (shape === "empty") {
      // Exactly the valid, schema-less SQLite page left by the old MCP opener.
      const db = new Database(f.filename, { create: true });
      db.exec("PRAGMA user_version = 0"); db.close();
      expect(fs.statSync(f.filename).size).toBe(4096);
      const before = fs.readFileSync(f.filename);
      expect((await stdio(f)).isError).toBe(true);
      expect(fs.readFileSync(f.filename).equals(before)).toBe(true);
      expect(fs.readdirSync(f.directory)).toEqual(["mcp-receipts.sqlite"]);
    }
    await run(f, "viewer", viewerStartup);
    expect(schema(f.filename)).toEqual(expect.arrayContaining([
      "mcp_receipts", "mcp_receipt_meta", "mcp_receipts_retention_sequence",
    ]));
    expect((await stdio(f)).isError).not.toBe(true);
    expect((await stdio(f)).isError).not.toBe(true);
  } finally { f.sandbox.release(); }
}, 60_000);

test.each(["index", "column", "meta"])("MCP cannot repair a missing receipts %s; Viewer startup repairs it", async missing => {
  const f = fixture();
  try {
    await run(f, "viewer", viewerStartup);
    const db = new Database(f.filename);
    if (missing === "index") db.exec("DROP INDEX mcp_receipts_retention_sequence");
    if (missing === "column") db.exec("ALTER TABLE mcp_receipts DROP COLUMN recovery_result_json");
    if (missing === "meta") db.exec("DROP TABLE mcp_receipt_meta");
    db.close();
    const before = fs.readFileSync(f.filename);
    const reply = await stdio(f);
    expect(reply.structuredContent).toMatchObject({ code: "receipts_not_ready", retryable: true });
    expect(fs.readFileSync(f.filename).equals(before)).toBe(true);
    await run(f, "viewer", viewerStartup);
    expect((await stdio(f)).isError).not.toBe(true);
  } finally { f.sandbox.release(); }
}, 60_000);

test.each(["list_tasks", "create_task"])("production inline %s handles a receipts refusal without an unhandled rejection", async tool => {
  const f = fixture();
  try {
    const output = await run(f, "mcp", `
      const { createProductionViewerMcpService } = await import('./src/lib/mcp/server');
      const service = await createProductionViewerMcpService(false);
      const result = await service.callTool(${JSON.stringify(tool)}, { clientRequestId: 'cold-inline-call' });
      console.log(JSON.stringify(result));
    `);
    expect(JSON.parse(output)).toMatchObject({ code: "receipts_not_ready", retryable: true });
    expect(fs.existsSync(f.filename)).toBe(false);
  } finally { f.sandbox.release(); }
}, 60_000);

test("a missing file at SQLite open fails cleanly without using CREATE", async () => {
  const f = fixture();
  try {
    const output = await run(f, "mcp", `
      const fs = (await import('node:fs')).default;
      const { openAsyncMcpReceiptStore } = await import('./src/lib/mcp/server');
      const filename = process.env.LLV_STATE_DIR + '/mcp-receipts.sqlite';
      const exists = fs.existsSync;
      // Model the file disappearing after the preflight existence check.
      fs.existsSync = name => name === filename ? true : exists(name);
      try { await openAsyncMcpReceiptStore(filename); throw new Error('unexpected open'); }
      catch (error) { console.log(error.name); }
      finally { fs.existsSync = exists; }
    `);
    expect(output.trim()).toBe("McpReceiptsNotReadyError");
    expect(fs.existsSync(f.filename)).toBe(false);
  } finally { f.sandbox.release(); }
}, 60_000);

test("an MCP connection whose database is moved never recreates the absent name", async () => {
  const f = fixture();
  try {
    await run(f, "viewer", viewerStartup);
    const output = await run(f, "mcp", `
      const fs = (await import('node:fs')).default;
      const { openAsyncMcpReceiptStore } = await import('./src/lib/mcp/server');
      const filename = process.env.LLV_STATE_DIR + '/mcp-receipts.sqlite';
      const store = await openAsyncMcpReceiptStore(filename);
      try {
        // A durability fallback may leave the old inode retained at another name.
        fs.renameSync(filename, filename + '.prior');
        try { await store.lookup('list_tasks:fixture'); throw new Error('unexpected lookup'); }
        catch (error) { console.log(error.name); }
      } finally { store.close(); }
    `);
    expect(output.trim()).toBe("McpReceiptsNotReadyError");
    expect(fs.existsSync(f.filename)).toBe(false);
    expect(fs.existsSync(f.filename + ".prior")).toBe(true);
  } finally { f.sandbox.release(); }
}, 60_000);

test.each(["malformed", "directory"])("MCP preserves an unusable %s receipts path and handles the call failure", async shape => {
  const f = fixture();
  try {
    if (shape === "directory") fs.mkdirSync(f.filename);
    else fs.writeFileSync(f.filename, "invalid sqlite fixture");
    const before = shape === "malformed" ? fs.readFileSync(f.filename) : undefined;
    const output = await run(f, "mcp", `
      const { createProductionViewerMcpService } = await import('./src/lib/mcp/server');
      const service = await createProductionViewerMcpService(false);
      console.log(JSON.stringify(await service.callTool('list_tasks', {})));
    `);
    expect(JSON.parse(output)).toMatchObject({ ok: false, retryable: true });
    if (before) expect(fs.readFileSync(f.filename).equals(before)).toBe(true);
    else expect(fs.readdirSync(f.filename)).toEqual([]);
    expect(fs.readdirSync(f.directory)).toEqual(["mcp-receipts.sqlite"]);
  } finally { f.sandbox.release(); }
}, 60_000);
