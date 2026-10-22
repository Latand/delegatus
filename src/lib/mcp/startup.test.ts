import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { handleMcpHttpRequest, setMcpHttpDependenciesForTests } from "./http";
import type { NextRequest } from "next/server";

test.each(["unknown", "malformed", "valid"])("stdio startup checks the %s launch capability against the Viewer", async (mode) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-startup-"));
  let admitted = mode === "valid";
  let probes = 0;
  setMcpHttpDependenciesForTests({
    conversationForCapability: () => admitted ? "test-conversation" : null,
    service: async () => ({ callTool: async () => { throw new Error("startup must execute no tools"); } }),
  });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    probes++;
    return handleMcpHttpRequest(request as NextRequest);
  } });
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined
    && !key.startsWith("LLV_") && !key.startsWith("DELEGATUS_"))) as Record<string, string>;
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(import.meta.dir, "entry.ts")],
    cwd: path.resolve(import.meta.dir, "../../.."), stderr: "pipe", env: { ...environment, NODE_ENV: "test", HOME: root,
      XDG_CONFIG_HOME: path.join(root, "config"), TMPDIR: root, LLV_STATE_DIR: path.join(root, "state"),
      LLV_VIEWER_CONTROL_URL: server.url.origin, LLV_SPAWN_CAPABILITY: mode === "malformed" ? "invalid" : "C".repeat(43) } });
  let stderr = "";
  transport.stderr?.on("data", chunk => { stderr += String(chunk); });
  const client = new Client({ name: "startup-test", version: "1" });
  try {
    if (mode === "valid") {
      await client.connect(transport);
      expect((await client.listTools()).tools.length).toBeGreaterThan(0);
      admitted = false;
      await expect(client.listTools()).rejects.toThrow("capability");
      expect(probes).toBe(3);
    } else {
      const error = await client.connect(transport).then(() => null, reason => reason);
      expect(String(error)).toContain("capability");
      expect(String(error)).toContain(path.join(root, "state"));
    }
    expect(stderr).not.toContain("C".repeat(43));
  } finally {
    await client.close();
    await transport.close();
    await server.stop(true);
    setMcpHttpDependenciesForTests(null);
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 15_000);
