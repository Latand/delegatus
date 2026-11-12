import { expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { createViewerMcpServer } from "@/lib/mcp/server";
import { bindGateCheckRoot, gateCheckTool, runGateCheckTool } from "./gateCheckTool";
import * as gateWait from "./gateWait";
import { cpuOwnerIdentity } from "./signalSandboxContext";
import { custodyClock, physical } from "../recordedChecks/wire";

// wait_for_check is a native Codex tool. Register that same tool service on
// the real Viewer MCP server for an SDK/HTTP boundary test; no new public tool.
test("SDK client waits on scratch, attempt-temp and distinct TMPDIR logs while foreign roots stay unread", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-mcp-"));
  let http: ReturnType<typeof Bun.serve> | undefined;
  const client = new Client({ name: "gate-check-fixture", version: "1" });
  const servers: Array<ReturnType<typeof createViewerMcpServer>> = [];
  const transports: WebStandardStreamableHTTPServerTransport[] = [];
  const wait = spyOn(gateWait, "waitForGateCompletion");
  try {
    // Reproduce state/scratch versus cache/attempt-temp and a separately
    // assigned system-temp TMPDIR without reading any real installation.
    const scratch = path.join(root, "state/scratch/llv-stage-owned");
    const attempt = path.join(root, "cache/attempt-temp/llv-stage-owned");
    const tmp = path.join(root, "system-temp/llv-stage-owned/tmp");
    const other = path.join(root, "state/scratch/llv-stage-other");
    for (const directory of [scratch, attempt, tmp, other]) fs.mkdirSync(directory, { recursive: true });
    const alias = path.join(root, "attempt-alias"); fs.symlinkSync(attempt, alias, "dir");
    const binding = bindGateCheckRoot(tmp, [scratch, alias]);
    const recorder = cpuOwnerIdentity(process.pid);
    const record = (directory: string) => {
      const log = path.join(directory, "check.log"), ticket = `${log}.gate`;
      fs.mkdirSync(ticket); fs.writeFileSync(log, "recorded check completed\n");
      fs.writeFileSync(path.join(ticket, "owner.json"), JSON.stringify(recorder));
      fs.writeFileSync(path.join(ticket, "completion.json"), JSON.stringify({ recorder,
        directoryIdentity: physical(ticket), deadlineUptimeMs: custodyClock() + 60_000 }));
      fs.writeFileSync(path.join(ticket, "exit"), "37\n");
      return log;
    };
    const logs = [tmp, scratch, attempt, other].map(record);
    let calls = 0;
    http = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const server = createViewerMcpServer({ async callTool() { throw new Error("unexpected Viewer tool"); } }, []);
      servers.push(server);
      server.registerTool(gateCheckTool.name, { description: gateCheckTool.description,
        inputSchema: z.object({ log: z.string(), reason: z.string() }).strict() }, async (args, extra) => {
        calls++;
        const result = await runGateCheckTool(args, binding, extra.signal);
        return { isError: !result.success, content: result.contentItems.map(item => ({ type: "text" as const, text: item.text })) };
      });
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      transports.push(transport);
      await server.connect(transport);
      return transport.handleRequest(request);
    } });
    await client.connect(new StreamableHTTPClientTransport(new URL(http.url)));
    const catalog = await client.listTools();
    expect(catalog.tools.map(tool => tool.name)).toEqual([gateCheckTool.name]);
    expect(catalog.tools[0].inputSchema.required).toEqual(["log", "reason"]);
    const malformed = await client.callTool({ name: gateCheckTool.name, arguments: { log: logs[0] } });
    expect(malformed.isError).toBe(true);
    expect(calls).toBe(0);
    expect(wait).not.toHaveBeenCalled();
    const call = (log: string) => client.callTool({ name: gateCheckTool.name, arguments: { log, reason: "SDK check" } });
    for (const log of [...logs.slice(0, 3), path.join(alias, "check.log")]) {
      const result = await call(log);
      expect(result.isError).toBe(false);
      const content = result.content as Array<{ text: string }>;
      expect(JSON.parse(content[0].text)).toMatchObject({ terminal: true, code: 37 });
    }
    expect(wait).toHaveBeenCalledTimes(4);
    fs.symlinkSync(other, path.join(attempt, "foreign"), "dir");
    for (const log of [logs[3], path.join(attempt, "foreign/check.log"), `${scratch}/../llv-stage-other/check.log`]) {
      const result = await call(log);
      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ text: string }>)[0].text;
      for (const directory of [tmp, scratch, alias]) expect(text).toContain(JSON.stringify(directory));
    }
    expect(wait).toHaveBeenCalledTimes(4);
    // A failure in the actual reader propagates once, with no effects.
    wait.mockImplementationOnce(async () => { throw new Error("injected gate read failure"); });
    const failed = await call(logs[0]);
    expect(failed.isError).toBe(true);
    expect((failed.content as Array<{ text: string }>)[0].text).toContain("injected gate read failure");
    expect(wait).toHaveBeenCalledTimes(5);
    expect(calls).toBe(8);
    expect((await runGateCheckTool({ log: logs[3], reason: "foreign owner control" }, bindGateCheckRoot(other), new AbortController().signal)).success).toBe(true);
    for (const log of logs) expect(fs.readFileSync(`${log}.gate/exit`, "utf8")).toBe("37\n");
  } finally {
    wait.mockRestore();
    await client.close();
    http?.stop(true);
    await Promise.all(servers.map(server => server.close()));
    await Promise.all(transports.map(transport => transport.close()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
